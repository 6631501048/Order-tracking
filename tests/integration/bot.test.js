const { pool, api, setupDb, resetDb, closeDb } = require('./helpers');
const { withTransaction } = require('../../src/db');
const { applyTransition } = require('../../src/services/orderTransitions');
const { InvalidTransitionError, STATUS } = require('../../src/domain/orderStatus');

jest.setTimeout(30000);
beforeAll(setupDb);
beforeEach(resetDb);
afterAll(closeDb);

let orderCounter = 0;

async function seedQueued() {
  const orderNo = `ORD-${String(Date.now()).padStart(13, '0')}-${String(orderCounter++ % 1000).padStart(3, '0')}`;
  const { rows } = await pool.query(
    `INSERT INTO orders
       (order_no, status, customer_ref, game_code, game_uid, package_code, amount, payment_expires_at, queued_at)
     VALUES ($1, 'QUEUED', 'test-user', 'freefire', 'uid-123', 'diamonds', 35, now() + interval '15 min', now())
     RETURNING id`,
    [orderNo]
  );
  return { orderNo, id: rows[0].id };
}

const botRequest = (botId = 'bot-1') => ({
  set: (request) => request.set('X-Bot-Token', 'integration-bot-token').set('X-Bot-Id', botId),
});

function authenticated(request, botId = 'bot-1') {
  return botRequest(botId).set(request);
}

describe('bot token authentication', () => {
  test('ปฏิเสธเมื่อไม่มี token หรือ token ไม่ถูกต้อง', async () => {
    const noToken = await api().post('/bot/orders/claim').set('X-Bot-Id', 'bot-1').send({});
    const badToken = await api().post('/bot/orders/claim')
      .set('X-Bot-Token', 'wrong-token').set('X-Bot-Id', 'bot-1').send({});

    expect(noToken.status).toBe(401);
    expect(noToken.body.error.code).toBe('UNAUTHORIZED');
    expect(badToken.status).toBe(401);
  });
});

describe('POST /bot/orders/claim', () => {
  test('claim เปลี่ยนสถานะ, lease, version, attempt และ timeline ใน transaction', async () => {
    const { orderNo, id } = await seedQueued();
    const res = await authenticated(api().post('/bot/orders/claim')).send({});

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      orderNo, gameCode: 'freefire', gameUid: 'uid-123', packageCode: 'diamonds',
      amount: 35, currency: 'THB', attemptNo: 1,
    });
    const order = (await pool.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0];
    expect(order).toMatchObject({ status: 'IN_PROGRESS', locked_by: 'bot-1', version: 1 });
    expect(order.lease_expires_at.getTime()).toBeGreaterThan(Date.now());
    expect((await pool.query('SELECT status FROM fulfillment_attempts WHERE order_id = $1', [id])).rows)
      .toEqual([{ status: 'IN_FLIGHT' }]);
    expect((await pool.query('SELECT event_type FROM order_events WHERE order_id = $1', [id])).rows)
      .toEqual([{ event_type: 'BOT_CLAIMED' }]);
  });

  test('คำขอพร้อมกันไม่ claim ออเดอร์ซ้ำ และงานที่ถูกล็อกถูกข้าม', async () => {
    const orders = await Promise.all(Array.from({ length: 5 }, () => seedQueued()));
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      authenticated(api().post('/bot/orders/claim'), `bot-${i}`).send({})
    ));
    const claimed = results.map((result) => result.body.data).filter(Boolean);

    expect(results.map((result) => result.status)).toEqual(Array(8).fill(200));
    expect(claimed).toHaveLength(5);
    expect(new Set(claimed.map((order) => order.orderNo)).size).toBe(5);
    expect(new Set(claimed.map((order) => order.orderNo))).toEqual(new Set(orders.map((order) => order.orderNo)));
    const activeAttempts = await pool.query(
      "SELECT count(*)::int AS n FROM fulfillment_attempts WHERE status = 'IN_FLIGHT'"
    );
    expect(activeAttempts.rows[0].n).toBe(5);
  });

  test('ไม่มีงานที่พร้อม => data null', async () => {
    const res = await authenticated(api().post('/bot/orders/claim')).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: null });
  });
});

