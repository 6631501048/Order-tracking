/**
 * งานเบื้องหลัง (เคส 1 และ 5) — ทุกงาน "รันซ้ำได้โดยไม่เสียหาย" (idempotent) เพราะ
 *  - เลือกเฉพาะแถวที่ "ยังเข้าเงื่อนไข" ตอนนี้ แล้วเช็กเงื่อนไขซ้ำหลังล็อกแถว (FOR UPDATE SKIP LOCKED)
 *    => รันซ้ำ/รันพร้อมกันหลายตัว แถวที่จัดการแล้วจะไม่เข้าเงื่อนไขอีก และไม่มีใครแย่งล็อกเดียวกัน
 *  - alert ใช้ dedupe_key unique
 *  - แต่ละออเดอร์ใช้ transaction ของตัวเอง ออเดอร์หนึ่งพังไม่ลากตัวอื่นไปด้วย
 */
const config = require('../config');
const { query, withTransaction } = require('../db');
const { logger, runWithContext } = require('../logger');
const { STATUS } = require('../domain/orderStatus');
const { applyTransition } = require('./orderTransitions');
const { retryOrDelay } = require('./retryService');

const DEFAULT_BATCH = 100;

async function forEachOrder(candidateRows, handler, jobName) {
  const summary = { processed: 0, skipped: 0, failed: 0 };
  for (const { id } of candidateRows) {
    try {
      const done = await withTransaction((client) => handler(client, id));
      if (done) summary.processed += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.failed += 1;
      logger.error(`${jobName} failed for order`, { orderId: id, err });
    }
  }
  return summary;
}

/** เคส 5: PENDING_PAYMENT ที่เกินเวลาจ่าย => EXPIRED */
async function expirePendingPayments({ limit = DEFAULT_BATCH } = {}) {
  const { rows } = await query(
    `SELECT id FROM orders
      WHERE status = $1 AND payment_expires_at <= now()
      ORDER BY payment_expires_at LIMIT $2`,
    [STATUS.PENDING_PAYMENT, limit]
  );
  return forEachOrder(rows, async (client, id) => {
    const { rows: [order] } = await client.query(
      `SELECT * FROM orders
        WHERE id = $1 AND status = $2 AND payment_expires_at <= now()
        FOR UPDATE SKIP LOCKED`,
      [id, STATUS.PENDING_PAYMENT]
    );
    if (!order) return false; // มีคนจัดการไปแล้ว (เช่น webhook จ่ายเงินเข้ามาก่อน)
    return runWithContext({ orderNo: order.order_no, job: 'expire-payments' }, async () => {
      await applyTransition(client, {
        orderId: order.id,
        toStatus: STATUS.EXPIRED,
        eventType: 'PAYMENT_EXPIRED',
        actor: 'scheduler',
        reason: 'เกินเวลาที่กำหนดให้ชำระเงิน',
      });
      logger.info('order expired (payment timeout)');
      return true;
    });
  }, 'expirePendingPayments');
}

/**
 * เคส 1: bot ล่ม/เงียบ (lease หมดอายุ) => ดึงงานคืน
 * ปิด attempt เดิมเป็น ABANDONED ก่อน (ไม่งั้น partial unique index ของ IN_FLIGHT จะบล็อกการ claim รอบถัดไป)
 * แล้วส่งเข้านโยบาย retry: backoff หรือ DELAYED + alert
 */
async function reclaimExpiredLeases({ limit = DEFAULT_BATCH } = {}) {
  const { rows } = await query(
    `SELECT id FROM orders
      WHERE status = $1 AND lease_expires_at <= now()
      ORDER BY lease_expires_at LIMIT $2`,
    [STATUS.IN_PROGRESS, limit]
  );
  return forEachOrder(rows, async (client, id) => {
    const { rows: [order] } = await client.query(
      `SELECT * FROM orders
        WHERE id = $1 AND status = $2 AND lease_expires_at <= now()
        FOR UPDATE SKIP LOCKED`,
      [id, STATUS.IN_PROGRESS]
    );
    if (!order) return false; // bot ส่ง heartbeat/complete ทันก่อน หรือมีตัวอื่นดึงคืนไปแล้ว
    return runWithContext({ orderNo: order.order_no, job: 'reclaim-leases' }, async () => {
      const error = {
        type: 'TRANSIENT',
        code: 'BOT_LEASE_EXPIRED',
        message: 'bot ไม่ส่ง heartbeat ภายในเวลาที่กำหนด (อาจล่มหรือค้าง)',
      };
      await client.query(
        `UPDATE fulfillment_attempts
            SET status = 'ABANDONED', error_type = $2, error_code = $3, error_message = $4, finished_at = now()
          WHERE order_id = $1 AND status = 'IN_FLIGHT'`,
        [order.id, error.type, error.code, error.message]
      );
      await retryOrDelay(client, order, {
        actor: 'scheduler',
        eventType: 'LEASE_EXPIRED',
        reason: error.message,
        error,
        metadata: { previousBot: order.locked_by },
      });
      return true;
    });
  }, 'reclaimExpiredLeases');
}

/**
 * เคส 5: QUEUED นานเกิน SLA => alert (ไม่ย้ายสถานะ เพราะออเดอร์ยังอยู่ในคิวปกติ แค่ให้คนดู)
 * คำสั่งเดียว + dedupe_key (ผูกกับ queued_at) => รันกี่รอบก็ได้ alert เดียวต่อรอบที่เข้าคิว
 */
async function alertStaleQueue() {
  const { rowCount } = await query(
    `INSERT INTO alerts (order_id, type, severity, message, dedupe_key)
     SELECT id, 'QUEUE_SLA_BREACH', 'WARNING',
            order_no || ' อยู่ในคิวนานเกิน ' || $1::int::text || ' วินาที ยังไม่มี bot รับงาน',
            'QUEUE_SLA_BREACH:' || id || ':' || extract(epoch from COALESCE(queued_at, created_at))::bigint
       FROM orders
      WHERE status = $2
        AND COALESCE(queued_at, created_at) <= now() - make_interval(secs => $1::int)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [config.queueSlaSeconds, STATUS.QUEUED]
  );
  if (rowCount > 0) logger.warn('queue SLA breached', { newAlerts: rowCount });
  return { created: rowCount };
}

/** รันงานทั้งหมดหนึ่งรอบ (ใช้ทั้งจาก loop และ endpoint ของแอดมิน) */
async function runSchedulerOnce() {
  const expired = await expirePendingPayments();
  const reclaimed = await reclaimExpiredLeases();
  const stale = await alertStaleQueue();
  const result = { expiredPayments: expired, reclaimedLeases: reclaimed, queueSlaAlerts: stale };
  const worked = expired.processed + reclaimed.processed + stale.created + expired.failed + reclaimed.failed;
  logger[worked > 0 ? 'info' : 'debug']('scheduler run finished', result);
  return result;
}

module.exports = { expirePendingPayments, reclaimExpiredLeases, alertStaleQueue, runSchedulerOnce };
