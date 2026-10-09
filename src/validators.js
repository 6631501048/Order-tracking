/**
 * ตรวจ input ของ API ด้วยมือ (ไม่พึ่ง library) — รวบรวมทุก field ที่ผิดแล้วตอบทีเดียว
 * ผิด => 400 VALIDATION_ERROR พร้อม details: [{ field, message }]
 */
const { badRequest } = require('./errors');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:#-]{0,63}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

const REPORT_CATEGORIES = Object.freeze(['NOT_RECEIVED', 'WRONG_UID', 'PAYMENT_PROBLEM', 'OTHER']);
const TABS = Object.freeze(['current', 'history']);
const MAX_AMOUNT = 1_000_000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const BOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

function fail(errors, message = 'ข้อมูลที่ส่งมาไม่ถูกต้อง') {
  return badRequest('VALIDATION_ERROR', message, errors);
}

function readString(body, field, errors, { max, pattern, patternMessage, lower = false }) {
  const raw = body[field];
  if (typeof raw !== 'string' || raw.trim() === '') {
    errors.push({ field, message: 'จำเป็นต้องระบุและต้องเป็นข้อความ' });
    return undefined;
  }
  const value = lower ? raw.trim().toLowerCase() : raw.trim();
  if (value.length > max) {
    errors.push({ field, message: `ยาวได้ไม่เกิน ${max} ตัวอักษร` });
    return undefined;
  }
  if (pattern && !pattern.test(value)) {
    errors.push({ field, message: patternMessage });
    return undefined;
  }
  return value;
}

/** Idempotency-Key header (จำเป็นสำหรับ POST /orders) */
function parseIdempotencyKey(headerValue) {
  if (headerValue === undefined || String(headerValue).trim() === '') {
    throw badRequest('MISSING_IDEMPOTENCY_KEY', 'ต้องส่ง header Idempotency-Key (เช่น UUID) เพื่อกันการสร้างออเดอร์ซ้ำ');
  }
  const key = String(headerValue).trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw badRequest(
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key ต้องยาว 8-128 ตัวอักษร ใช้ได้เฉพาะ A-Z a-z 0-9 _ . : -'
    );
  }
  return key;
}

function validateCreateOrder(body) {
  if (!isPlainObject(body)) {
    throw fail([{ field: 'body', message: 'ต้องส่งเป็น JSON object' }]);
  }
  const errors = [];
  const customerRef = readString(body, 'customerRef', errors, { max: 100 });
  const gameCode = readString(body, 'gameCode', errors, {
    max: 32, pattern: CODE_PATTERN, patternMessage: 'ใช้ได้เฉพาะ a-z 0-9 _ - (ขึ้นต้นด้วยตัวอักษรหรือตัวเลข)', lower: true,
  });
  const gameUid = readString(body, 'gameUid', errors, {
    max: 64, pattern: UID_PATTERN, patternMessage: 'UID ใช้ได้เฉพาะ A-Z a-z 0-9 _ : # -',
  });
  const packageCode = readString(body, 'packageCode', errors, {
    max: 32, pattern: CODE_PATTERN, patternMessage: 'ใช้ได้เฉพาะ a-z 0-9 _ - (ขึ้นต้นด้วยตัวอักษรหรือตัวเลข)', lower: true,
  });

  let amount;
  const rawAmount = body.amount;
  if (typeof rawAmount !== 'number' || !Number.isFinite(rawAmount)) {
    errors.push({ field: 'amount', message: 'ต้องเป็นตัวเลข' });
  } else if (rawAmount <= 0 || rawAmount > MAX_AMOUNT) {
    errors.push({ field: 'amount', message: `ต้องมากกว่า 0 และไม่เกิน ${MAX_AMOUNT}` });
  } else if (Math.abs(rawAmount * 100 - Math.round(rawAmount * 100)) > 1e-6) {
    errors.push({ field: 'amount', message: 'ทศนิยมได้ไม่เกิน 2 ตำแหน่ง' });
  } else {
    amount = Math.round(rawAmount * 100) / 100;
  }

  let currency = 'THB';
  if (body.currency !== undefined) {
    if (typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency)) {
      errors.push({ field: 'currency', message: 'ต้องเป็นรหัสสกุลเงิน 3 ตัวอักษร เช่น THB' });
    } else {
      currency = body.currency.toUpperCase();
    }
  }

  if (errors.length) throw fail(errors);
  return { customerRef, gameCode, gameUid, packageCode, amount, currency };
}

