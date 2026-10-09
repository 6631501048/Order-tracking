/**
 * เคส 3: webhook ธนาคารมาซ้ำ / มาช้า / ผิดลำดับ => ประมวลผลซ้ำต้องไม่เกิดผลซ้ำ
 */
const {
  pool, api, setupDb, resetDb, closeDb, config, seedOrder, getOrder, eventTypes, alertsOf, countRows,
  paymentEvent, sendWebhook, runScheduler, createOrder,
} = require('./helpers');
const { sign } = require('../../src/domain/signature');

jest.setTimeout(30000);
beforeAll(setupDb);
beforeEach(resetDb);
afterAll(closeDb);

const processed = async () => (await pool.query('SELECT event_id, outcome, order_id FROM processed_webhooks ORDER BY processed_at, event_id')).rows;

describe('จ่ายเงินสำเร็จ (กรณีปกติ)', () => {
  test('PENDING_PAYMENT => QUEUED, บันทึก paid_at/payment_ref/queued_at, timeline และ processed_webhooks', async () => {
    const o = await seedOrder('PENDING_PAYMENT');
    const evt = paymentEvent(o);
    const res = await sendWebhook(evt);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ eventId: evt.eventId, outcome: 'APPLIED' });

    const after = await getOrder(o.id);
    expect(after).toMatchObject({ status: 'QUEUED', payment_ref: evt.paymentRef, version: 1 });
    expect(after.paid_at).toBeTruthy();
    expect(after.queued_at).toBeTruthy();
    expect(await eventTypes(o.id)).toEqual(['PAYMENT_CONFIRMED']);
    expect(await alertsOf(o.id)).toEqual([]);
    expect(await processed()).toEqual([{ event_id: evt.eventId, outcome: 'APPLIED', order_id: String(o.id) }]);
    const api1 = await api().get(`/orders/${o.order_no}`);
    expect(api1.body.data).toMatchObject({ status: 'QUEUED', paidAt: expect.any(String) });
  });

  test('ออเดอร์ที่สร้างจาก API จริง จ่ายแล้วถูก bot หยิบได้', async () => {
    const created = await createOrder();
    const no = created.body.data.orderNo;
    const row = (await pool.query('SELECT * FROM orders WHERE order_no = $1', [no])).rows[0];
    await sendWebhook(paymentEvent(row));
    expect((await api().get(`/orders/${no}`)).body.data.status).toBe('QUEUED');
  });
});

