/**
 * เคส 2: bot สองตัวแย่งออเดอร์เดียวกัน => ห้ามจ่ายซ้ำ
 * (ครอบคลุมเพิ่มจาก bot.test.js: ออเดอร์เดียวแต่ bot จำนวนมาก, ด่านของ DB, ลำดับคิว, ข้ามงานที่ยังไม่ถึงเวลา)
 */
const { pool, setupDb, resetDb, closeDb, seedOrder, getOrder, claim, runScheduler, restoreConfig } = require('./helpers');

jest.setTimeout(30000);
beforeAll(setupDb);
beforeEach(async () => { await resetDb(); restoreConfig(); });
afterAll(closeDb);

describe('claim แบบ atomic', () => {
  test('ออเดอร์เดียว bot 25 ตัวแย่งพร้อมกัน => ได้ตัวเดียว attempt เดียว version +1 เท่านั้น', async () => {
    const o = await seedOrder('QUEUED');
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => claim(`bot-${i}`)));
    expect(results.map((r) => r.status)).toEqual(Array(25).fill(200));
    const winners = results.filter((r) => r.body.data !== null);
    expect(winners).toHaveLength(1);
    const after = await getOrder(o.id);
    expect(after).toMatchObject({ status: 'IN_PROGRESS', version: 1 });
    expect(after.locked_by).toMatch(/^bot-\d+$/);
    expect((await pool.query('SELECT bot_id FROM fulfillment_attempts WHERE order_id = $1', [o.id])).rows)
      .toEqual([{ bot_id: after.locked_by }]);
    expect((await pool.query("SELECT count(*)::int AS n FROM order_events WHERE order_id = $1 AND event_type = 'BOT_CLAIMED'", [o.id])).rows[0].n).toBe(1);
  });

  test('ออเดอร์ 30 งาน bot 30 ตัวยิงพร้อมกัน => ทุกตัวได้คนละงาน ไม่มีใครมือเปล่าทั้งที่ยังมีงานเหลือ', async () => {
    for (let round = 0; round < 3; round += 1) {
      await resetDb();
      const orders = [];
      for (let i = 0; i < 30; i += 1) orders.push(await seedOrder('QUEUED', { queued_at: new Date(Date.now() - (60 - i) * 1000) }));
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => claim(`bot-${i}`)));
      const got = results.map((r) => r.body.data);
      expect(got.filter((d) => d === null)).toHaveLength(0); // ไม่มี bot ที่กลับมือเปล่า ทั้งที่ยังมีงานเหลือ
      expect(new Set(got.map((d) => d.orderNo)).size).toBe(30);
      expect((await pool.query("SELECT count(*)::int AS n FROM orders WHERE status = 'IN_PROGRESS'")).rows[0].n).toBe(30);
    }
  });

  test('ไม่รอล็อก: แถวแรกถูก transaction อื่นถือล็อกค้างอยู่ => claim ข้ามไปหยิบแถวถัดไปทันที ไม่บล็อก (นี่คือสิ่งที่ SKIP LOCKED ให้)', async () => {
    const first = await seedOrder('QUEUED', { queued_at: new Date(Date.now() - 60_000) });
    const second = await seedOrder('QUEUED', { queued_at: new Date(Date.now() - 30_000) });
    const holder = await pool.connect();
    let pending;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [first.id]); // เช่น กำลังถูกอีก transaction ประมวลผลอยู่
      pending = claim('bot-1');
      const result = await Promise.race([pending, new Promise((r) => setTimeout(() => r('BLOCKED'), 3000))]);
      expect(result).not.toBe('BLOCKED');
      expect(result.body.data.orderNo).toBe(second.order_no);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      if (pending) await pending.catch(() => {});
    }
    // ปล่อยล็อกแล้ว แถวแรกกลับมาหยิบได้ตามปกติ
    expect((await claim('bot-2')).body.data.orderNo).toBe(first.order_no);
  });

  test('ด่านสุดท้ายที่ DB: แทรก attempt IN_FLIGHT ซ้อนสำหรับออเดอร์เดียวกันไม่ได้ (unique index) แม้โค้ดพลาด', async () => {
    const o = await seedOrder('QUEUED');
    await pool.query("INSERT INTO fulfillment_attempts (order_id, attempt_no, bot_id) VALUES ($1, 1, 'a')", [o.id]);
    await expect(pool.query("INSERT INTO fulfillment_attempts (order_id, attempt_no, bot_id) VALUES ($1, 2, 'b')", [o.id]))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_attempt_active_per_order' });
    await pool.query("UPDATE fulfillment_attempts SET status = 'SUCCEEDED' WHERE order_id = $1", [o.id]);
    // จ่ายสำเร็จแล้ว ห้ามมีรายการจ่ายใหม่อีก
    await expect(pool.query("INSERT INTO fulfillment_attempts (order_id, attempt_no, bot_id) VALUES ($1, 2, 'b')", [o.id]))
      .rejects.toMatchObject({ code: '23505' });
    // แต่ถ้ารอบก่อนล้มเหลว/ถูกทิ้ง เริ่มรอบใหม่ได้
    await pool.query("UPDATE fulfillment_attempts SET status = 'ABANDONED' WHERE order_id = $1", [o.id]);
    await expect(pool.query("INSERT INTO fulfillment_attempts (order_id, attempt_no, bot_id) VALUES ($1, 2, 'b')", [o.id])).resolves.toBeDefined();
  });

  test('หยิบเฉพาะ QUEUED ที่ถึงเวลา: ข้ามสถานะอื่นและงานที่รอ backoff', async () => {
    await seedOrder('PENDING_PAYMENT');
    await seedOrder('COMPLETED');
    await seedOrder('DELAYED');
    await seedOrder('FAILED');
    await seedOrder('QUEUED', { next_retry_at: new Date(Date.now() + 60_000) });
    expect((await claim('bot-1')).body.data).toBeNull();
    const ready = await seedOrder('QUEUED', { next_retry_at: new Date(Date.now() - 1000) });
    expect((await claim('bot-1')).body.data.orderNo).toBe(ready.order_no);
  });

  test('คิว FIFO: เข้าคิวก่อนได้ก่อน', async () => {
    const newest = await seedOrder('QUEUED', { queued_at: new Date(Date.now() - 1000) });
    const oldest = await seedOrder('QUEUED', { queued_at: new Date(Date.now() - 60_000) });
    const middle = await seedOrder('QUEUED', { queued_at: new Date(Date.now() - 30_000) });
    const order = [];
    for (let i = 0; i < 3; i += 1) order.push((await claim(`bot-${i}`)).body.data.orderNo);
    expect(order).toEqual([oldest.order_no, middle.order_no, newest.order_no]);
  });

  test('claim พร้อมกับ scheduler (ดึง lease คืน) ไม่ทำให้ออเดอร์ถูกถือสองมือ', async () => {
    const orders = [];
    for (let i = 0; i < 6; i += 1) {
      const o = await seedOrder('QUEUED', { queued_at: new Date(Date.now() - (20 - i) * 1000) });
      await claim(`first-${i}`);
      orders.push(o);
    }
    await pool.query("UPDATE orders SET lease_expires_at = now() - interval '1 second', retry_count = 0");
    await pool.query("UPDATE orders SET status = 'IN_PROGRESS' WHERE status = 'IN_PROGRESS'");

    // scheduler ดึงคืน พร้อมกับ bot ใหม่ ๆ ที่ claim รัว ๆ (ตอน backoff ยังไม่ถึง ต้องไม่มีใครได้งานซ้ำ)
    await Promise.all([runScheduler(), ...Array.from({ length: 12 }, (_, i) => claim(`second-${i}`))]);
    const { rows } = await pool.query("SELECT order_id, count(*)::int AS n FROM fulfillment_attempts WHERE status = 'IN_FLIGHT' GROUP BY order_id");
    for (const r of rows) expect(r.n).toBe(1);
    const inProgress = (await pool.query("SELECT count(*)::int AS n FROM orders WHERE status = 'IN_PROGRESS' AND locked_by IS NULL")).rows[0].n;
    expect(inProgress).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM orders WHERE status = $1', ['QUEUED'])).rows[0].n).toBeGreaterThan(0);
  });
});
