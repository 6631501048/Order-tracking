/** endpoint แอดมิน: alert, requeue, ยืนยันคืนเงิน — ทางออกของ DELAYED และ REFUND_PENDING */
const {
  pool, api, setupDb, resetDb, closeDb, restoreConfig, seedOrder, getOrder, eventTypes, countRows, admin, claim, runScheduler,
} = require('./helpers');

jest.setTimeout(30000);
beforeAll(setupDb);
beforeEach(async () => { await resetDb(); restoreConfig(); });
afterAll(closeDb);

describe('การยืนยันตัวตน', () => {
  const routes = [
    ['get', '/admin/alerts'], ['post', '/admin/alerts/1/acknowledge'], ['post', '/admin/scheduler/run'],
    ['post', '/admin/orders/ORD-2587965432159-458/requeue'], ['post', '/admin/orders/ORD-2587965432159-458/refund'],
  ];
  test.each(routes)('%s %s: ไม่มี token => 401, token ผิด => 401, token ของ bot ใช้ไม่ได้', async (method, path) => {
    expect((await api()[method](path).send({})).status).toBe(401);
    expect((await api()[method](path).set('X-Admin-Token', 'nope').send({})).status).toBe(401);
    expect((await api()[method](path).set('X-Bot-Token', require('../../src/config').botToken).send({})).status).toBe(401);
  });

  test('ยังไม่ตั้ง ADMIN_TOKEN => 503 (ไม่ปล่อยให้ใช้ได้โดยไม่ยืนยันตัวตน)', async () => {
    const config = require('../../src/config');
    const saved = config.adminToken;
    config.adminToken = null;
    try {
      const res = await api().get('/admin/alerts').set('X-Admin-Token', 'anything');
      expect(res.status).toBe(503);
    } finally { config.adminToken = saved; }
  });
});

describe('alerts', () => {
  async function seedAlerts() {
    const o = await seedOrder('DELAYED');
    await pool.query(
      `INSERT INTO alerts (order_id, type, severity, message, dedupe_key, created_at) VALUES
        ($1, 'A_OLD', 'WARNING', 'old', 'k1', now() - interval '2 hour'),
        ($1, 'B_NEW', 'CRITICAL', 'new', 'k2', now() - interval '1 hour'),
        (NULL, 'C_NOORDER', 'INFO', 'no order', 'k3', now())`, [o.id]);
    return o;
  }

  test('ค่าเริ่มต้นแสดงเฉพาะที่ยังไม่รับทราบ เรียงใหม่ -> เก่า และบอกเลขออเดอร์', async () => {
    const o = await seedAlerts();
    const res = await admin(api().get('/admin/alerts'));
    expect(res.status).toBe(200);
    expect(res.body.data.map((a) => a.type)).toEqual(['C_NOORDER', 'B_NEW', 'A_OLD']);
    expect(res.body.data[1]).toMatchObject({ orderNo: o.order_no, severity: 'CRITICAL', acknowledgedAt: null });
    expect(res.body.data[0].orderNo).toBeNull();
  });

  test('acknowledge: หายจากรายการ open แต่ยังอยู่ใน all, กดซ้ำได้ (idempotent) เวลาไม่เปลี่ยน', async () => {
    await seedAlerts();
    const open = (await admin(api().get('/admin/alerts'))).body.data;
    const target = open.find((a) => a.type === 'B_NEW');
    const first = await admin(api().post(`/admin/alerts/${target.id}/acknowledge`)).send({});
    expect(first.status).toBe(200);
    expect(first.body.data.acknowledgedAt).toBeTruthy();
    const second = await admin(api().post(`/admin/alerts/${target.id}/acknowledge`)).send({});
    expect(second.body.data.acknowledgedAt).toBe(first.body.data.acknowledgedAt);

    expect((await admin(api().get('/admin/alerts'))).body.data.map((a) => a.type)).toEqual(['C_NOORDER', 'A_OLD']);
    expect((await admin(api().get('/admin/alerts?status=all'))).body.data).toHaveLength(3);
  });

  test('limit จำกัดจำนวน; พารามิเตอร์ผิด => 400; alertId ผิดรูปแบบ => 400, ไม่พบ => 404', async () => {
    await seedAlerts();
    expect((await admin(api().get('/admin/alerts?limit=2'))).body.data).toHaveLength(2);
    expect((await admin(api().get('/admin/alerts?status=closed'))).status).toBe(400);
    expect((await admin(api().get('/admin/alerts?limit=0'))).status).toBe(400);
    expect((await admin(api().post('/admin/alerts/abc/acknowledge')).send({})).body.error.code).toBe('INVALID_ALERT_ID');
    expect((await admin(api().post('/admin/alerts/999999/acknowledge')).send({})).status).toBe(404);
  });
});