const WEBHOOK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PAYMENT_SUCCEEDED = 'payment.succeeded';

/** ขั้นแรกของ webhook: ต้องมี eventId กับ type (type ที่ไม่รู้จักจะถูกบันทึกแล้วข้าม ไม่ถือว่า error) */
function validateWebhookEnvelope(body) {
  if (!isPlainObject(body)) throw fail([{ field: 'body', message: 'ต้องส่งเป็น JSON object' }]);
  const errors = [];
  const eventId = readString(body, 'eventId', errors, { max: 128, pattern: WEBHOOK_ID_PATTERN, patternMessage: 'eventId ใช้ได้เฉพาะ A-Z a-z 0-9 _ . : -' });
  const type = readString(body, 'type', errors, { max: 64 });
  if (errors.length) throw fail(errors);
  return { eventId, type };
}

function validatePaymentSucceeded(body) {
  const { eventId, type } = validateWebhookEnvelope(body);
  const errors = [];
  const orderNo = readString(body, 'orderNo', errors, { max: 40, pattern: /^ORD-\d{13}-\d{3}$/, patternMessage: 'รูปแบบเลขออเดอร์ไม่ถูกต้อง' });
  const paymentRef = readString(body, 'paymentRef', errors, { max: 128, pattern: WEBHOOK_ID_PATTERN, patternMessage: 'paymentRef ใช้ได้เฉพาะ A-Z a-z 0-9 _ . : -' });
  let amount;
  if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0 || body.amount > MAX_AMOUNT
      || Math.abs(body.amount * 100 - Math.round(body.amount * 100)) > 1e-6) {
    errors.push({ field: 'amount', message: `ต้องเป็นตัวเลขมากกว่า 0 ไม่เกิน ${MAX_AMOUNT} ทศนิยมไม่เกิน 2 ตำแหน่ง` });
  } else {
    amount = Math.round(body.amount * 100) / 100;
  }
  let currency = 'THB';
  if (body.currency !== undefined) {
    if (typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency)) {
      errors.push({ field: 'currency', message: 'ต้องเป็นรหัสสกุลเงิน 3 ตัวอักษร' });
    } else currency = body.currency.toUpperCase();
  }
  if (errors.length) throw fail(errors);
  return { eventId, type, orderNo, paymentRef, amount, currency };
}

/** PATCH /orders/:orderNo/uid */
function validateUidUpdate(body) {
  if (!isPlainObject(body)) throw fail([{ field: 'body', message: 'ต้องส่งเป็น JSON object' }]);
  const errors = [];
  const gameUid = readString(body, 'gameUid', errors, { max: 64, pattern: UID_PATTERN, patternMessage: 'UID ใช้ได้เฉพาะ A-Z a-z 0-9 _ : # -' });
  if (errors.length) throw fail(errors);
  return { gameUid };
}

function parseAlertId(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,14}$/.test(raw)) {
    throw badRequest('INVALID_ALERT_ID', 'alertId ต้องเป็นจำนวนเต็มบวก');
  }
  return Number(raw);
}

function parseAlertListQuery(query) {
  const status = query.status === undefined ? 'open' : query.status;
  if (!['open', 'all'].includes(status)) {
    throw fail([{ field: 'status', message: 'ต้องเป็น open หรือ all' }], 'พารามิเตอร์ไม่ถูกต้อง');
  }
  const limit = parsePositiveInt(query.limit, 'limit', { fallback: 50, max: 200 });
  return { status, limit };
}

