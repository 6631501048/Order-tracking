/** ทดสอบทั้งวงจรผ่าน API จริงตั้งแต่สร้างออเดอร์ ไล่ทุกเคสต่อกันในออเดอร์เดียว */
const { pool, api, setupDb, resetDb, closeDb, restoreConfig, setConfig, createOrder, paymentEvent, sendWebhook, bot, admin, claim, botFail, runScheduler } = require('./helpers');

jest.setTimeout(30000);
beforeAll(setupDb);
beforeEach(async () => { await resetDb(); restoreConfig(); });
afterAll(closeDb);

const rowOf = async (no) => (await pool.query('SELECT * FROM orders WHERE order_no = $1', [no])).rows[0];
const timeline = async (no) => (await api().get(`/orders/${no}/timeline`)).body.data.events.map((e) => e.eventType);
const makeEligible = (no) => pool.query("UPDATE orders SET next_retry_at = now() - interval '1 second' WHERE order_no = $1", [no]);
const expireLease = (no) => pool.query("UPDATE orders SET lease_expires_at = now() - interval '1 second' WHERE order_no = $1", [no]);

test('ทางปกติ: สร้าง -> จ่ายเงิน -> bot claim -> heartbeat -> สำเร็จ (timeline ไม่มี heartbeat ปน)', async () => {
  const created = await createOrder();
  const no = created.body.data.orderNo;
  expect(created.body.data.status).toBe('PENDING_PAYMENT');

  expect((await sendWebhook(paymentEvent(await rowOf(no)))).body.data.outcome).toBe('APPLIED');
  expect((await api().get(`/orders/${no}`)).body.data.status).toBe('QUEUED');

  expect((await claim('bot-1')).body.data.orderNo).toBe(no);
  expect((await bot(api().post(`/bot/orders/${no}/heartbeat`), 'bot-1').send({})).status).toBe(200);
  expect((await bot(api().post(`/bot/orders/${no}/heartbeat`), 'bot-1').send({})).status).toBe(200);
  expect((await bot(api().post(`/bot/orders/${no}/complete`), 'bot-1').send({})).status).toBe(200);

  expect((await api().get(`/orders/${no}`)).body.data).toMatchObject({ status: 'COMPLETED', completedAt: expect.any(String) });
  expect(await timeline(no)).toEqual(['ORDER_CREATED', 'PAYMENT_CONFIRMED', 'BOT_CLAIMED', 'BOT_COMPLETED']);
  // heartbeat ยังเก็บในตารางไว้ตรวจสอบภายใน แต่ไม่โผล่ให้ลูกค้า
  expect((await pool.query("SELECT count(*)::int AS n FROM order_events WHERE event_type = 'BOT_HEARTBEAT'")).rows[0].n).toBe(2);
  expect((await api().get('/orders?tab=history')).body.data.map((o) => o.orderNo)).toEqual([no]);
  expect((await api().get('/orders?tab=current')).body.data).toEqual([]);
});