describe('bot lease and fulfillment endpoints', () => {
  test('heartbeat ต่อ lease; complete เปลี่ยนสถานะและปิด attempt', async () => {
    const { orderNo, id } = await seedQueued();
    await authenticated(api().post('/bot/orders/claim')).send({});

    const heartbeat = await authenticated(api().post(`/bot/orders/${orderNo}/heartbeat`)).send({});
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.data.orderNo).toBe(orderNo);

    const complete = await authenticated(api().post(`/bot/orders/${orderNo}/complete`)).send({});
    expect(complete.status).toBe(200);
    expect(complete.body.data.status).toBe('COMPLETED');
    const order = (await pool.query('SELECT status, version, locked_by, lease_expires_at FROM orders WHERE id = $1', [id])).rows[0];
    expect(order).toMatchObject({ status: 'COMPLETED', version: 3, locked_by: null, lease_expires_at: null });
    expect((await pool.query('SELECT status FROM fulfillment_attempts WHERE order_id = $1', [id])).rows)
      .toEqual([{ status: 'SUCCEEDED' }]);
    expect((await pool.query('SELECT event_type FROM order_events WHERE order_id = $1 ORDER BY id', [id])).rows)
      .toEqual([{ event_type: 'BOT_CLAIMED' }, { event_type: 'BOT_HEARTBEAT' }, { event_type: 'BOT_COMPLETED' }]);
  });

  test('bot อื่นและ lease ที่หมดอายุแก้ไขงานไม่ได้', async () => {
    const { orderNo, id } = await seedQueued();
    await authenticated(api().post('/bot/orders/claim')).send({});
    const otherBot = await authenticated(api().post(`/bot/orders/${orderNo}/complete`), 'bot-2').send({});
    expect(otherBot.status).toBe(409);
    expect(otherBot.body.error.code).toBe('BOT_LEASE_NOT_OWNED');

    await pool.query("UPDATE orders SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
    const expired = await authenticated(api().post(`/bot/orders/${orderNo}/heartbeat`)).send({});
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe('BOT_LEASE_NOT_OWNED');
  });

  test('fail แยก permanent เป็น FAILED และ transient กลับ QUEUED', async () => {
    const permanent = await seedQueued();
    await authenticated(api().post('/bot/orders/claim')).send({});
    const permanentRes = await authenticated(api().post(`/bot/orders/${permanent.orderNo}/fail`))
      .send({ errorType: 'PERMANENT', errorCode: 'INVALID_UID', message: 'UID ไม่ถูกต้อง' });
    expect(permanentRes.status).toBe(200);
    expect(permanentRes.body.data.status).toBe('FAILED');

    const transient = await seedQueued();
    await authenticated(api().post('/bot/orders/claim')).send({});
    const transientRes = await authenticated(api().post(`/bot/orders/${transient.orderNo}/fail`))
      .send({ errorType: 'TRANSIENT', errorCode: 'PROVIDER_TIMEOUT', message: 'หมดเวลา' });
    expect(transientRes.status).toBe(200);
    expect(transientRes.body.data.status).toBe('QUEUED');

    const { rows } = await pool.query('SELECT status, retry_count, last_error_type FROM orders WHERE id = ANY($1::bigint[]) ORDER BY id', [
      [permanent.id, transient.id],
    ]);
    expect(rows).toEqual([
      { status: 'FAILED', retry_count: 0, last_error_type: 'PERMANENT' },
      { status: 'QUEUED', retry_count: 1, last_error_type: 'TRANSIENT' },
    ]);
  });

  test('transition ที่ผิดถูก rollback โดยไม่เพิ่ม version หรือ event', async () => {
    const { id } = await seedQueued();

    await expect(withTransaction((client) => applyTransition(client, {
      orderId: id,
      toStatus: STATUS.COMPLETED,
      eventType: 'INVALID_TEST',
      actor: 'test',
    }))).rejects.toBeInstanceOf(InvalidTransitionError);

    const order = (await pool.query('SELECT status, version FROM orders WHERE id = $1', [id])).rows[0];
    expect(order).toEqual({ status: 'QUEUED', version: 0 });
    expect((await pool.query('SELECT count(*)::int AS n FROM order_events WHERE order_id = $1', [id])).rows[0].n).toBe(0);
  });
});