describe('ตรวจลายเซ็น', () => {
  const body = (o) => paymentEvent(o);

  test.each([
    ['ไม่มี header X-Signature', { signature: null }],
    ['header ว่าง', { signature: '' }],
    ['รูปแบบผิด', { signature: 'sha256=not-hex' }],
    ['เซ็นด้วย secret อื่น', { signature: sign('wrong-secret', Buffer.from('x')) }],
  ])('%s => 401 INVALID_SIGNATURE ไม่แตะออเดอร์และไม่จด event', async (_, opts) => {
    const o = await seedOrder('PENDING_PAYMENT');
    const res = await sendWebhook(body(o), opts);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect((await getOrder(o.id)).status).toBe('PENDING_PAYMENT');
    expect(await countRows('processed_webhooks')).toBe(0);
  });

  test('เซ็นข้อมูลชุดหนึ่งแต่ส่งอีกชุด (แก้ยอดระหว่างทาง) => 401', async () => {
    const o = await seedOrder('PENDING_PAYMENT');
    const original = JSON.stringify(body(o));
    const tampered = original.replace('"amount":35', '"amount":1');
    expect(tampered).not.toBe(original);
    const res = await sendWebhook(null, { raw: tampered, signature: sign(config.webhookSecret, Buffer.from(original)) });
    expect(res.status).toBe(401);
    expect((await getOrder(o.id)).status).toBe('PENDING_PAYMENT');
  });

  test('JSON เดียวกันแต่จัดรูปแบบใหม่ (ลายเซ็นผูกกับไบต์จริง) => 401', async () => {
    const o = await seedOrder('PENDING_PAYMENT');
    const evt = body(o);
    const compact = JSON.stringify(evt);
    const res = await sendWebhook(null, { raw: JSON.stringify(evt, null, 2), signature: sign(config.webhookSecret, Buffer.from(compact)) });
    expect(res.status).toBe(401);
  });

  test('Content-Type ที่ไม่ใช่ JSON (ไม่มี raw body ให้ตรวจ) => 401', async () => {
    const o = await seedOrder('PENDING_PAYMENT');
    const raw = JSON.stringify(body(o));
    const res = await api().post('/webhooks/payment').set('Content-Type', 'text/plain')
      .set('X-Signature', sign(config.webhookSecret, Buffer.from(raw))).send(raw);
    expect(res.status).toBe(401);
  });

  test('ยังไม่ตั้ง WEBHOOK_SECRET => 503 (ไม่ยอมรับ webhook แบบไม่ตรวจลายเซ็น)', async () => {
    const saved = config.webhookSecret;
    config.webhookSecret = null;
    try {
      const o = await seedOrder('PENDING_PAYMENT');
      const res = await sendWebhook(body(o), { signature: sign('anything', Buffer.from('x')) });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('AUTH_NOT_CONFIGURED');
      expect((await getOrder(o.id)).status).toBe('PENDING_PAYMENT');
    } finally {
      config.webhookSecret = saved;
    }
  });
});

describe('webhook ซ้ำ (event id เดียวกัน)', () => {
  test('ส่งซ้ำตามลำดับ => DUPLICATE_EVENT ไม่เกิดผลซ้ำ', async () => {
    const o = await seedOrder('PENDING_PAYMENT');
    const evt = paymentEvent(o);
    expect((await sendWebhook(evt)).body.data.outcome).toBe('APPLIED');
    const again = await sendWebhook(evt);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ eventId: evt.eventId, outcome: 'DUPLICATE_EVENT', previousOutcome: 'APPLIED' });
    expect(await getOrder(o.id)).toMatchObject({ status: 'QUEUED', version: 1 });
    expect(await eventTypes(o.id)).toEqual(['PAYMENT_CONFIRMED']);
    expect(await countRows('processed_webhooks')).toBe(1);
  });

  test('ธนาคาร retry หลังออเดอร์เดินหน้าไปไกลแล้ว (เช่น COMPLETED) => ยังเป็น DUPLICATE_EVENT ไม่ถูกตีเป็นจ่ายซ้ำ', async () => {
    const o = await seedOrder('PENDING_PAYMENT');
    const evt = paymentEvent(o);
    await sendWebhook(evt);
    await pool.query("UPDATE orders SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [o.id]);
    const again = await sendWebhook(evt);
    expect(again.body.data.outcome).toBe('DUPLICATE_EVENT');
    expect(await alertsOf(o.id)).toEqual([]);
    expect((await getOrder(o.id)).status).toBe('COMPLETED');
  });

  test('ยิงพร้อมกัน 20 ครั้งด้วย event เดียว => APPLIED ครั้งเดียว ที่เหลือ DUPLICATE_EVENT ทุกตัวตอบ 200', async () => {
    const o = await seedOrder('PENDING_PAYMENT');
    const evt = paymentEvent(o);
    const results = await Promise.all(Array.from({ length: 20 }, () => sendWebhook(evt)));
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(200));
    const outcomes = results.map((r) => r.body.data.outcome);
    expect(outcomes.filter((x) => x === 'APPLIED')).toHaveLength(1);
    expect(outcomes.filter((x) => x === 'DUPLICATE_EVENT')).toHaveLength(19);
    expect(await getOrder(o.id)).toMatchObject({ status: 'QUEUED', version: 1 });
    expect(await eventTypes(o.id)).toEqual(['PAYMENT_CONFIRMED']);
    expect(await countRows('processed_webhooks')).toBe(1);
  });

  test('จ่ายเงินเดิม (paymentRef เดียวกัน) แต่ส่งมาด้วย event id ใหม่ => IGNORED_ALREADY_PAID ไม่มี alert', async () => {
    const o = await seedOrder('PENDING_PAYMENT');
    const first = paymentEvent(o);
    await sendWebhook(first);
    const res = await sendWebhook(paymentEvent(o, { paymentRef: first.paymentRef }));
    expect(res.body.data.outcome).toBe('IGNORED_ALREADY_PAID');
    expect(await alertsOf(o.id)).toEqual([]);
    expect(await eventTypes(o.id)).toEqual(['PAYMENT_CONFIRMED']);
  });
});

