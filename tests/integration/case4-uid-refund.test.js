/**
 * เคส 4: เติมไม่สำเร็จ => แยก transient (retry) / permanent (FAILED ทันที), แก้ UID แล้วลองใหม่ หรือขอคืนเงิน
 * (transient/backoff ครอบคลุมใน case1; ที่นี่เน้น permanent + ทางออกของลูกค้า)
 */
const {
  pool, api, setupDb, resetDb, closeDb, restoreConfig, seedOrder, getOrder, eventTypes, alertsOf,
  bot, admin, claim, botFail, runScheduler,
} = require('./helpers');

jest.setTimeout(30000);
beforeAll(setupDb);
beforeEach(async () => { await resetDb(); restoreConfig(); });
afterAll(closeDb);

const fixUid = (no, gameUid) => api().patch(`/orders/${no}/uid`).send({ gameUid });
const requestRefund = (no) => api().post(`/orders/${no}/refund-request`).send({});
const attempts = async (id) => (await pool.query('SELECT status, error_type, error_code FROM fulfillment_attempts WHERE order_id = $1 ORDER BY attempt_no', [id])).rows;

/** พาออเดอร์ไป FAILED ด้วยวิธีจริง: bot รายงาน permanent error */
async function failedByBot(fields = {}) {
  const o = await seedOrder('QUEUED', fields);
  await claim('bot-1');
  const res = await botFail(o.order_no, 'bot-1', 'PERMANENT', 'INVALID_UID');
  expect(res.body.data.status).toBe('FAILED');
  return o;
}

describe('แยก transient / permanent', () => {
  test('PERMANENT (UID ผิด) => FAILED ทันที ไม่ backoff ไม่นับ retry ไม่แจ้งแอดมิน และลูกค้าเห็นสาเหตุ', async () => {
    const o = await failedByBot();
    expect(await getOrder(o.id)).toMatchObject({
      status: 'FAILED', retry_count: 0, next_retry_at: null, locked_by: null, lease_expires_at: null,
      last_error_type: 'PERMANENT', last_error_code: 'INVALID_UID',
    });
    expect(await attempts(o.id)).toEqual([{ status: 'FAILED', error_type: 'PERMANENT', error_code: 'INVALID_UID' }]);
    expect(await alertsOf(o.id)).toEqual([]);
    const view = await api().get(`/orders/${o.order_no}`);
    expect(view.body.data).toMatchObject({ status: 'FAILED', issue: { code: 'INVALID_UID' } });
    const tl = await api().get(`/orders/${o.order_no}/timeline`);
    expect(tl.body.data.events.map((e) => e.eventType)).toEqual(['BOT_CLAIMED', 'BOT_FAILED']);
    expect(tl.body.data.events[1].reason).toContain('INVALID_UID');
  });

  test('FAILED ไม่ถูก bot หยิบซ้ำเอง และ scheduler ไม่แตะ (ต้องรอลูกค้า/แอดมินตัดสินใจ)', async () => {
    const o = await failedByBot();
    const before = await getOrder(o.id);
    expect((await claim('bot-2')).body.data).toBeNull();
    await runScheduler();
    const after = await getOrder(o.id);
    expect(after).toMatchObject({ status: 'FAILED' });
    expect(after.version).toBe(before.version); // ไม่มีใครแก้อะไร
  });

  test('errorType ที่ไม่รู้จัก => 400 (กัน bot ส่งค่าเพี้ยนแล้วถูกตีเป็น permanent/transient แบบไม่ตั้งใจ)', async () => {
    const o = await seedOrder('QUEUED');
    await claim('bot-1');
    const res = await bot(api().post(`/bot/orders/${o.order_no}/fail`), 'bot-1').send({ errorType: 'MAYBE', errorCode: 'X', message: 'm' });
    expect(res.status).toBe(400);
    expect((await getOrder(o.id)).status).toBe('IN_PROGRESS');
  });
});

