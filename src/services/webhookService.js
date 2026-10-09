/**
 * Webhook การจ่ายเงินจากธนาคาร (เคส 3)
 *
 * ความปลอดภัยของการประมวลผลซ้ำ/มาช้า/มาผิดลำดับ ทำจาก 3 ชั้น:
 *  1) event id  : จอง event_id ด้วย INSERT ... ON CONFLICT DO NOTHING ใน transaction เดียวกับการเปลี่ยนสถานะ
 *                 ชนกัน => no-op (ถ้ามาพร้อมกัน รอจน tx แรก commit); ประมวลผลพัง => rollback ทั้งก้อน
 *                 event ไม่ถูกจดว่าประมวลผลแล้ว ธนาคารส่งซ้ำมาจึงทำต่อได้
 *  2) state     : ล็อกแถวออเดอร์แล้วเทียบสถานะ "ตอนนี้" ก่อนเสมอ (decidePaymentAction)
 *  3) DB        : unique index ของ payment_ref กันผูกเลขอ้างอิงซ้ำเป็นด่านสุดท้าย
 * ทุกกรณีที่ "ประมวลผลแล้ว" ตอบ 200 เพื่อให้ธนาคารหยุด retry (รวมกรณีผิดปกติที่ส่ง alert หาแอดมิน)
 */
const { withTransaction } = require('../db');
const { logger, setContext } = require('../logger');
const { PAYMENT_SUCCEEDED, validateWebhookEnvelope, validatePaymentSucceeded } = require('../validators');
const { decidePaymentAction } = require('../domain/paymentPolicy');
const { applyTransition } = require('./orderTransitions');
const { createAlert } = require('./alertService');
const { dbNowPlus } = require('./dbTime');

const PROVIDER = 'bank';

async function processPaymentWebhook(body) {
  const envelope = validateWebhookEnvelope(body);
  // ตรวจ payload เต็มก่อนเปิด transaction (ผิด => 400 และไม่จด event ไว้ ให้ส่งใหม่ที่ถูกต้องได้)
  const event = envelope.type === PAYMENT_SUCCEEDED ? validatePaymentSucceeded(body) : null;
  if (event) setContext({ orderNo: event.orderNo });

  return withTransaction(async (client) => {
    const reserved = await client.query(
      `INSERT INTO processed_webhooks (event_id, provider, event_type, outcome, payload)
       VALUES ($1, $2, $3, 'PROCESSING', $4::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [envelope.eventId, PROVIDER, envelope.type, JSON.stringify(body)]
    );
    if (reserved.rowCount === 0) {
      const { rows: [previous] } = await client.query(
        'SELECT outcome FROM processed_webhooks WHERE event_id = $1', [envelope.eventId]
      );
      logger.info('duplicate webhook ignored', { eventId: envelope.eventId, previousOutcome: previous.outcome });
      return { eventId: envelope.eventId, outcome: 'DUPLICATE_EVENT', previousOutcome: previous.outcome };
    }

    if (!event) {
      await finish(client, envelope.eventId, null, 'IGNORED_UNSUPPORTED_TYPE');
      logger.info('unsupported webhook type ignored', { eventId: envelope.eventId, type: envelope.type });
      return { eventId: envelope.eventId, outcome: 'IGNORED_UNSUPPORTED_TYPE' };
    }

    const { rows: [order] } = await client.query(
      'SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [event.orderNo]
    );
    const { rows: [refOwner] } = await client.query(
      'SELECT id FROM orders WHERE payment_ref = $1', [event.paymentRef]
    );

    const decision = decidePaymentAction(order, event, { refOwnerOrderId: refOwner ? refOwner.id : null });

    if (decision.transition) {
      const paidAt = await dbNowPlus(client, 0);
      const updates = { paid_at: paidAt, payment_ref: event.paymentRef };
      if (decision.transition.to === 'QUEUED') updates.queued_at = paidAt;
      await applyTransition(client, {
        orderId: order.id,
        toStatus: decision.transition.to,
        eventType: decision.transition.eventType,
        actor: 'webhook',
        reason: decision.transition.reason,
        metadata: { eventId: event.eventId, paymentRef: event.paymentRef, amount: event.amount },
        updates,
      });
    }
    if (decision.alert) {
      await createAlert(client, {
        orderId: order ? order.id : null,
        ...decision.alert,
        dedupeKey: `${decision.alert.type}:${event.eventId}`,
      });
    }

    await finish(client, envelope.eventId, order ? order.id : null, decision.outcome);
    logger.info('payment webhook processed', { eventId: event.eventId, outcome: decision.outcome });
    return { eventId: event.eventId, outcome: decision.outcome };
  });
}

function finish(client, eventId, orderId, outcome) {
  return client.query(
    'UPDATE processed_webhooks SET outcome = $2, order_id = $3, processed_at = now() WHERE event_id = $1',
    [eventId, outcome, orderId]
  );
}

module.exports = { processPaymentWebhook };
