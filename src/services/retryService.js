const config = require('../config');
const { STATUS } = require('../domain/orderStatus');
const { decideRetry } = require('../domain/retryPolicy');
const { logger } = require('../logger');
const { applyTransition } = require('./orderTransitions');
const { createAlert } = require('./alertService');
const { dbNowPlus } = require('./dbTime');

/**
 * ตัดสินว่าออเดอร์ที่ "ทำไม่สำเร็จแบบลองใหม่ได้" ควรกลับเข้าคิว (หน่วง exponential) หรือยอมแพ้ => DELAYED + alert
 * ใช้ร่วมกันทั้งกรณี bot รายงาน TRANSIENT error และกรณี lease หมดอายุ (bot เงียบ/ล่ม)
 * เรียกภายใน transaction ที่ถือ lock ของแถวออเดอร์อยู่แล้ว (status ต้องเป็น IN_PROGRESS)
 */
async function retryOrDelay(client, order, { actor, eventType, reason, error, metadata = {} }) {
  const decision = decideRetry(order.retry_count, {
    maxRetries: config.maxRetries,
    baseSeconds: config.retryBaseSeconds,
    maxDelaySeconds: config.retryMaxDelaySeconds,
  });

  const errorFields = {
    last_error_type: error.type,
    last_error_code: error.code,
    last_error_message: error.message,
  };

  if (decision.action === 'RETRY') {
    const nextRetryAt = await dbNowPlus(client, decision.delaySeconds);
    const updated = await applyTransition(client, {
      orderId: order.id,
      toStatus: STATUS.QUEUED,
      eventType,
      actor,
      reason,
      metadata: { ...metadata, retryCount: decision.retryCount, delaySeconds: decision.delaySeconds, errorCode: error.code },
      updates: {
        locked_by: null,
        lease_expires_at: null,
        retry_count: decision.retryCount,
        next_retry_at: nextRetryAt,
        ...errorFields,
      },
    });
    logger.info('order re-queued with backoff', {
      retryCount: decision.retryCount, delaySeconds: decision.delaySeconds, errorCode: error.code,
    });
    return { action: 'RETRY', order: updated, ...decision };
  }

  const updated = await applyTransition(client, {
    orderId: order.id,
    toStatus: STATUS.DELAYED,
    eventType: 'RETRIES_EXHAUSTED',
    actor,
    reason: `ลองใหม่ครบ ${config.maxRetries} ครั้งแล้วยังไม่สำเร็จ: ${reason || error.message}`,
    metadata: { ...metadata, retryCount: order.retry_count, errorCode: error.code, triggeredBy: eventType },
    updates: { locked_by: null, lease_expires_at: null, next_retry_at: null, ...errorFields },
  });
  await createAlert(client, {
    orderId: order.id,
    type: 'BOT_RETRY_EXHAUSTED',
    severity: 'CRITICAL',
    message: `${order.order_no} ลองใหม่ครบ ${config.maxRetries} ครั้งแล้วยังไม่สำเร็จ (${error.code}) ย้ายเป็น DELAYED รอตรวจสอบ`,
    dedupeKey: `BOT_RETRY_EXHAUSTED:${order.id}:${order.version}`,
  });
  logger.warn('retries exhausted, order delayed', { retryCount: order.retry_count, errorCode: error.code });
  return { action: 'GIVE_UP', order: updated, retryCount: order.retry_count };
}

module.exports = { retryOrDelay };
