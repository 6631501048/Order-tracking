/**
 * ทางออกของออเดอร์ที่ติดปัญหา (เคส 4 และทางออกของ DELAYED)
 *  - ลูกค้า:  แก้ UID แล้วลองใหม่ (FAILED -> QUEUED) / ขอคืนเงิน (FAILED|DELAYED -> REFUND_PENDING)
 *  - แอดมิน:  requeue (FAILED|DELAYED -> QUEUED) / ยืนยันคืนเงิน (REFUND_PENDING -> REFUNDED)
 * ทุกอย่างล็อกแถวก่อน (FOR UPDATE) แล้วเช็กสถานะ => สองคำขอพร้อมกัน สำเร็จได้แค่อันเดียว
 */
const { query, withTransaction } = require('../db');
const { logger, setContext } = require('../logger');
const { notFound, conflict, unprocessable } = require('../errors');
const { STATUS } = require('../domain/orderStatus');
const { toOrderDto } = require('../mappers');
const { applyTransition } = require('./orderTransitions');
const { createAlert } = require('./alertService');
const { dbNowPlus } = require('./dbTime');

const CLEAR_ERROR = { last_error_type: null, last_error_code: null, last_error_message: null };

async function lockOrder(client, orderNo) {
  const { rows: [order] } = await client.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [orderNo]);
  if (!order) throw notFound('ORDER_NOT_FOUND', `ไม่พบออเดอร์ ${orderNo}`);
  setContext({ orderNo });
  return order;
}

/** เคส 4: UID ผิด => ลูกค้าแก้แล้วกลับเข้าคิวใหม่ (นับ retry ใหม่ตั้งแต่ศูนย์) */
async function updateUidAndRetry(orderNo, gameUid) {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, orderNo);
    if (order.status !== STATUS.FAILED) {
      throw conflict('UID_UPDATE_NOT_ALLOWED', `แก้ UID ได้เฉพาะออเดอร์ที่สถานะ FAILED (ตอนนี้ ${order.status})`, { status: order.status });
    }
    if (order.game_uid === gameUid) {
      throw unprocessable('UID_UNCHANGED', 'UID ใหม่ต้องต่างจาก UID เดิม');
    }
    const now = await dbNowPlus(client, 0);
    const updated = await applyTransition(client, {
      orderId: order.id,
      toStatus: STATUS.QUEUED,
      eventType: 'UID_UPDATED',
      actor: 'customer',
      reason: 'ลูกค้าแก้ UID และขอให้ลองใหม่',
      metadata: { previousUid: order.game_uid, newUid: gameUid, previousError: order.last_error_code },
      updates: { game_uid: gameUid, retry_count: 0, next_retry_at: null, queued_at: now, ...CLEAR_ERROR },
    });
    logger.info('uid updated, order re-queued', { previousError: order.last_error_code });
    return toOrderDto(updated);
  });
}

/** เคส 4: ไม่ลองใหม่แล้ว ขอคืนเงินแทน */
async function requestRefund(orderNo) {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, orderNo);
    if (![STATUS.FAILED, STATUS.DELAYED].includes(order.status)) {
      throw conflict('REFUND_NOT_ALLOWED', `ขอคืนเงินได้เฉพาะออเดอร์ที่ FAILED หรือ DELAYED (ตอนนี้ ${order.status})`, { status: order.status });
    }
    const updated = await applyTransition(client, {
      orderId: order.id,
      toStatus: STATUS.REFUND_PENDING,
      eventType: 'REFUND_REQUESTED',
      actor: 'customer',
      reason: 'ลูกค้าขอคืนเงิน',
      metadata: { fromStatus: order.status },
    });
    await createAlert(client, {
      orderId: order.id,
      type: 'REFUND_REQUESTED',
      severity: 'WARNING',
      message: `${orderNo} ลูกค้าขอคืนเงิน ${order.amount} ${order.currency} (สถานะเดิม ${order.status})`,
      dedupeKey: `REFUND_REQUESTED:${order.id}`,
    });
    logger.info('refund requested', { fromStatus: order.status });
    return toOrderDto(updated);
  });
}

/** แอดมินสั่งกลับเข้าคิว (ออเดอร์ DELAYED หลัง retry ครบ หรือ FAILED ที่ตรวจแล้วว่าลองได้) */
async function adminRequeue(orderNo) {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, orderNo);
    if (![STATUS.DELAYED, STATUS.FAILED].includes(order.status)) {
      throw conflict('REQUEUE_NOT_ALLOWED', `requeue ได้เฉพาะออเดอร์ที่ DELAYED หรือ FAILED (ตอนนี้ ${order.status})`, { status: order.status });
    }
    const now = await dbNowPlus(client, 0);
    const updated = await applyTransition(client, {
      orderId: order.id,
      toStatus: STATUS.QUEUED,
      eventType: 'ADMIN_REQUEUED',
      actor: 'admin',
      reason: 'แอดมินสั่งลองใหม่',
      metadata: { fromStatus: order.status, previousError: order.last_error_code },
      updates: { retry_count: 0, next_retry_at: null, queued_at: now, ...CLEAR_ERROR },
    });
    logger.info('order re-queued by admin', { fromStatus: order.status });
    return toOrderDto(updated);
  });
}

/** แอดมินยืนยันว่าคืนเงินแล้ว (ระบบนี้ไม่ได้โอนเงินเอง) */
async function adminConfirmRefund(orderNo) {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, orderNo);
    if (order.status !== STATUS.REFUND_PENDING) {
      throw conflict('REFUND_NOT_PENDING', `ยืนยันคืนเงินได้เฉพาะออเดอร์ที่ REFUND_PENDING (ตอนนี้ ${order.status})`, { status: order.status });
    }
    const updated = await applyTransition(client, {
      orderId: order.id,
      toStatus: STATUS.REFUNDED,
      eventType: 'REFUND_COMPLETED',
      actor: 'admin',
      reason: 'แอดมินยืนยันว่าคืนเงินแล้ว',
    });
    logger.info('refund confirmed by admin');
    return toOrderDto(updated);
  });
}

const alertDto = (r) => ({
  id: Number(r.id),
  orderNo: r.order_no,
  type: r.type,
  severity: r.severity,
  message: r.message,
  createdAt: new Date(r.created_at).toISOString(),
  acknowledgedAt: r.acknowledged_at ? new Date(r.acknowledged_at).toISOString() : null,
});

async function listAlerts({ status, limit }) {
  const { rows } = await query(
    `SELECT a.*, o.order_no FROM alerts a LEFT JOIN orders o ON o.id = a.order_id
      WHERE ($1::boolean OR a.acknowledged_at IS NULL)
      ORDER BY a.created_at DESC, a.id DESC LIMIT $2`,
    [status === 'all', limit]
  );
  return rows.map(alertDto);
}

/** รับทราบ alert — กดซ้ำได้ (idempotent) */
async function acknowledgeAlert(alertId) {
  const { rows: [updated] } = await query(
    `UPDATE alerts SET acknowledged_at = COALESCE(acknowledged_at, now()) WHERE id = $1 RETURNING id`,
    [alertId]
  );
  if (!updated) throw notFound('ALERT_NOT_FOUND', `ไม่พบ alert ${alertId}`);
  const { rows: [row] } = await query(
    'SELECT a.*, o.order_no FROM alerts a LEFT JOIN orders o ON o.id = a.order_id WHERE a.id = $1', [alertId]
  );
  return alertDto(row);
}

module.exports = { updateUidAndRetry, requestRefund, adminRequeue, adminConfirmRefund, listAlerts, acknowledgeAlert };