describe('requeue — ทางออกของ DELAYED / FAILED', () => {
  test('DELAYED => QUEUED รีเซ็ต retry/backoff/error แล้ว bot หยิบได้ทันที (นับรอบ retry ใหม่ตั้งแต่ 0)', async () => {
    const o = await seedOrder('DELAYED', {
      retry_count: 3, last_error_type: 'TRANSIENT', last_error_code: 'BOT_LEASE_EXPIRED', last_error_message: 'x',
    });
    const res = await admin(api().post(`/admin/orders/${o.order_no}/requeue`)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('QUEUED');
    expect(res.body.data.issue).toBeUndefined();
    expect(await getOrder(o.id)).toMatchObject({ status: 'QUEUED', retry_count: 0, next_retry_at: null, last_error_code: null });
    expect(await eventTypes(o.id)).toEqual(['ADMIN_REQUEUED']);
    expect((await pool.query("SELECT actor FROM order_events WHERE order_id = $1", [o.id])).rows[0].actor).toBe('admin');
    expect((await claim('bot-1')).body.data.orderNo).toBe(o.order_no);
  });

  test('FAILED requeue ได้เช่นกัน', async () => {
    const o = await seedOrder('FAILED');
    expect((await admin(api().post(`/admin/orders/${o.order_no}/requeue`)).send({})).body.data.status).toBe('QUEUED');
  });

  test.each(['PENDING_PAYMENT', 'QUEUED', 'IN_PROGRESS', 'COMPLETED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED'])(
    'จาก %s => 409 REQUEUE_NOT_ALLOWED', async (status) => {
      const extra = status === 'IN_PROGRESS' ? { locked_by: 'bot-9', lease_expires_at: new Date(Date.now() + 60_000) } : {};
      const o = await seedOrder(status, extra);
      const res = await admin(api().post(`/admin/orders/${o.order_no}/requeue`)).send({});
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REQUEUE_NOT_ALLOWED');
    }
  );

  test('สั่งพร้อมกัน 8 ครั้ง => สำเร็จครั้งเดียว', async () => {
    const o = await seedOrder('DELAYED');
    const results = await Promise.all(Array.from({ length: 8 }, () => admin(api().post(`/admin/orders/${o.order_no}/requeue`)).send({})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await eventTypes(o.id)).filter((t) => t === 'ADMIN_REQUEUED')).toHaveLength(1);
  });

  test('ไม่พบ / เลขผิดรูปแบบ', async () => {
    expect((await admin(api().post('/admin/orders/ORD-9999999999999-999/requeue')).send({})).status).toBe(404);
    expect((await admin(api().post('/admin/orders/nope/requeue')).send({})).body.error.code).toBe('INVALID_ORDER_NO');
  });
});

describe('ยืนยันคืนเงิน', () => {
  test('REFUND_PENDING (จากจ่ายช้า) => REFUNDED; จากสถานะอื่น 409', async () => {
    const late = await seedOrder('REFUND_PENDING');
    expect((await admin(api().post(`/admin/orders/${late.order_no}/refund`)).send({})).body.data.status).toBe('REFUNDED');
    for (const status of ['FAILED', 'DELAYED', 'COMPLETED', 'QUEUED', 'REFUNDED']) {
      const o = await seedOrder(status);
      const res = await admin(api().post(`/admin/orders/${o.order_no}/refund`)).send({});
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REFUND_NOT_PENDING');
    }
    expect(await countRows('alerts')).toBe(0);
  });
});
