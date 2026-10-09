const config = require('../config');
const { withTransaction } = require('../db');
const { setContext, logger } = require('../logger');
const { conflict, notFound } = require('../errors');
const { STATUS } = require('../domain/orderStatus');
const { applyTransition } = require('./orderTransitions');
const { retryOrDelay } = require('./retryService');

function toClaimDto(order, attemptNo) {
  return {
    orderNo: order.order_no,
    gameCode: order.game_code,
    gameUid: order.game_uid,
    packageCode: order.package_code,
    amount: Number(order.amount),
    currency: order.currency,
    attemptNo,
    leaseExpiresAt: new Date(order.lease_expires_at).toISOString(),
  };
}

async function claimOrder(botId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM orders
        WHERE status = $1
          AND (next_retry_at IS NULL OR next_retry_at <= now())
        ORDER BY queued_at NULLS LAST, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [STATUS.QUEUED]
    );
    if (!rows[0]) return null;

    const candidate = rows[0];
    const { rows: [lease] } = await client.query(
      'SELECT now() + make_interval(secs => $1::int) AS expires_at',
      [config.botLeaseSeconds]
    );
    const { rows: [attempt] } = await client.query(
      'SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no FROM fulfillment_attempts WHERE order_id = $1',
      [candidate.id]
    );

    const order = await applyTransition(client, {
      orderId: candidate.id,
      toStatus: STATUS.IN_PROGRESS,
      eventType: 'BOT_CLAIMED',
      actor: `bot:${botId}`,
      updates: { locked_by: botId, lease_expires_at: lease.expires_at },
      metadata: { botId, attemptNo: attempt.attempt_no },
    });
    await client.query(
      `INSERT INTO fulfillment_attempts (order_id, attempt_no, bot_id)
       VALUES ($1, $2, $3)`,
      [order.id, attempt.attempt_no, botId]
    );

    setContext({ orderNo: order.order_no });
    logger.info('order claimed by bot', { botId, attemptNo: attempt.attempt_no, version: order.version });
    return toClaimDto(order, attempt.attempt_no);
  });
}

async function lockOwnedOrder(client, orderNo, botId) {
  const { rows } = await client.query(
    `SELECT *, lease_expires_at > now() AS lease_active
       FROM orders WHERE order_no = $1 FOR UPDATE`,
    [orderNo]
  );
  const order = rows[0];
  if (!order) throw notFound('ORDER_NOT_FOUND', `ไม่พบออเดอร์ ${orderNo}`);
  if (order.status !== STATUS.IN_PROGRESS || order.locked_by !== botId || !order.lease_active) {
    throw conflict('BOT_LEASE_NOT_OWNED', 'bot ไม่ได้ถือ lease ที่ยังใช้งานได้สำหรับออเดอร์นี้');
  }
  setContext({ orderNo });
  return order;
}

async function recordHeartbeat(client, order, botId, leaseExpiresAt) {
  const updated = await client.query(
    `UPDATE orders
        SET lease_expires_at = $1, version = version + 1, updated_at = now()
      WHERE id = $2
      RETURNING version`,
    [leaseExpiresAt, order.id]
  );
  await client.query(
    `INSERT INTO order_events (order_id, from_status, to_status, event_type, actor, metadata)
     VALUES ($1, $2, $2, 'BOT_HEARTBEAT', $3, $4::jsonb)`,
    [order.id, order.status, `bot:${botId}`, JSON.stringify({ botId, version: updated.rows[0].version })]
  );
  return new Date(leaseExpiresAt).toISOString();
}

async function heartbeat(orderNo, botId) {
  return withTransaction(async (client) => {
    const order = await lockOwnedOrder(client, orderNo, botId);
    const { rows: [lease] } = await client.query(
      'SELECT now() + make_interval(secs => $1::int) AS expires_at',
      [config.botLeaseSeconds]
    );
    const leaseExpiresAt = await recordHeartbeat(client, order, botId, lease.expires_at);
    logger.info('bot heartbeat', { botId, leaseExpiresAt });
    return { orderNo, leaseExpiresAt };
  });
}

async function completeOrder(orderNo, botId) {
  return withTransaction(async (client) => {
    const order = await lockOwnedOrder(client, orderNo, botId);
    const { rows: [attempt] } = await client.query(
      `SELECT id FROM fulfillment_attempts
        WHERE order_id = $1 AND bot_id = $2 AND status = 'IN_FLIGHT'
        FOR UPDATE`,
      [order.id, botId]
    );
    if (!attempt) throw conflict('FULFILLMENT_ATTEMPT_NOT_FOUND', 'ไม่พบ attempt ที่กำลังทำงานของ bot นี้');

    const completed = await applyTransition(client, {
      orderId: order.id,
      toStatus: STATUS.COMPLETED,
      eventType: 'BOT_COMPLETED',
      actor: `bot:${botId}`,
      updates: { locked_by: null, lease_expires_at: null, completed_at: new Date() },
      metadata: { botId, attemptId: attempt.id },
    });
    await client.query(
      `UPDATE fulfillment_attempts SET status = 'SUCCEEDED', finished_at = now() WHERE id = $1`,
      [attempt.id]
    );

    logger.info('order completed by bot', { botId, version: completed.version });
    return { orderNo, status: completed.status, completedAt: new Date(completed.completed_at).toISOString() };
  });
}

async function failOrder(orderNo, botId, { errorType, errorCode, message }) {
  return withTransaction(async (client) => {
    const order = await lockOwnedOrder(client, orderNo, botId);
    const { rows: [attempt] } = await client.query(
      `SELECT id FROM fulfillment_attempts
        WHERE order_id = $1 AND bot_id = $2 AND status = 'IN_FLIGHT'
        FOR UPDATE`,
      [order.id, botId]
    );
    if (!attempt) throw conflict('FULFILLMENT_ATTEMPT_NOT_FOUND', 'ไม่พบ attempt ที่กำลังทำงานของ bot นี้');

    const metadata = { botId, attemptId: attempt.id, errorType, errorCode };
    let failed;
    if (errorType === 'TRANSIENT') {
      // เคส 1/4: ลองใหม่ได้ => backoff แบบ exponential ไม่เกิน maxRetries แล้วย้ายเป็น DELAYED
      ({ order: failed } = await retryOrDelay(client, order, {
        actor: `bot:${botId}`,
        eventType: 'BOT_FAILED',
        reason: message,
        error: { type: errorType, code: errorCode, message },
        metadata,
      }));
    } else {
      // เคส 4: PERMANENT (เช่น UID ผิด) ลองใหม่ไปก็ไม่หาย => FAILED ทันที ไม่นับ retry
      failed = await applyTransition(client, {
        orderId: order.id,
        toStatus: STATUS.FAILED,
        eventType: 'BOT_FAILED',
        actor: `bot:${botId}`,
        reason: message,
        updates: {
          locked_by: null,
          lease_expires_at: null,
          last_error_type: errorType,
          last_error_code: errorCode,
          last_error_message: message,
        },
        metadata,
      });
    }
    await client.query(
      `UPDATE fulfillment_attempts
          SET status = 'FAILED', error_type = $1, error_code = $2, error_message = $3, finished_at = now()
        WHERE id = $4`,
      [errorType, errorCode, message, attempt.id]
    );

    logger.warn('bot fulfillment failed', { botId, errorType, errorCode, status: failed.status });
    return { orderNo, status: failed.status };
  });
}

module.exports = { claimOrder, heartbeat, completeOrder, failOrder };