test('ทางที่มีปัญหา: bot ล่ม -> ดึงคืน -> UID ผิด -> ลูกค้าแก้ UID -> สำเร็จ', async () => {
  setConfig({ retryBaseSeconds: 30 });
  const no = (await createOrder()).body.data.orderNo;
  await sendWebhook(paymentEvent(await rowOf(no)));
  await sendWebhook(paymentEvent(await rowOf(no), {}), { signature: 'sha256=' + '0'.repeat(64) }); // webhook ปลอมถูกปฏิเสธ ไม่กระทบ

  // เคส 1: bot-1 รับงานแล้วล่ม
  await claim('bot-1');
  await expireLease(no);
  await runScheduler();
  expect((await api().get(`/orders/${no}`)).body.data.status).toBe('QUEUED');

  // เคส 4: bot-2 ลองแล้วพบว่า UID ผิด (permanent)
  await makeEligible(no);
  expect((await claim('bot-2')).body.data.attemptNo).toBe(2);
  expect((await botFail(no, 'bot-2', 'PERMANENT', 'INVALID_UID')).body.data.status).toBe('FAILED');
  const failed = (await api().get(`/orders/${no}`)).body.data;
  expect(failed).toMatchObject({ status: 'FAILED', issue: { code: 'INVALID_UID' } });
  expect((await api().get('/orders?tab=current')).body.data.map((o) => o.orderNo)).toContain(no); // ยังต้องมีคนทำอะไรต่อ

  // ลูกค้าแจ้งปัญหาและแก้ UID
  expect((await api().post(`/orders/${no}/report-issue`).send({ category: 'WRONG_UID', message: 'พิมพ์ UID ผิดค่ะ' })).status).toBe(201);
  expect((await api().patch(`/orders/${no}/uid`).send({ gameUid: '987654321' })).body.data.status).toBe('QUEUED');

  await claim('bot-3');
  expect((await bot(api().post(`/bot/orders/${no}/complete`), 'bot-3').send({})).status).toBe(200);

  expect(await timeline(no)).toEqual([
    'ORDER_CREATED', 'PAYMENT_CONFIRMED',
    'BOT_CLAIMED', 'LEASE_EXPIRED',
    'BOT_CLAIMED', 'BOT_FAILED',
    'ISSUE_REPORTED', 'UID_UPDATED',
    'BOT_CLAIMED', 'BOT_COMPLETED',
  ]);
  const row = await rowOf(no);
  expect(row).toMatchObject({ status: 'COMPLETED', game_uid: '987654321', retry_count: 0, locked_by: null });
  expect((await pool.query('SELECT status FROM fulfillment_attempts WHERE order_id = $1 ORDER BY attempt_no', [row.id])).rows.map((r) => r.status))
    .toEqual(['ABANDONED', 'FAILED', 'SUCCEEDED']);
  // จ่ายสำเร็จแค่ครั้งเดียวตลอดวงจร
  expect((await pool.query("SELECT count(*)::int AS n FROM fulfillment_attempts WHERE order_id = $1 AND status = 'SUCCEEDED'", [row.id])).rows[0].n).toBe(1);
});

test('ทางที่ไม่จบด้วยดี: ไม่มีใครจ่าย -> หมดอายุ -> จ่ายมาช้า -> แอดมินเห็น alert -> คืนเงิน', async () => {
  const no = (await createOrder()).body.data.orderNo;
  await pool.query("UPDATE orders SET payment_expires_at = now() - interval '1 minute' WHERE order_no = $1", [no]);
  await runScheduler();
  expect((await api().get(`/orders/${no}`)).body.data.status).toBe('EXPIRED');

  expect((await sendWebhook(paymentEvent(await rowOf(no)))).body.data.outcome).toBe('LATE_PAYMENT_REFUND');
  const alerts = (await admin(api().get('/admin/alerts'))).body.data;
  expect(alerts).toEqual([expect.objectContaining({ type: 'LATE_PAYMENT', orderNo: no })]);
  await admin(api().post(`/admin/alerts/${alerts[0].id}/acknowledge`)).send({});
  expect((await admin(api().get('/admin/alerts'))).body.data).toEqual([]);

  expect((await admin(api().post(`/admin/orders/${no}/refund`)).send({})).body.data.status).toBe('REFUNDED');
  expect(await timeline(no)).toEqual(['ORDER_CREATED', 'PAYMENT_EXPIRED', 'LATE_PAYMENT_RECEIVED', 'REFUND_COMPLETED']);
});

test('ทางที่ retry หมด: bot ล่มซ้ำ 4 รอบ -> DELAYED + alert -> แอดมิน requeue -> สำเร็จ', async () => {
  const no = (await createOrder()).body.data.orderNo;
  await sendWebhook(paymentEvent(await rowOf(no)));
  for (let i = 1; i <= 4; i += 1) {
    await makeEligible(no);
    await claim(`bot-${i}`);
    await expireLease(no);
    await runScheduler();
  }
  expect((await api().get(`/orders/${no}`)).body.data.status).toBe('DELAYED');
  const alerts = (await admin(api().get('/admin/alerts'))).body.data;
  expect(alerts.map((a) => a.type)).toEqual(['BOT_RETRY_EXHAUSTED']);

  expect((await admin(api().post(`/admin/orders/${no}/requeue`)).send({})).body.data.status).toBe('QUEUED');
  await claim('bot-ok');
  expect((await bot(api().post(`/bot/orders/${no}/complete`), 'bot-ok').send({})).status).toBe(200);
  expect((await api().get(`/orders/${no}`)).body.data.status).toBe('COMPLETED');
});