describe('webhook มาช้า / ผิดลำดับ => เทียบ state ก่อนเปลี่ยนสถานะ', () => {
  test('มาช้าจนออเดอร์หมดอายุแล้ว => ไม่ฟื้นออเดอร์ ตั้ง REFUND_PENDING + alert LATE_PAYMENT', async () => {
    const o = await seedOrder('EXPIRED');
    const evt = paymentEvent(o);
    const res = await sendWebhook(evt);
    expect(res.body.data.outcome).toBe('LATE_PAYMENT_REFUND');
    const after = await getOrder(o.id);
    expect(after).toMatchObject({ status: 'REFUND_PENDING', payment_ref: evt.paymentRef });
    expect(after.paid_at).toBeTruthy();
    expect(await eventTypes(o.id)).toEqual(['LATE_PAYMENT_RECEIVED']);
    expect(await alertsOf(o.id)).toEqual([{ type: 'LATE_PAYMENT', severity: 'WARNING' }]);
    // ส่งซ้ำก็ไม่เกิดผลซ้ำ
    await sendWebhook(evt);
    expect(await eventTypes(o.id)).toEqual(['LATE_PAYMENT_RECEIVED']);
    expect(await alertsOf(o.id)).toHaveLength(1);
  });

  test('วงจรเต็ม: scheduler ทำให้ออเดอร์หมดอายุก่อน แล้วเงินเพิ่งมาถึง', async () => {
    const o = await seedOrder('PENDING_PAYMENT', { payment_expires_at: new Date(Date.now() - 60_000) });
    await runScheduler();
    expect((await getOrder(o.id)).status).toBe('EXPIRED');
    const res = await sendWebhook(paymentEvent(o));
    expect(res.body.data.outcome).toBe('LATE_PAYMENT_REFUND');
    expect(await eventTypes(o.id)).toEqual(['PAYMENT_EXPIRED', 'LATE_PAYMENT_RECEIVED']);
    expect((await getOrder(o.id)).status).toBe('REFUND_PENDING');
  });

  test.each(['QUEUED', 'IN_PROGRESS', 'COMPLETED', 'DELAYED', 'FAILED', 'REFUND_PENDING', 'REFUNDED'])(
    'ออเดอร์จ่ายไปแล้ว (%s) แต่มีเงินเข้าอีกก้อน (ref ต่าง) => DUPLICATE_PAYMENT: ไม่เปลี่ยนสถานะ + alert CRITICAL',
    async (status) => {
      const extra = status === 'IN_PROGRESS' ? { locked_by: 'bot-9', lease_expires_at: new Date(Date.now() + 60_000) } : {};
      const o = await seedOrder(status, { payment_ref: 'pay-ORIGINAL', paid_at: new Date(), ...extra });
      const before = await getOrder(o.id);
      const res = await sendWebhook(paymentEvent(o, { paymentRef: 'pay-SECOND' }));
      expect(res.body.data.outcome).toBe('DUPLICATE_PAYMENT');
      const after = await getOrder(o.id);
      expect(after.status).toBe(status);
      expect(after.version).toBe(before.version);
      expect(after.payment_ref).toBe('pay-ORIGINAL');
      expect(await eventTypes(o.id)).toEqual([]);
      expect(await alertsOf(o.id)).toEqual([{ type: 'DUPLICATE_PAYMENT', severity: 'CRITICAL' }]);
    }
  );

  test('webhook แข่งกับ scheduler ที่กำลังทำให้หมดอายุ: ผลลัพธ์ต้องสอดคล้องกันเสมอ ไม่ค้าง/ไม่ซ้ำ (ทดลอง 12 รอบ)', async () => {
    const tally = { QUEUED: 0, REFUND_PENDING: 0 };
    for (let i = 0; i < 12; i += 1) {
      const o = await seedOrder('PENDING_PAYMENT', { payment_expires_at: new Date(Date.now() - 1000) });
      const [hook] = await Promise.all([sendWebhook(paymentEvent(o)), runScheduler()]);
      expect(hook.status).toBe(200);
      const after = await getOrder(o.id);
      const events = await eventTypes(o.id);
      if (after.status === 'QUEUED') {
        // webhook ชนะ: จ่ายทัน scheduler ข้ามออเดอร์นี้ไป
        expect(hook.body.data.outcome).toBe('APPLIED');
        expect(events).toEqual(['PAYMENT_CONFIRMED']);
        expect(await alertsOf(o.id)).toEqual([]);
      } else {
        // scheduler ชนะ: ออเดอร์หมดอายุก่อน เงินที่มาทีหลังจึงเป็นการจ่ายช้า
        expect(after.status).toBe('REFUND_PENDING');
        expect(hook.body.data.outcome).toBe('LATE_PAYMENT_REFUND');
        expect(events).toEqual(['PAYMENT_EXPIRED', 'LATE_PAYMENT_RECEIVED']);
      }
      tally[after.status] += 1;
    }
    expect(tally.QUEUED + tally.REFUND_PENDING).toBe(12);
  });
});