describe('PATCH /orders/:orderNo/uid — แก้ UID แล้วลองใหม่', () => {
  test('FAILED => QUEUED พร้อม UID ใหม่ ล้าง error/retry, bot รับงานรอบใหม่ด้วย UID ใหม่ และสำเร็จ', async () => {
    const o = await failedByBot({ retry_count: 0 });
    await pool.query('UPDATE orders SET retry_count = 2 WHERE id = $1', [o.id]); // เคยลองมาหลายรอบก่อนหน้า
    const res = await fixUid(o.order_no, 'new-uid-999');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orderNo: o.order_no, status: 'QUEUED', gameUid: 'new-uid-999' });
    expect(res.body.data.issue).toBeUndefined();

    expect(await getOrder(o.id)).toMatchObject({
      status: 'QUEUED', game_uid: 'new-uid-999', retry_count: 0, next_retry_at: null,
      last_error_type: null, last_error_code: null, last_error_message: null,
    });
    const ev = (await pool.query("SELECT actor, metadata FROM order_events WHERE event_type = 'UID_UPDATED'")).rows[0];
    expect(ev.actor).toBe('customer');
    expect(ev.metadata).toMatchObject({ previousUid: 'uid-123', newUid: 'new-uid-999', previousError: 'INVALID_UID' });

    const second = await claim('bot-2');
    expect(second.body.data).toMatchObject({ orderNo: o.order_no, gameUid: 'new-uid-999', attemptNo: 2 });
    expect((await bot(api().post(`/bot/orders/${o.order_no}/complete`), 'bot-2').send({})).status).toBe(200);
    expect((await attempts(o.id)).map((a) => a.status)).toEqual(['FAILED', 'SUCCEEDED']);
    expect(await eventTypes(o.id)).toEqual(['BOT_CLAIMED', 'BOT_FAILED', 'UID_UPDATED', 'BOT_CLAIMED', 'BOT_COMPLETED']);
  });

  test('UID เดิม => 422 UID_UNCHANGED และไม่เปลี่ยนสถานะ', async () => {
    const o = await failedByBot();
    const res = await fixUid(o.order_no, 'uid-123');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UID_UNCHANGED');
    expect((await getOrder(o.id)).status).toBe('FAILED');
  });

  test.each([
    ['PENDING_PAYMENT', {}], ['QUEUED', {}], ['IN_PROGRESS', { locked_by: 'bot-9', lease_expires_at: new Date(Date.now() + 60_000) }],
    ['COMPLETED', {}], ['DELAYED', {}], ['EXPIRED', {}], ['REFUND_PENDING', {}], ['REFUNDED', {}],
  ])('สถานะ %s => 409 UID_UPDATE_NOT_ALLOWED (แก้ UID ได้เฉพาะ FAILED)', async (status, extra) => {
    const o = await seedOrder(status, extra);
    const res = await fixUid(o.order_no, 'another-uid');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UID_UPDATE_NOT_ALLOWED');
    expect(res.body.error.details).toEqual({ status });
    expect((await getOrder(o.id)).game_uid).toBe('uid-123');
  });

  test('แก้พร้อมกัน 10 คำขอ (UID ต่างกัน) => สำเร็จเพียงอันเดียว ที่เหลือ 409 และมี event เดียว', async () => {
    const o = await failedByBot();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => fixUid(o.order_no, `racing-uid-${i}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect((await eventTypes(o.id)).filter((t) => t === 'UID_UPDATED')).toHaveLength(1);
    const winner = results.find((r) => r.status === 200).body.data.gameUid;
    expect((await getOrder(o.id)).game_uid).toBe(winner);
  });

  test.each([[{}], [{ gameUid: '' }], [{ gameUid: "1'; DROP TABLE orders;--" }], [{ gameUid: 'x'.repeat(65) }], [{ gameUid: 123 }]])(
    'body %j => 400 VALIDATION_ERROR ไม่เปลี่ยนสถานะ', async (body) => {
      const o = await failedByBot();
      const res = await api().patch(`/orders/${o.order_no}/uid`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect((await getOrder(o.id)).status).toBe('FAILED');
    }
  );

  test('เลขออเดอร์ผิดรูปแบบ => 400, ไม่พบ => 404', async () => {
    expect((await fixUid('ORD-1', 'x-uid-1')).body.error.code).toBe('INVALID_ORDER_NO');
    const res = await fixUid('ORD-9999999999999-999', 'x-uid-1');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
  });
});

describe('POST /orders/:orderNo/refund-request — ขอคืนเงิน', () => {
  test.each(['FAILED', 'DELAYED'])('จาก %s => REFUND_PENDING + alert ให้แอดมิน + timeline', async (status) => {
    const o = await seedOrder(status, { paid_at: new Date(), payment_ref: 'pay-1' });
    const res = await requestRefund(o.order_no);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('REFUND_PENDING');
    expect(await alertsOf(o.id)).toEqual([{ type: 'REFUND_REQUESTED', severity: 'WARNING' }]);
    const ev = (await pool.query("SELECT actor, metadata FROM order_events WHERE event_type = 'REFUND_REQUESTED'")).rows[0];
    expect(ev).toMatchObject({ actor: 'customer', metadata: { fromStatus: status } });
  });

  test.each(['PENDING_PAYMENT', 'QUEUED', 'COMPLETED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED'])(
    'จาก %s => 409 REFUND_NOT_ALLOWED', async (status) => {
      const o = await seedOrder(status);
      const res = await requestRefund(o.order_no);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REFUND_NOT_ALLOWED');
      expect((await getOrder(o.id)).status).toBe(status);
    }
  );

  test('ขอพร้อมกัน 6 ครั้ง => สำเร็จครั้งเดียว alert เดียว', async () => {
    const o = await failedByBot();
    const results = await Promise.all(Array.from({ length: 6 }, () => requestRefund(o.order_no)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await alertsOf(o.id)).toHaveLength(1);
  });

  test('ขอคืนเงินแล้วแก้ UID ไม่ได้ และแก้ UID แล้วขอคืนเงินไม่ได้ (เลือกทางเดียว)', async () => {
    const a = await failedByBot();
    await requestRefund(a.order_no);
    expect((await fixUid(a.order_no, 'late-uid-1')).status).toBe(409);

    const b = await seedOrder('FAILED', { game_uid: 'bad' });
    expect((await fixUid(b.order_no, 'good-uid-1')).status).toBe(200);
    expect((await requestRefund(b.order_no)).status).toBe(409);
  });

  test('แอดมินยืนยันคืนเงิน => REFUNDED (สถานะสุดท้าย, ย้ายไปแท็บ history)', async () => {
    const o = await failedByBot();
    await requestRefund(o.order_no);
    const res = await admin(api().post(`/admin/orders/${o.order_no}/refund`)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('REFUNDED');
    expect(await eventTypes(o.id)).toEqual(['BOT_CLAIMED', 'BOT_FAILED', 'REFUND_REQUESTED', 'REFUND_COMPLETED']);
    const history = await api().get('/orders?tab=history');
    expect(history.body.data.map((x) => x.orderNo)).toContain(o.order_no);
    const current = await api().get('/orders?tab=current');
    expect(current.body.data.map((x) => x.orderNo)).not.toContain(o.order_no);
    expect((await admin(api().post(`/admin/orders/${o.order_no}/refund`)).send({})).status).toBe(409);
  });
});
