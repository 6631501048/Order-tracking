/**
 * Structured logger (JSON 1 บรรทัดต่อ 1 log) ที่ตามรอยด้วยเลขออเดอร์ได้
 *
 * ใช้ AsyncLocalStorage เก็บ context ต่อ request/job: { requestId, orderNo }
 * ทุก log ที่เกิดภายใน context เดียวกันจะมี requestId และ orderNo ติดไปเอง
 * โดยไม่ต้องส่ง logger ผ่านทุกฟังก์ชัน -> grep orderNo เดียวเห็นทั้ง request, service, bot, scheduler
 *
 *   logger.info('claimed', { botId })            // ใน request ที่ set orderNo แล้ว => มี orderNo อัตโนมัติ
 *   runWithContext({ orderNo }, () => ...)       // งานเบื้องหลัง (scheduler) ที่ไม่มี request
 */
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const defaultLevel = process.env.NODE_ENV === 'test' ? 'silent' : 'info';
let minLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS[defaultLevel];
let sink = (line) => process.stdout.write(`${line}\n`);

const setLevel = (level) => {
  if (!(level in LEVELS)) throw new Error(`unknown log level: ${level}`);
  minLevel = LEVELS[level];
};
const setSink = (fn) => {
  sink = fn;
};
const resetSink = () => {
  sink = (line) => process.stdout.write(`${line}\n`);
};

/** รันฟังก์ชันภายใน context ใหม่ (copy จาก context เดิม ถ้ามี) */
function runWithContext(ctx, fn) {
  return storage.run({ ...(storage.getStore() || {}), ...ctx }, fn);
}

/** เติม context ของ request/job ปัจจุบัน เช่น setContext({ orderNo }) */
function setContext(partial) {
  const store = storage.getStore();
  if (store) Object.assign(store, partial);
}

const getContext = () => storage.getStore() || {};

function serialize(fields = {}) {
  const out = { ...fields };
  if (out.err instanceof Error) {
    out.err = { name: out.err.name, message: out.err.message, code: out.err.code, stack: out.err.stack };
  }
  return out;
}

function emit(level, msg, fields) {
  if (LEVELS[level] < minLevel) return;
  const { requestId, orderNo, job } = getContext();
  const entry = { time: new Date().toISOString(), level, msg };
  if (requestId) entry.requestId = requestId;
  if (orderNo) entry.orderNo = orderNo;
  if (job) entry.job = job; // งานเบื้องหลัง เช่น expire-payments, reclaim-leases
  const extra = serialize(fields);
  for (const key of Object.keys(extra)) {
    if (!['time', 'level', 'msg'].includes(key)) entry[key] = extra[key];
  }
  sink(JSON.stringify(entry));
}

const logger = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};

module.exports = { logger, runWithContext, setContext, getContext, setLevel, setSink, resetSink };