describe('กรณีผิดปกติที่ต้องไม่เปลี่ยนสถานะและต้องเตือนแอดมิน (ตอบ 200 เพื่อให้ธนาคารหยุด retry)', () => {
  test('ยอดเงินไม่ตรง => ไม่เข้าคิว + alert CRITICAL; ส่งยอดที่ถูกต้องตามมาภายหลังยังทำงานได้', async () => {
    const o = await seedOrder('PENDING_PAYMENT');
    const wrong = await sendWebhook(paymentEvent(o, { amount: 10 }));
    expect(wrong.status).toBe(200);
    expect(wrong.body.data.outcome).toBe('AMOUNT_MISMATCH');
    expect(await getOrder(o.id)).toMatchObject({ status: 'PENDING_PAYMENT', payment_ref: null, paid_at: null });
    expect(await alertsOf(o.id)).toEqual([{ type: 'PAYMENT_AMOUNT_MISMATCH', severity: 'CRITICAL' }]);
    expect((await sendWebhook(paymentEvent(o))).body.data.outcome).toBe('APPLIED');
  });

  test('สกุลเงินไม่ตรง => AMOUNT_MISMATCH', async () => {
    const o = await seedOrder('PENDING_PAYMENT');
    expect((await sendWebhook(paymentEvent(o, { currency: 'USD' }))).body.data.outcome).toBe('AMOUNT_MISMATCH');
    expect((await getOrder(o.id)).status).toBe('PENDING_PAYMENT');
  });

  test('ไม่พบออเดอร์ => UNKNOWN_ORDER + alert CRITICAL (ไม่ผูกกับออเดอร์ใด)', async () => {
    const evt = { eventId: 'evt-ghost', type: 'payment.succeeded', orderNo: 'ORD-9999999999999-999', paymentRef: 'pay-x', amount: 50, currency: 'THB' };
    const res = await sendWebhook(evt);
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('UNKNOWN_ORDER');
    const { rows } = await pool.query('SELECT type, severity, order_id FROM alerts');
    expect(rows).toEqual([{ type: 'PAYMENT_UNKNOWN_ORDER', severity: 'CRITICAL', order_id: null }]);
    expect(await processed()).toEqual([{ event_id: 'evt-ghost', outcome: 'UNKNOWN_ORDER', order_id: null }]);
  });

  test('paymentRef เดียวกันส่งมาเคลมออเดอร์อื่น => PAYMENT_REF_REUSED (ไม่ใช่ 500 จาก unique index)', async () => {
    const a = await seedOrder('PENDING_PAYMENT');
    const b = await seedOrder('PENDING_PAYMENT');
    await sendWebhook(paymentEvent(a, { paymentRef: 'pay-shared' }));
    const res = await sendWebhook(paymentEvent(b, { paymentRef: 'pay-shared' }));
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('PAYMENT_REF_REUSED');
    expect((await getOrder(b.id)).status).toBe('PENDING_PAYMENT');
    expect(await alertsOf(b.id)).toEqual([{ type: 'PAYMENT_REF_REUSED', severity: 'CRITICAL' }]);
  });

  test('type ที่ระบบไม่รู้จัก => จดไว้แล้วข้าม (200) ไม่แตะออเดอร์ ไม่ต้องมี field ของการจ่ายเงิน', async () => {
    const o = await seedOrder('PENDING_PAYMENT');
    const res = await sendWebhook({ eventId: 'evt-other', type: 'payment.refunded', orderNo: o.order_no, weird: [1, 2, 3] });
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('IGNORED_UNSUPPORTED_TYPE');
    expect((await getOrder(o.id)).status).toBe('PENDING_PAYMENT');
    expect((await sendWebhook({ eventId: 'evt-other', type: 'payment.refunded' })).body.data.outcome).toBe('DUPLICATE_EVENT');
  });
});

