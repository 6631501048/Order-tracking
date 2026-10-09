/**
 * ตัดสินใจว่าจะทำอะไรกับ webhook "จ่ายเงินสำเร็จ" (เคส 3) — ฟังก์ชันล้วน ไม่แตะ DB
 * เทียบ "สถานะปัจจุบันของออเดอร์" ก่อนเปลี่ยนสถานะเสมอ จึงทนทั้ง webhook ซ้ำ มาช้า และมาผิดลำดับ
 *
 * @returns {{ outcome: string, transition?: {to, eventType, reason}, alert?: {type, severity, message} }}
 */
const { STATUS } = require('./orderStatus');

const cents = (n) => Math.round(Number(n) * 100);

function decidePaymentAction(order, event, { refOwnerOrderId = null } = {}) {
  if (!order) {
    return {
      outcome: 'UNKNOWN_ORDER',
      alert: {
        type: 'PAYMENT_UNKNOWN_ORDER', severity: 'CRITICAL',
        message: `ได้รับเงิน ${event.amount} ${event.currency} (ref ${event.paymentRef}) สำหรับออเดอร์ที่ไม่มีในระบบ ${event.orderNo}`,
      },
    };
  }

  // เลขอ้างอิงการจ่ายนี้เคยผูกกับออเดอร์อื่นไปแล้ว => ห้ามผูกซ้ำ (unique index จะ error และ webhook จะถูก retry ไม่จบ)
  // เทียบเป็น string: pg คืน BIGINT/BIGSERIAL เป็น string ส่วนค่าอื่นอาจเป็น number
  if (refOwnerOrderId !== null && String(refOwnerOrderId) !== String(order.id)) {
    return {
      outcome: 'PAYMENT_REF_REUSED',
      alert: {
        type: 'PAYMENT_REF_REUSED', severity: 'CRITICAL',
        message: `${order.order_no}: paymentRef ${event.paymentRef} ถูกใช้กับออเดอร์อื่นแล้ว ต้องตรวจสอบด้วยมือ`,
      },
    };
  }

  if (cents(order.amount) !== cents(event.amount) || order.currency !== event.currency) {
    return {
      outcome: 'AMOUNT_MISMATCH',
      alert: {
        type: 'PAYMENT_AMOUNT_MISMATCH', severity: 'CRITICAL',
        message: `${order.order_no}: ยอดเงินไม่ตรง ออเดอร์ ${order.amount} ${order.currency} แต่ได้รับ ${event.amount} ${event.currency}`,
      },
    };
  }

  // การจ่ายเดิม (paymentRef เดียวกัน) ที่ส่งมาใหม่ภายใต้ event id ใหม่ => ไม่มีอะไรต้องทำ
  if (order.payment_ref && order.payment_ref === event.paymentRef) {
    return { outcome: 'IGNORED_ALREADY_PAID' };
  }

  switch (order.status) {
    case STATUS.PENDING_PAYMENT:
      return {
        outcome: 'APPLIED',
        transition: { to: STATUS.QUEUED, eventType: 'PAYMENT_CONFIRMED', reason: 'ได้รับการชำระเงิน เข้าคิวรอ bot' },
      };

    case STATUS.EXPIRED:
      // มาช้าจนหมดอายุแล้ว: ไม่ฟื้นออเดอร์ (ราคา/สต็อกอาจเปลี่ยน) แต่ตั้งคืนเงิน และเตือนแอดมิน
      return {
        outcome: 'LATE_PAYMENT_REFUND',
        transition: { to: STATUS.REFUND_PENDING, eventType: 'LATE_PAYMENT_RECEIVED', reason: 'ชำระเงินหลังออเดอร์หมดอายุ ตั้งรอคืนเงิน' },
        alert: {
          type: 'LATE_PAYMENT', severity: 'WARNING',
          message: `${order.order_no}: ได้รับเงินหลังออเดอร์หมดอายุ ต้องคืนเงิน ${event.amount} ${event.currency}`,
        },
      };

    default:
      // ออเดอร์จ่ายเงินไปแล้ว (อยู่ในคิว/กำลังทำ/จบ/คืนเงิน ฯลฯ) แต่มีเงินเข้าอีกก้อน = จ่ายซ้ำจริง
      return {
        outcome: 'DUPLICATE_PAYMENT',
        alert: {
          type: 'DUPLICATE_PAYMENT', severity: 'CRITICAL',
          message: `${order.order_no} [${order.status}] ได้รับเงินซ้ำอีก ${event.amount} ${event.currency} (ref ${event.paymentRef}) ต้องคืนเงินส่วนเกิน`,
        },
      };
  }
}

module.exports = { decidePaymentAction };
