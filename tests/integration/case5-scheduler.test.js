/**
 * เคส 5: ออเดอร์ค้าง / หมดอายุ => scheduler ย้าย PENDING_PAYMENT ที่เกินเวลาเป็น EXPIRED และแจ้งเตือนเมื่อ QUEUED นานเกิน SLA
 * ต้อง "รันซ้ำได้โดยไม่เสียหาย" (idempotent)
 */
const {
  pool, api, setupDb, resetDb, closeDb, setConfig, restoreConfig, seedOrder, getOrder, eventTypes, countRows,
  admin, claim, runScheduler,
} = require('./helpers');

jest.setTimeout(60000);
beforeAll(setupDb);
beforeEach(async () => { await resetDb(); restoreConfig(); });
afterAll(async () => { restoreConfig(); await closeDb(); });

const past = (ms) => new Date(Date.now() - ms);
const alertRows = async (type) => (await pool.query('SELECT order_id, severity FROM alerts WHERE type = $1 ORDER BY id', [type])).rows;

describe('หมดเวลาจ่ายเงิน => EXPIRED', () => {
  test('ย้ายเฉพาะ PENDING_PAYMENT ที่เกินเวลา; ที่ยังไม่ถึงเวลา และสถานะอื่น (แม้เวลาจ่ายเลยแล้ว) ไม่ถูกแตะ', async () => {
    const overdue = await seedOrder('PENDING_PAYMENT', { payment_expires_at: past(60_000) });
    const fresh = await seedOrder('PENDING_PAYMENT', { payment_expires_at: new Date(Date.now() + 600_000) });
    const paid = await seedOrder('QUEUED', { payment_expires_at: past(60_000) });       // จ่ายแล้ว: เวลาจ่ายไม่เกี่ยวอีกต่อไป
    const done = await seedOrder('COMPLETED', { payment_expires_at: past(60_000) });

    const run = await runScheduler();
    expect(run.body.data.expiredPayments).toEqual({ processed: 1, skipped: 0, failed: 0 });
    expect((await getOrder(overdue.id)).status).toBe('EXPIRED');
    expect((await getOrder(fresh.id)).status).toBe('PENDING_PAYMENT');
    expect((await getOrder(paid.id)).status).toBe('QUEUED');
    expect((await getOrder(done.id)).status).toBe('COMPLETED');

    const ev = (await pool.query("SELECT from_status, to_status, actor FROM order_events WHERE order_id = $1", [overdue.id])).rows;
    expect(ev).toEqual([{ from_status: 'PENDING_PAYMENT', to_status: 'EXPIRED', actor: 'scheduler' }]);
    const history = (await api().get('/orders?tab=history')).body.data.map((o) => o.orderNo);
    expect(history).toEqual(expect.arrayContaining([overdue.order_no, done.order_no]));
    const current = (await api().get('/orders?tab=current')).body.data.map((o) => o.orderNo);
    expect(current).not.toContain(overdue.order_no);
  });

  test('รันซ้ำ 3 รอบ => ผลเท่ากับรันครั้งเดียว (event เดียว version +1)', async () => {
    const o = await seedOrder('PENDING_PAYMENT', { payment_expires_at: past(1000) });
    const runs = [await runScheduler(), await runScheduler(), await runScheduler()];
    expect(runs.map((r) => r.body.data.expiredPayments.processed)).toEqual([1, 0, 0]);
    expect(await eventTypes(o.id)).toEqual(['PAYMENT_EXPIRED']);
    expect(await getOrder(o.id)).toMatchObject({ status: 'EXPIRED', version: 1 });
  });

  test('ออเดอร์จำนวนมาก (230) เกินขนาด batch: รันต่อเนื่องจนครบ ทุกออเดอร์ได้ event เดียว', async () => {
    await pool.query(
      `INSERT INTO orders (order_no, status, customer_ref, game_code, game_uid, package_code, amount, payment_expires_at)
       SELECT 'ORD-' || lpad((1000000 + g)::text, 13, '0') || '-' || lpad((g % 1000)::text, 3, '0'),
              'PENDING_PAYMENT', 'bulk', 'ff', '1', 'p', 10, now() - interval '1 minute'
         FROM generate_series(1, 230) g`
    );
    const processedPerRun = [];
    for (let i = 0; i < 4; i += 1) processedPerRun.push((await runScheduler()).body.data.expiredPayments.processed);
    expect(processedPerRun).toEqual([100, 100, 30, 0]);
    expect((await pool.query("SELECT count(*)::int AS n FROM orders WHERE status = 'EXPIRED'")).rows[0].n).toBe(230);
    expect((await pool.query("SELECT count(*)::int AS n FROM order_events WHERE event_type = 'PAYMENT_EXPIRED'")).rows[0].n).toBe(230);
  });

  test('รัน 6 ตัวพร้อมกัน => แต่ละออเดอร์หมดอายุครั้งเดียว ไม่มี error', async () => {
    for (let i = 0; i < 25; i += 1) await seedOrder('PENDING_PAYMENT', { payment_expires_at: past(1000 + i) });
    const runs = await Promise.all(Array.from({ length: 6 }, () => runScheduler()));
    expect(runs.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(runs.reduce((n, r) => n + r.body.data.expiredPayments.failed, 0)).toBe(0);
    expect(runs.reduce((n, r) => n + r.body.data.expiredPayments.processed, 0)).toBe(25);
    expect((await pool.query("SELECT count(*)::int AS n FROM order_events WHERE event_type = 'PAYMENT_EXPIRED'")).rows[0].n).toBe(25);
  });

  test('ออเดอร์หนึ่งพัง ไม่ลากตัวอื่น: นับ failed แล้วทำตัวอื่นต่อ', async () => {
    const poison = await seedOrder('PENDING_PAYMENT', { customer_ref: 'poison', payment_expires_at: past(3000) });
    const ok1 = await seedOrder('PENDING_PAYMENT', { payment_expires_at: past(2000) });
    const ok2 = await seedOrder('PENDING_PAYMENT', { payment_expires_at: past(1000) });
    await pool.query(`CREATE OR REPLACE FUNCTION tmp_poison() RETURNS trigger AS $$
      BEGIN IF NEW.customer_ref = 'poison' THEN RAISE EXCEPTION 'poisoned'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await pool.query('CREATE TRIGGER tmp_poison BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION tmp_poison()');
    try {
      const run = await runScheduler();
      expect(run.status).toBe(200);
      expect(run.body.data.expiredPayments).toEqual({ processed: 2, skipped: 0, failed: 1 });
      expect((await getOrder(poison.id)).status).toBe('PENDING_PAYMENT');
      expect((await getOrder(ok1.id)).status).toBe('EXPIRED');
      expect((await getOrder(ok2.id)).status).toBe('EXPIRED');
      expect(await eventTypes(poison.id)).toEqual([]); // rollback ทั้ง transaction ของออเดอร์นั้น
    } finally {
      await pool.query('DROP TRIGGER tmp_poison ON orders');
      await pool.query('DROP FUNCTION tmp_poison()');
    }
    // หายพังแล้วรอบถัดไปเก็บตัวที่ค้างให้เอง
    expect((await runScheduler()).body.data.expiredPayments.processed).toBe(1);
    expect((await getOrder(poison.id)).status).toBe('EXPIRED');
  });
});

describe('QUEUED นานเกิน SLA => alert', () => {
  beforeEach(() => setConfig({ queueSlaSeconds: 60 }));

  test('แจ้งเฉพาะ QUEUED ที่ค้างเกินกำหนด ไม่ย้ายสถานะ (ยังถูก bot หยิบได้) และไม่แจ้งงานใหม่/สถานะอื่น', async () => {
    const stale = await seedOrder('QUEUED', { queued_at: past(5 * 60_000) });
    const fresh = await seedOrder('QUEUED', { queued_at: past(5_000) });
    await seedOrder('IN_PROGRESS', { queued_at: past(5 * 60_000), locked_by: 'bot-9', lease_expires_at: new Date(Date.now() + 60_000) });
    await seedOrder('PENDING_PAYMENT', { created_at: past(5 * 60_000) });

    const run = await runScheduler();
    expect(run.body.data.queueSlaAlerts.created).toBe(1);
    expect(await alertRows('QUEUE_SLA_BREACH')).toEqual([{ order_id: String(stale.id), severity: 'WARNING' }]);
    expect((await getOrder(stale.id)).status).toBe('QUEUED');
    expect((await getOrder(fresh.id)).status).toBe('QUEUED');
    expect((await claim('bot-1')).body.data.orderNo).toBe(stale.order_no);
  });

  test('รันซ้ำกี่รอบก็ได้ alert เดียวต่อรอบที่เข้าคิว (รวมพร้อมกัน)', async () => {
    await seedOrder('QUEUED', { queued_at: past(5 * 60_000) });
    await Promise.all(Array.from({ length: 5 }, () => runScheduler()));
    await runScheduler(); await runScheduler();
    expect(await countRows('alerts')).toBe(1);
  });

  test('คิวซ้ำคนละรอบ (เข้าคิวใหม่ด้วย queued_at ใหม่แล้วค้างอีก) => alert ใหม่', async () => {
    const o = await seedOrder('QUEUED', { queued_at: past(5 * 60_000) });
    await runScheduler();
    await pool.query("UPDATE orders SET queued_at = now() - interval '6 minutes' WHERE id = $1", [o.id]);
    await runScheduler(); await runScheduler();
    expect(await countRows('alerts')).toBe(2);
  });

  test('ใช้ created_at แทนถ้าไม่มี queued_at (กันข้อมูลตกหล่น) และ SLA ปรับได้ด้วย config', async () => {
    await seedOrder('QUEUED', { queued_at: null, created_at: past(5 * 60_000) });
    expect((await runScheduler()).body.data.queueSlaAlerts.created).toBe(1);
    await resetDb();
    setConfig({ queueSlaSeconds: 3600 });
    await seedOrder('QUEUED', { queued_at: past(5 * 60_000) });
    expect((await runScheduler()).body.data.queueSlaAlerts.created).toBe(0);
  });
});

describe('endpoint สั่ง scheduler (แอดมิน)', () => {
  test('ต้องมี X-Admin-Token', async () => {
    expect((await api().post('/admin/scheduler/run').send({})).status).toBe(401);
    expect((await api().post('/admin/scheduler/run').set('X-Admin-Token', 'wrong').send({})).status).toBe(401);
  });

  test('รันทั้งสามงานในรอบเดียว และตอบสรุปผล', async () => {
    await seedOrder('PENDING_PAYMENT', { payment_expires_at: past(1000) });
    const leased = await seedOrder('QUEUED');
    await claim('bot-1');
    await pool.query("UPDATE orders SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [leased.id]);
    const res = await admin(api().post('/admin/scheduler/run')).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      expiredPayments: { processed: 1, skipped: 0, failed: 0 },
      reclaimedLeases: { processed: 1, skipped: 0, failed: 0 },
      queueSlaAlerts: { created: 0 },
    });
  });
});