describe('payload ผิด / ประมวลผลพัง => ไม่จด event (ธนาคารส่งซ้ำมาทำต่อได้)', () => {
  test('payload ผิด (เซ็นถูก) => 400 VALIDATION_ERROR และไม่จด event; แก้แล้วส่ง eventId เดิมได้', async () => {
    const o = await seedOrder('PENDING_PAYMENT');
    const good = paymentEvent(o);
    const bad = { ...good }; delete bad.orderNo; bad.amount = -5;
    const res = await sendWebhook(bad);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d) => d.field).sort()).toEqual(['amount', 'orderNo']);
    expect(await countRows('processed_webhooks')).toBe(0);
    expect((await sendWebhook(good)).body.data.outcome).toBe('APPLIED');
  });

  test('JSON พัง (เซ็นถูก) => 400 INVALID_JSON', async () => {
    const raw = '{"eventId":"x",';
    const res = await sendWebhook(null, { raw });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  test('ขัดข้องระหว่างประมวลผล (DB ปฏิเสธการอัปเดต) => rollback ทั้งก้อน ไม่มี event ค้างว่า "ประมวลผลแล้ว"; ส่งซ้ำหลังแก้แล้วสำเร็จ', async () => {
    const o = await seedOrder('PENDING_PAYMENT');
    const evt = paymentEvent(o, { paymentRef: 'pay-boom' });
    await pool.query("ALTER TABLE orders ADD CONSTRAINT tmp_boom CHECK (payment_ref IS DISTINCT FROM 'pay-boom')");
    try {
      const res = await sendWebhook(evt);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(await countRows('processed_webhooks')).toBe(0);
      expect(await getOrder(o.id)).toMatchObject({ status: 'PENDING_PAYMENT', version: 0, payment_ref: null });
      expect(await eventTypes(o.id)).toEqual([]);
    } finally {
      await pool.query('ALTER TABLE orders DROP CONSTRAINT tmp_boom');
    }
    expect((await sendWebhook(evt)).body.data.outcome).toBe('APPLIED');
    expect((await getOrder(o.id)).status).toBe('QUEUED');
  });
});
