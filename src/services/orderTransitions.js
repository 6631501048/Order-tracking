const { assertTransition } = require('../domain/orderStatus');

const UPDATE_COLUMNS = Object.freeze({
  locked_by: 'locked_by',
  lease_expires_at: 'lease_expires_at',
  queued_at: 'queued_at',
  completed_at: 'completed_at',
  retry_count: 'retry_count',
  next_retry_at: 'next_retry_at',
  last_error_type: 'last_error_type',
  last_error_code: 'last_error_code',
  last_error_message: 'last_error_message',
  paid_at: 'paid_at',
  payment_ref: 'payment_ref',
  game_uid: 'game_uid',
});

/**
 * เปลี่ยนสถานะพร้อมบันทึก event ใน transaction เดียวกัน
 * ผู้เรียกต้องส่ง transaction client จาก withTransaction()
 */
async function applyTransition(client, {
  orderId,
  toStatus,
  eventType,
  actor,
  reason = null,
  metadata = {},
  updates = {},
}) {
  const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  const order = rows[0];
  if (!order) throw new Error(`Order ${orderId} disappeared during transition`);

  assertTransition(order.status, toStatus);

  const assignments = ['status = $1', 'version = version + 1', 'updated_at = now()'];
  const values = [toStatus];
  for (const [column, value] of Object.entries(updates)) {
    const safeColumn = UPDATE_COLUMNS[column];
    if (!safeColumn) throw new Error(`Unsupported order update column: ${column}`);
    values.push(value);
    assignments.push(`${safeColumn} = $${values.length}`);
  }

  values.push(orderId);
  const updated = await client.query(
    `UPDATE orders SET ${assignments.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  const nextOrder = updated.rows[0];

  await client.query(
    `INSERT INTO order_events (order_id, from_status, to_status, event_type, reason, actor, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [orderId, order.status, toStatus, eventType, reason, actor, JSON.stringify(metadata)]
  );

  return nextOrder;
}

module.exports = { applyTransition };
