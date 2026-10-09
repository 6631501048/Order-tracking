const config = require('../config');
const { withTransaction } = require('../db');
const { logger } = require('../logger');
const { STATUS } = require('../domain/orderStatus');
const { applyTransition } = require('./orderTransitions');

async function recoverExpiredLeases(batchSize = 50) {
  return withTransaction(async (client) => {
    const { rows: expiredOrders } = await client.query(
      `SELECT * FROM orders
        WHERE status = $1 AND lease_expires_at <= now()
        ORDER BY lease_expires_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [STATUS.IN_PROGRESS, batchSize]
    );

    for (const expired of expiredOrders) {
      const retryCount = expired.retry_count + 1;
      const exhausted = expired.retry_count >= config.maxFulfillmentRetries;
      const nextStatus = exhausted ? STATUS.DELAYED : STATUS.QUEUED;
      const errorMessage = 'Bot lease expired before fulfillment completed';
      const updates = {
        locked_by: null,
        lease_expires_at: null,
        retry_count: retryCount,
        last_error_type: 'TRANSIENT',
        last_error_code: 'LEASE_EXPIRED',
        last_error_message: errorMessage,
        next_retry_at: null,
      };
      if (!exhausted) {
        const delaySeconds = config.retryBaseSeconds * (2 ** (retryCount - 1));
        const { rows: [retry] } = await client.query(
          'SELECT now() + make_interval(secs => $1::int) AS next_retry_at',
          [delaySeconds]
        );
        updates.next_retry_at = retry.next_retry_at;
        updates.queued_at = new Date();
      }

      const updated = await applyTransition(client, {
        orderId: expired.id,
        toStatus: nextStatus,
        eventType: 'LEASE_EXPIRED',
        actor: 'scheduler',
        reason: errorMessage,
        updates,
        metadata: { botId: expired.locked_by, retryCount, retryExhausted: exhausted },
      });

      await client.query(
        `UPDATE fulfillment_attempts
            SET status = 'ABANDONED', error_type = 'TRANSIENT', error_code = 'LEASE_EXPIRED',
                error_message = $1, finished_at = now()
          WHERE order_id = $2 AND status = 'IN_FLIGHT'`,
        [errorMessage, expired.id]
      );

      if (exhausted) {
        await client.query(
          `INSERT INTO alerts (order_id, type, severity, message, dedupe_key)
           VALUES ($1, 'BOT_RETRY_EXHAUSTED', 'CRITICAL', $2, $3)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [
            expired.id,
            `${expired.order_no} exceeded ${config.maxFulfillmentRetries} fulfillment retries after lease expiry`,
            `BOT_RETRY_EXHAUSTED:${expired.id}`,
          ]
        );
      }

      logger.warn('expired bot lease recovered', {
        status: updated.status,
        retryCount: updated.retry_count,
        nextRetryAt: updated.next_retry_at,
      });
    }

    return { recovered: expiredOrders.length };
  });
}

module.exports = { recoverExpiredLeases };
