const crypto = require('crypto');
const config = require('../config');
const { query, withTransaction } = require('../db');
const { logger, setContext } = require('../logger');
const { notFound, unprocessable, conflict } = require('../errors');
const { generateOrderNo } = require('../domain/orderNo');
const { STATUS, CURRENT_STATUSES, HISTORY_STATUSES } = require('../domain/orderStatus');
const { toOrderDto, toEventDto } = require('../mappers');

const IDEMPOTENCY_SCOPE = 'POST /orders';

/** hash ของ request หลัง normalize (ลำดับ field คงที่) เพื่อจับกรณี key เดิมแต่ body ต่าง */
function hashRequest(input) {
  const canonical = JSON.stringify([
    input.customerRef, input.gameCode, input.gameUid, input.packageCode, input.amount.toFixed(2), input.currency,
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** เลขออเดอร์ชนกัน (ความน่าจะเป็นต่ำมาก) => สุ่มใหม่ ใช้ SAVEPOINT เพื่อไม่ทำให้ทั้ง transaction พัง */
async function insertOrder(client, input) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const orderNo = generateOrderNo();
    await client.query('SAVEPOINT insert_order');
    try {
      const { rows } = await client.query(
        `INSERT INTO orders
           (order_no, status, customer_ref, game_code, game_uid, package_code, amount, currency, payment_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(mins => $9::int))
         RETURNING *`,
        [orderNo, STATUS.PENDING_PAYMENT, input.customerRef, input.gameCode, input.gameUid,
          input.packageCode, input.amount, input.currency, config.paymentTtlMinutes]
      );
      await client.query('RELEASE SAVEPOINT insert_order');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT insert_order');
      if (err.code === '23505' && err.constraint === 'orders_order_no_key') {
        logger.warn('order number collision, retrying', { attempt });
        continue;
      }
      throw err;
    }
  }
  throw new Error('ไม่สามารถสร้างเลขออเดอร์ที่ไม่ซ้ำได้');
}

/**
 * POST /orders
 * จอง Idempotency-Key ด้วย INSERT ... ON CONFLICT DO NOTHING ใน transaction เดียวกับการสร้างออเดอร์:
 *  - ได้แถวใหม่ => เราเป็นเจ้าของ key สร้างออเดอร์แล้วเก็บ response ไว้ใน key เดียวกัน
 *  - ชน key เดิม => (ถ้ามี request พร้อมกัน จะรอจน tx แรก commit) แล้วตอบ response เดิม
 *    หรือ 422 ถ้า body ต่างจากเดิม
 * tx แรก rollback => key ไม่ถูกจองไว้ request ที่รออยู่จึงสร้างต่อได้ ไม่มีออเดอร์ค้างครึ่งทาง
 */
async function createOrder({ idempotencyKey, input }) {
  const requestHash = hashRequest(input);

  return withTransaction(async (client) => {
    const reserved = await client.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (scope, key) DO NOTHING`,
      [IDEMPOTENCY_SCOPE, idempotencyKey, requestHash]
    );

    if (reserved.rowCount === 0) {
      const { rows } = await client.query(
        'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE scope = $1 AND key = $2',
        [IDEMPOTENCY_SCOPE, idempotencyKey]
      );
      const existing = rows[0];
      if (existing.request_hash !== requestHash) {
        throw unprocessable(
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key นี้ถูกใช้กับข้อมูลชุดอื่นแล้ว ใช้ key ใหม่สำหรับออเดอร์ใหม่'
        );
      }
      if (!existing.response_body) {
        throw conflict('IDEMPOTENCY_IN_PROGRESS', 'คำขอนี้กำลังถูกประมวลผลอยู่ ลองใหม่อีกครั้ง');
      }
      setContext({ orderNo: existing.response_body.data.orderNo });
      logger.info('idempotent replay');
      return { replayed: true, status: existing.response_status, body: existing.response_body };
    }

    const order = await insertOrder(client, input);
    setContext({ orderNo: order.order_no });

    await client.query(
      `INSERT INTO order_events (order_id, from_status, to_status, event_type, reason, actor)
       VALUES ($1, NULL, $2, 'ORDER_CREATED', 'สร้างออเดอร์', 'customer')`,
      [order.id, STATUS.PENDING_PAYMENT]
    );

    const body = { data: toOrderDto(order) };
    await client.query(
      `UPDATE idempotency_keys
          SET response_status = 201, response_body = $3::jsonb, order_id = $4
        WHERE scope = $1 AND key = $2`,
      [IDEMPOTENCY_SCOPE, idempotencyKey, JSON.stringify(body), order.id]
    );

    logger.info('order created', { status: order.status, amount: Number(order.amount) });
    return { replayed: false, status: 201, body };
  });
}

async function findOrderRow(orderNo, executor = { query }) {
  const { rows } = await executor.query('SELECT * FROM orders WHERE order_no = $1', [orderNo]);
  if (!rows[0]) throw notFound('ORDER_NOT_FOUND', `ไม่พบออเดอร์ ${orderNo}`);
  return rows[0];
}

async function getOrder(orderNo) {
  return toOrderDto(await findOrderRow(orderNo));
}

/** GET /orders?tab=current|history — ใหม่ -> เก่า, แบ่งหน้าแบบ offset */
async function listOrders({ tab, page, pageSize, customerRef }) {
  const statuses = tab === 'current' ? CURRENT_STATUSES : HISTORY_STATUSES;
  const params = [statuses];
  let where = 'status = ANY($1::text[])';
  if (customerRef) {
    params.push(customerRef);
    where += ` AND customer_ref = $${params.length}`;
  }

  const [rowsResult, countResult] = await Promise.all([
    query(
      `SELECT * FROM orders WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params
    ),
    query(`SELECT count(*)::int AS total FROM orders WHERE ${where}`, params),
  ]);

  const total = countResult.rows[0].total;
  return {
    data: rowsResult.rows.map(toOrderDto),
    pagination: { tab, page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

/** GET /orders/:orderNo/timeline */
async function getTimeline(orderNo) {
  const order = await findOrderRow(orderNo);
  const { rows } = await query(
    "SELECT * FROM order_events WHERE order_id = $1 AND event_type <> 'BOT_HEARTBEAT' ORDER BY created_at ASC, id ASC",
    [order.id]
  );
  return { orderNo: order.order_no, status: order.status, events: rows.map(toEventDto) };
}

/**
 * POST /orders/:orderNo/report-issue
 * ลูกค้าแจ้งปัญหา => บันทึกลง timeline + สร้าง alert ให้แอดมิน (ซ้ำ category/สถานะเดิมไม่สร้าง alert ซ้ำ)
 * ตั้งใจ "ไม่เปลี่ยนสถานะ": ถ้าให้ลูกค้ากดแล้วดึงออเดอร์ออกจากคิวเอง bot จะไม่ได้ทำงานต่อ
 * และ bot ที่ถือ lease อยู่จะถูกแย่งงานกลางคัน การตัดสินใจย้ายเป็น DELAYED เป็นหน้าที่แอดมิน/ระบบ
 */
async function reportIssue(orderNo, { category, message }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT id, status FROM orders WHERE order_no = $1 FOR SHARE', [orderNo]);
    if (!rows[0]) throw notFound('ORDER_NOT_FOUND', `ไม่พบออเดอร์ ${orderNo}`);
    const { id, status } = rows[0];

    const { rows: [event] } = await client.query(
      `INSERT INTO order_events (order_id, from_status, to_status, event_type, reason, actor, metadata)
       VALUES ($1, $2, $2, 'ISSUE_REPORTED', $3, 'customer', $4::jsonb)
       RETURNING created_at`,
      [id, status, message, JSON.stringify({ category })]
    );

    const alert = await client.query(
      `INSERT INTO alerts (order_id, type, severity, message, dedupe_key)
       VALUES ($1, 'CUSTOMER_REPORT', $2, $3, $4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [id, category === 'PAYMENT_PROBLEM' ? 'CRITICAL' : 'WARNING',
        `${orderNo} [${status}] ลูกค้าแจ้งปัญหา ${category}: ${message}`.slice(0, 500),
        `CUSTOMER_REPORT:${id}:${category}:${status}`]
    );

    logger.info('customer reported issue', { category, status, newAlert: alert.rowCount === 1 });
    return { orderNo, status, category, reportedAt: new Date(event.created_at).toISOString() };
  });
}

module.exports = { createOrder, getOrder, listOrders, getTimeline, reportIssue, hashRequest };
