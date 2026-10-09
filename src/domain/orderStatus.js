/**
 * State machine ของออเดอร์ — ฟังก์ชันล้วน ไม่แตะ DB (เทสต์ง่าย)
 * ทุกที่ที่เปลี่ยนสถานะต้องผ่าน assertTransition() เสมอ
 *
 * ปกติ:   PENDING_PAYMENT -> QUEUED -> IN_PROGRESS -> COMPLETED
 * มีปัญหา: DELAYED / FAILED / EXPIRED / REFUND_PENDING / REFUNDED
 */
const STATUS = Object.freeze({
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  QUEUED: 'QUEUED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  DELAYED: 'DELAYED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  REFUND_PENDING: 'REFUND_PENDING',
  REFUNDED: 'REFUNDED',
});

const S = STATUS;

/** จาก -> [ไปได้] พร้อมสาเหตุที่อนุญาต (ไว้ทำเอกสาร/ข้อความ error) */
const TRANSITIONS = Object.freeze({
  [S.PENDING_PAYMENT]: [S.QUEUED, S.EXPIRED],
  [S.QUEUED]: [S.IN_PROGRESS, S.DELAYED],
  [S.IN_PROGRESS]: [S.COMPLETED, S.QUEUED, S.DELAYED, S.FAILED],
  [S.DELAYED]: [S.QUEUED, S.FAILED, S.REFUND_PENDING],
  [S.FAILED]: [S.QUEUED, S.REFUND_PENDING],
  [S.EXPIRED]: [S.REFUND_PENDING], // จ่ายเงินมาช้าหลังหมดอายุ (เคส 3)
  [S.REFUND_PENDING]: [S.REFUNDED],
  [S.COMPLETED]: [],
  [S.REFUNDED]: [],
});

const ALL_STATUSES = Object.freeze(Object.values(STATUS));
const TERMINAL_STATUSES = Object.freeze(ALL_STATUSES.filter((s) => TRANSITIONS[s].length === 0));

/**
 * แท็บ "ปัจจุบัน" = ยังต้องมีใครทำอะไรต่อ (รวม FAILED/DELAYED/REFUND_PENDING ที่รอแก้หรือรอคืนเงิน)
 * แท็บ "ที่ผ่านมา" = จบแล้ว
 */
const HISTORY_STATUSES = Object.freeze([S.COMPLETED, S.EXPIRED, S.REFUNDED]);
const CURRENT_STATUSES = Object.freeze(ALL_STATUSES.filter((s) => !HISTORY_STATUSES.includes(s)));

class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`ไม่อนุญาตให้เปลี่ยนสถานะจาก ${from} เป็น ${to}`);
    this.name = 'InvalidTransitionError';
    this.code = 'INVALID_TRANSITION';
    this.from = from;
    this.to = to;
  }
}

const isValidStatus = (status) => ALL_STATUSES.includes(status);

function canTransition(from, to) {
  return isValidStatus(from) && Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

module.exports = {
  STATUS,
  ALL_STATUSES,
  TRANSITIONS,
  TERMINAL_STATUSES,
  CURRENT_STATUSES,
  HISTORY_STATUSES,
  InvalidTransitionError,
  isValidStatus,
  canTransition,
  assertTransition,
  isTerminal,
};
