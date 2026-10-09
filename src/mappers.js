/** แปลง row จาก DB เป็น JSON ที่เปิดเผยกับลูกค้า (ไม่รวม version / locked_by / retry_count ที่เป็นเรื่องภายใน) */
const iso = (d) => (d ? new Date(d).toISOString() : null);

function toOrderDto(row) {
  const dto = {
    orderNo: row.order_no,
    status: row.status,
    customerRef: row.customer_ref,
    gameCode: row.game_code,
    gameUid: row.game_uid,
    packageCode: row.package_code,
    amount: Number(row.amount),
    currency: row.currency,
    paymentExpiresAt: iso(row.payment_expires_at),
    paidAt: iso(row.paid_at),
    queuedAt: iso(row.queued_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (row.last_error_code) {
    dto.issue = { code: row.last_error_code, message: row.last_error_message };
  }
  return dto;
}

function toEventDto(row) {
  return {
    fromStatus: row.from_status,
    toStatus: row.to_status,
    eventType: row.event_type,
    reason: row.reason,
    actor: row.actor,
    createdAt: iso(row.created_at),
  };
}

module.exports = { toOrderDto, toEventDto };
