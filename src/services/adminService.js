const { withTransaction } = require('../db');
const { setContext, logger } = require('../logger');
const { conflict, notFound } = require('../errors');
const { STATUS } = require('../domain/orderStatus');
const { applyTransition } = require('./orderTransitions');

async function updateUidAndRetry(orderNo, gameUid) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT id, status FROM orders WHERE order_no = $1 FOR UPDATE', [orderNo]);
    const current = rows[0];
    if (!current) throw notFound('ORDER_NOT_FOUND', `ไม่พบออเดอร์ ${orderNo}`);
    if (![STATUS.FAILED, STATUS.DELAYED].includes(current.status)) {
      throw conflict('ORDER_NOT_RETRYABLE', `ไม่สามารถแก้ UID และลองใหม่จากสถานะ ${current.status}`);
    }

    const order = await applyTransition(client, {
      orderId: current.id,
      toStatus: STATUS.QUEUED,
      eventType: 'ADMIN_UID_CORRECTED_AND_REQUEUED',
      actor: 'admin',
      reason: 'ผู้ดูแลแก้ UID และส่งออเดอร์เข้าคิวอีกครั้ง',
      updates: {
        game_uid: gameUid,
        retry_count: 0,
        next_retry_at: null,
        queued_at: new Date(),
        last_error_type: null,
        last_error_code: null,
        last_error_message: null,
      },
      metadata: { previousStatus: current.status },
    });
    setContext({ orderNo });
    logger.info('admin corrected UID and requeued order', { previousStatus: current.status, version: order.version });

    return { orderNo: order.order_no, status: order.status, gameUid: order.game_uid };
  });
}

module.exports = { updateUidAndRetry };
