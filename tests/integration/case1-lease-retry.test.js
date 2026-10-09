/**
 * เคส 1: bot ล่ม / เงียบ => heartbeat + lease, ดึงงานคืน, retry แบบ exponential backoff ไม่เกิน 3 ครั้ง แล้ว DELAYED + แจ้งแอดมิน
 */
const {
  pool, api, setupDb, resetDb, closeDb, setConfig, restoreConfig, seedOrder, getOrder, eventTypes, alertsOf,
  bot, claim, botFail, runScheduler,
} = require('./helpers');

jest.setTimeout(30000);
beforeAll(setupDb);
beforeEach(async () => { await resetDb(); restoreConfig(); setConfig({ retryBaseSeconds: 30, maxRetries: 3 }); });
afterAll(async () => { restoreConfig(); await closeDb(); });

const expireLease = (id) => pool.query("UPDATE orders SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
const makeEligible = (id) => pool.query("UPDATE orders SET next_retry_at = now() - interval '1 second' WHERE id = $1", [id]);
const secondsUntilRetry = async (id) =>
  Number((await pool.query('SELECT EXTRACT(EPOCH FROM (next_retry_at - now())) AS s FROM orders WHERE id = $1', [id])).rows[0].s);
const attemptStatuses = async (id) =>
  (await pool.query('SELECT status FROM fulfillment_attempts WHERE order_id = $1 ORDER BY attempt_no', [id])).rows.map((r) => r.status);

describe('lease หมดอายุ => ดึงงานคืน', () => {
  test('bot เงียบ: ออเดอร์กลับ QUEUED พร้อม backoff, ปล่อย lock, attempt เดิมเป็น ABANDONED, บันทึก timeline', async () => {
    const o = await seedOrder('QUEUED');
    await claim('bot-1');
    const before = await getOrder(o.id);
    await expireLease(o.id);

    const run = await runScheduler();
    expect(run.status).toBe(200);
    expect(run.body.data.reclaimedLeases).toMatchObject({ processed: 1, failed: 0 });

    const after = await getOrder(o.id);
    expect(after).toMatchObject({
      status: 'QUEUED', retry_count: 1, locked_by: null, lease_expires_at: null,
      last_error_type: 'TRANSIENT', last_error_code: 'BOT_LEASE_EXPIRED',
    });
    expect(after.version).toBeGreaterThan(before.version);
    const delay = await secondsUntilRetry(o.id);
    expect(delay).toBeGreaterThan(25);
    expect(delay).toBeLessThanOrEqual(30);
    expect(await attemptStatuses(o.id)).toEqual(['ABANDONED']);
    expect(await eventTypes(o.id)).toEqual(['BOT_CLAIMED', 'LEASE_EXPIRED']);
    const ev = (await pool.query("SELECT actor, metadata FROM order_events WHERE event_type = 'LEASE_EXPIRED'")).rows[0];
    expect(ev.actor).toBe('scheduler');
    expect(ev.metadata).toMatchObject({ previousBot: 'bot-1', retryCount: 1, delaySeconds: 30 });
  });

  test('lease ที่ยังไม่หมดอายุไม่ถูกแตะ', async () => {
    const o = await seedOrder('QUEUED');
    await claim('bot-1');
    const run = await runScheduler();
    expect(run.body.data.reclaimedLeases.processed).toBe(0);
    expect(await getOrder(o.id)).toMatchObject({ status: 'IN_PROGRESS', locked_by: 'bot-1', retry_count: 0 });
  });

  test('เวลาจริง: ไม่ส่ง heartbeat จน lease หมด => ถูกดึงคืน แต่ถ้าส่ง heartbeat ทัน => ไม่ถูกดึง', async () => {
    const alive = await seedOrder('QUEUED', { queued_at: new Date(Date.now() - 2000) });
    const dead = await seedOrder('QUEUED', { queued_at: new Date(Date.now() - 1000) });
    await claim('bot-alive');
    await claim('bot-dead');
    await pool.query("UPDATE orders SET lease_expires_at = now() + interval '1 second' WHERE id = ANY($1::bigint[])", [[alive.id, dead.id]]);

    const hb = await bot(api().post(`/bot/orders/${alive.order_no}/heartbeat`), 'bot-alive').send({});
    expect(hb.status).toBe(200); // ต่อ lease เป็น ~120 วินาที
    await new Promise((r) => setTimeout(r, 1300));
    await runScheduler();

    expect((await getOrder(alive.id)).status).toBe('IN_PROGRESS');
    expect((await getOrder(dead.id)).status).toBe('QUEUED');
  });

  test('รอ backoff: ยังไม่ถึงเวลา => claim ไม่ได้, ถึงเวลาแล้ว claim ได้เป็นรอบที่ 2 (attempt เดิมที่ ABANDONED ไม่บล็อก)', async () => {
    const o = await seedOrder('QUEUED');
    await claim('bot-1');
    await expireLease(o.id);
    await runScheduler();

    expect((await claim('bot-2')).body.data).toBeNull();
    await makeEligible(o.id);
    const second = await claim('bot-2');
    expect(second.body.data).toMatchObject({ orderNo: o.order_no, attemptNo: 2 });
    expect(await attemptStatuses(o.id)).toEqual(['ABANDONED', 'IN_FLIGHT']);
  });

  test('exponential backoff 30 -> 60 -> 120 วินาที แล้วรอบที่ 4 ยอมแพ้ => DELAYED + alert CRITICAL', async () => {
    const o = await seedOrder('QUEUED');
    const delays = [];
    for (let round = 1; round <= 3; round += 1) {
      await makeEligible(o.id);
      expect((await claim(`bot-${round}`)).body.data).not.toBeNull();
      await expireLease(o.id);
      await runScheduler();
      expect(await getOrder(o.id)).toMatchObject({ status: 'QUEUED', retry_count: round });
      delays.push(Math.round(await secondsUntilRetry(o.id) / 5) * 5); // ปัดเป็นช่วง 5 วินาทีกันเวลาเดินระหว่างรัน
    }
    expect(delays).toEqual([30, 60, 120]);

    await makeEligible(o.id);
    await claim('bot-4');
    await expireLease(o.id);
    await runScheduler();

    const final = await getOrder(o.id);
    expect(final).toMatchObject({ status: 'DELAYED', retry_count: 3, locked_by: null, lease_expires_at: null, next_retry_at: null });
    expect(await alertsOf(o.id)).toEqual([{ type: 'BOT_RETRY_EXHAUSTED', severity: 'CRITICAL' }]);
    expect(await attemptStatuses(o.id)).toEqual(['ABANDONED', 'ABANDONED', 'ABANDONED', 'ABANDONED']);
    expect(await eventTypes(o.id)).toEqual([
      'BOT_CLAIMED', 'LEASE_EXPIRED', 'BOT_CLAIMED', 'LEASE_EXPIRED', 'BOT_CLAIMED', 'LEASE_EXPIRED', 'BOT_CLAIMED', 'RETRIES_EXHAUSTED',
    ]);
    // DELAYED ไม่ถูก bot หยิบ และ scheduler ไม่แตะซ้ำ
    await pool.query("UPDATE orders SET next_retry_at = NULL WHERE id = $1", [o.id]);
    expect((await claim('bot-5')).body.data).toBeNull();
    const again = await runScheduler();
    expect(again.body.data.reclaimedLeases.processed).toBe(0);
    expect(await alertsOf(o.id)).toHaveLength(1);
  });

  test('ปรับเพดานด้วย config: maxRetries = 1 => พลาดครั้งที่ 2 ก็ DELAYED', async () => {
    setConfig({ maxRetries: 1 });
    const o = await seedOrder('QUEUED');
    await claim('bot-1'); await expireLease(o.id); await runScheduler();
    expect((await getOrder(o.id)).status).toBe('QUEUED');
    await makeEligible(o.id); await claim('bot-1'); await expireLease(o.id); await runScheduler();
    expect(await getOrder(o.id)).toMatchObject({ status: 'DELAYED', retry_count: 1 });
  });

  test('ก่อนหน้านั้น retry_count = 3 พอดี (เพดาน) และ backoff ถูกจำกัดด้วย retryMaxDelaySeconds', async () => {
    setConfig({ retryMaxDelaySeconds: 40 });
    const o = await seedOrder('QUEUED', { retry_count: 1 });
    await claim('bot-1'); await expireLease(o.id); await runScheduler();
    expect(await getOrder(o.id)).toMatchObject({ retry_count: 2 }); // 30*2 = 60 แต่ถูกจำกัดที่ 40
    expect(await secondsUntilRetry(o.id)).toBeLessThanOrEqual(40);
  });
});

describe('bot ที่ถูกดึงงานคืนไปแล้ว (stale) ทำอะไรกับออเดอร์ไม่ได้', () => {
  test('heartbeat / complete / fail จาก bot เดิมถูกปฏิเสธ 409 และไม่กระทบรอบใหม่ของ bot อื่น', async () => {
    const o = await seedOrder('QUEUED');
    await claim('bot-1');
    await expireLease(o.id);
    await runScheduler();

    for (const action of ['heartbeat', 'complete']) {
      const res = await bot(api().post(`/bot/orders/${o.order_no}/${action}`), 'bot-1').send({});
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BOT_LEASE_NOT_OWNED');
    }
    expect((await botFail(o.order_no, 'bot-1')).status).toBe(409);

    await makeEligible(o.id);
    expect((await claim('bot-2')).body.data.attemptNo).toBe(2);
    // bot-1 ยังเข้ามาแทรกไม่ได้ แม้ bot-2 ถือ lease อยู่
    expect((await bot(api().post(`/bot/orders/${o.order_no}/complete`), 'bot-1').send({})).status).toBe(409);
    expect((await bot(api().post(`/bot/orders/${o.order_no}/complete`), 'bot-2').send({})).status).toBe(200);
    expect(await attemptStatuses(o.id)).toEqual(['ABANDONED', 'SUCCEEDED']);
    expect((await getOrder(o.id)).status).toBe('COMPLETED');
  });
});

describe('scheduler รันซ้ำ/พร้อมกันได้โดยไม่เสียหาย (idempotent)', () => {
  test('รันซ้ำ: ครั้งแรกดึงคืน ครั้งต่อไปไม่ทำอะไร retry_count เพิ่มแค่ 1', async () => {
    const o = await seedOrder('QUEUED');
    await claim('bot-1'); await expireLease(o.id);
    const runs = [await runScheduler(), await runScheduler(), await runScheduler()];
    expect(runs.map((r) => r.body.data.reclaimedLeases.processed)).toEqual([1, 0, 0]);
    expect((await getOrder(o.id)).retry_count).toBe(1);
    expect((await eventTypes(o.id)).filter((t) => t === 'LEASE_EXPIRED')).toHaveLength(1);
  });

  test('รัน 6 ตัวพร้อมกันกับ lease หมดอายุ 8 ออเดอร์ => แต่ละออเดอร์ถูกดึงคืนครั้งเดียว ไม่มี error', async () => {
    const orders = [];
    for (let i = 0; i < 8; i += 1) {
      const o = await seedOrder('QUEUED', { queued_at: new Date(Date.now() - (10 - i) * 1000) });
      await claim(`bot-${i}`);
      orders.push(o);
    }
    await pool.query("UPDATE orders SET lease_expires_at = now() - interval '1 second' WHERE status = 'IN_PROGRESS'");

    const runs = await Promise.all(Array.from({ length: 6 }, () => runScheduler()));
    expect(runs.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(runs.reduce((n, r) => n + r.body.data.reclaimedLeases.failed, 0)).toBe(0);
    expect(runs.reduce((n, r) => n + r.body.data.reclaimedLeases.processed, 0)).toBe(8);
    for (const o of orders) {
      expect(await getOrder(o.id)).toMatchObject({ status: 'QUEUED', retry_count: 1 });
      expect((await eventTypes(o.id)).filter((t) => t === 'LEASE_EXPIRED')).toHaveLength(1);
    }
  });
});

describe('bot รายงาน TRANSIENT error => นโยบาย retry เดียวกัน', () => {
  test('3 ครั้งแรกกลับคิวพร้อม backoff 30/60/120 ครั้งที่ 4 => DELAYED + alert', async () => {
    const o = await seedOrder('QUEUED');
    const delays = [];
    for (let round = 1; round <= 3; round += 1) {
      await makeEligible(o.id);
      await claim('bot-1');
      const res = await botFail(o.order_no, 'bot-1');
      expect(res.body.data).toEqual({ orderNo: o.order_no, status: 'QUEUED' });
      expect((await getOrder(o.id)).retry_count).toBe(round);
      delays.push(Math.round(await secondsUntilRetry(o.id) / 5) * 5);
    }
    expect(delays).toEqual([30, 60, 120]);

    await makeEligible(o.id);
    await claim('bot-1');
    const last = await botFail(o.order_no, 'bot-1');
    expect(last.body.data.status).toBe('DELAYED');
    expect(await getOrder(o.id)).toMatchObject({ status: 'DELAYED', retry_count: 3, last_error_code: 'PROVIDER_TIMEOUT' });
    expect(await alertsOf(o.id)).toEqual([{ type: 'BOT_RETRY_EXHAUSTED', severity: 'CRITICAL' }]);
    expect(await attemptStatuses(o.id)).toEqual(['FAILED', 'FAILED', 'FAILED', 'FAILED']);
    expect(await eventTypes(o.id)).toEqual([
      'BOT_CLAIMED', 'BOT_FAILED', 'BOT_CLAIMED', 'BOT_FAILED', 'BOT_CLAIMED', 'BOT_FAILED', 'BOT_CLAIMED', 'RETRIES_EXHAUSTED',
    ]);
  });

  test('ล้มเหลวผสม: lease หมด + bot รายงานพลาด นับรวมเป็นเพดานเดียวกัน', async () => {
    const o = await seedOrder('QUEUED');
    await claim('bot-1'); await expireLease(o.id); await runScheduler();     // retry 1
    await makeEligible(o.id); await claim('bot-2'); await botFail(o.order_no, 'bot-2'); // retry 2
    await makeEligible(o.id); await claim('bot-3'); await expireLease(o.id); await runScheduler(); // retry 3
    expect(await getOrder(o.id)).toMatchObject({ status: 'QUEUED', retry_count: 3 });
    await makeEligible(o.id); await claim('bot-4'); await botFail(o.order_no, 'bot-4');
    expect((await getOrder(o.id)).status).toBe('DELAYED');
  });
});