function validateReportIssue(body) {
  if (!isPlainObject(body)) {
    throw fail([{ field: 'body', message: 'ต้องส่งเป็น JSON object' }]);
  }
  const errors = [];
  const category = typeof body.category === 'string' ? body.category.trim().toUpperCase() : undefined;
  if (!REPORT_CATEGORIES.includes(category)) {
    errors.push({ field: 'category', message: `ต้องเป็นหนึ่งใน ${REPORT_CATEGORIES.join(', ')}` });
  }
  const message = readString(body, 'message', errors, { max: 1000 });
  if (errors.length) throw fail(errors);
  return { category, message };
}

function parseBotId(headerValue) {
  if (typeof headerValue !== 'string' || !BOT_ID_PATTERN.test(headerValue.trim())) {
    throw fail([{ field: 'X-Bot-Id', message: 'ต้องระบุรหัส bot ที่ยาว 1-64 ตัวอักษร' }]);
  }
  return headerValue.trim();
}

function validateBotFailure(body) {
  if (!isPlainObject(body)) {
    throw fail([{ field: 'body', message: 'ต้องส่งเป็น JSON object' }]);
  }

  const errors = [];
  const errorType = typeof body.errorType === 'string' ? body.errorType.trim().toUpperCase() : '';
  if (!['TRANSIENT', 'PERMANENT'].includes(errorType)) {
    errors.push({ field: 'errorType', message: 'ต้องเป็น TRANSIENT หรือ PERMANENT' });
  }

  const errorCode = readString(body, 'errorCode', errors, { max: 100, pattern: ERROR_CODE_PATTERN, patternMessage: 'รูปแบบ errorCode ไม่ถูกต้อง' });
  const message = readString(body, 'message', errors, { max: 500 });
  if (errors.length) throw fail(errors);
  return { errorType, errorCode, message };
}

function parsePositiveInt(raw, field, { fallback, max }) {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) {
    throw fail([{ field, message: 'ต้องเป็นจำนวนเต็มบวก' }], 'พารามิเตอร์ไม่ถูกต้อง');
  }
  const n = Number(raw);
  if (n < 1 || n > max) {
    throw fail([{ field, message: `ต้องอยู่ระหว่าง 1 ถึง ${max}` }], 'พารามิเตอร์ไม่ถูกต้อง');
  }
  return n;
}

/** GET /orders?tab=current|history&page=&pageSize=&customerRef= */
function parseListQuery(query) {
  const tab = query.tab === undefined ? 'current' : query.tab;
  if (!TABS.includes(tab)) {
    throw fail([{ field: 'tab', message: `ต้องเป็น ${TABS.join(' หรือ ')}` }], 'พารามิเตอร์ไม่ถูกต้อง');
  }
  const page = parsePositiveInt(query.page, 'page', { fallback: 1, max: 1_000_000 });
  const pageSize = parsePositiveInt(query.pageSize, 'pageSize', { fallback: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE });
  let customerRef;
  if (query.customerRef !== undefined) {
    if (typeof query.customerRef !== 'string' || query.customerRef.trim() === '' || query.customerRef.length > 100) {
      throw fail([{ field: 'customerRef', message: 'ต้องเป็นข้อความ 1-100 ตัวอักษร' }], 'พารามิเตอร์ไม่ถูกต้อง');
    }
    customerRef = query.customerRef.trim();
  }
  return { tab, page, pageSize, customerRef };
}

module.exports = {
  REPORT_CATEGORIES, TABS, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE,
  parseIdempotencyKey, validateCreateOrder, validateReportIssue, parseListQuery,
  parseBotId, validateBotFailure,
  PAYMENT_SUCCEEDED, validateWebhookEnvelope, validatePaymentSucceeded, validateUidUpdate, parseAlertId, parseAlertListQuery,
};
