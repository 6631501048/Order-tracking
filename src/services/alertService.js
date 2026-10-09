const { logger } = require('../logger');

/**
 * สร้าง alert ให้แอดมิน — dedupe_key unique ทำให้เรียกซ้ำได้ไม่เกิด alert ซ้ำ
 * (ทำให้ scheduler / webhook retry รันซ้ำได้โดยไม่เสียหาย)
 * @returns {Promise<boolean>} true = สร้างใหม่, false = มีอยู่แล้ว
 */
async function createAlert(client, { orderId = null, type, severity = 'WARNING', message, dedupeKey }) {
  const { rowCount } = await client.query(
    `INSERT INTO alerts (order_id, type, severity, message, dedupe_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [orderId, type, severity, String(message).slice(0, 500), dedupeKey]
  );
  if (rowCount === 1) logger.warn('alert created', { alertType: type, severity });
  return rowCount === 1;
}

module.exports = { createAlert };
