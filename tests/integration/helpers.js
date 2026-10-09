/**
 * Helper ของ integration test: ใช้ Postgres จริง แต่เป็นฐานข้อมูลแยก (orders_test) เสมอ
 * จะได้ไม่ไปลบข้อมูลของ dev  — ต้องตั้ง env ก่อน require โมดูลใน src (config อ่านตอน require)
 *
 * รัน:  docker compose up -d db && npm run test:int
 */
process.env.DB_NAME = process.env.TEST_DB_NAME || 'orders_test';
delete process.env.DATABASE_URL;
// Compose exposes PostgreSQL on localhost:5433; set TEST_DB_PORT for a custom test database port.
process.env.DB_PORT = process.env.TEST_DB_PORT || '5433';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'integration-bot-token';
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'integration-admin-token';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'integration-webhook-secret';
process.env.SCHEDULER_ENABLED = 'false';

if (!process.env.DB_NAME.includes('test')) {
  throw new Error(`integration test ปฏิเสธที่จะรันกับฐานข้อมูล "${process.env.DB_NAME}" (ชื่อต้องมีคำว่า test)`);
}

const { Client } = require('pg');
const request = require('supertest');
const config = require('../../src/config');
const { pool } = require('../../src/db');
const { migrate } = require('../../src/migrate');
const { createApp } = require('../../src/app');

async function ensureDatabase() {
  const admin = new Client({ ...config.db, database: 'postgres' });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [config.db.database]);
    if (rowCount === 0) await admin.query(`CREATE DATABASE "${config.db.database}"`);
  } finally {
    await admin.end();
  }
}

async function setupDb() {
  await ensureDatabase();
  await migrate();
}

const resetDb = () => pool.query('TRUNCATE orders, alerts, idempotency_keys, processed_webhooks RESTART IDENTITY CASCADE');
const closeDb = () => pool.end();

const app = createApp();
const api = () => request(app);

let keyCounter = 0;
const newKey = () => `test-key-${Date.now()}-${keyCounter++}`;

const validOrder = (overrides = {}) => ({
  customerRef: 'user-1', gameCode: 'freefire', gameUid: '123456789', packageCode: 'dia_100', amount: 35, ...overrides,
});

const createOrder = (body = validOrder(), key = newKey()) =>
  api().post('/orders').set('Idempotency-Key', key).send(body);

// ---------------------------------------------------------------------------
// เครื่องมือสำหรับทดสอบเคสปัญหา (เคส 1-5)
// ---------------------------------------------------------------------------
const { sign } = require('../../src/domain/signature');

const DEFAULT_CONFIG = {
  maxRetries: config.maxRetries,
  retryBaseSeconds: config.retryBaseSeconds,
  retryMaxDelaySeconds: config.retryMaxDelaySeconds,
  queueSlaSeconds: config.queueSlaSeconds,
  botLeaseSeconds: config.botLeaseSeconds,
};
/** ปรับ config ชั่วคราวในเทสต์ (config เป็น object เดียวที่ service อ่านตอนเรียกใช้) แล้วคืนค่าด้วย restoreConfig() */
const setConfig = (overrides) => Object.assign(config, overrides);
const restoreConfig = () => Object.assign(config, DEFAULT_CONFIG);

let seedCounter = 0;
const uniqueOrderNo = () => {
  seedCounter += 1;
  return `ORD-${String(Date.now() % 1e13).padStart(13, '0')}-${String(seedCounter % 1000).padStart(3, '0')}`;
};

/** แทรกออเดอร์ตรง ๆ ที่สถานะใดก็ได้ (สถานะ IN_PROGRESS ต้องส่ง locked_by + lease_expires_at ให้ครบคู่) */
async function seedOrder(status = 'QUEUED', fields = {}) {
  const row = {
    order_no: uniqueOrderNo(), status, customer_ref: 'test-user', game_code: 'freefire', game_uid: 'uid-123',
    package_code: 'diamonds', amount: 35, currency: 'THB',
    payment_expires_at: new Date(Date.now() + 15 * 60_000), queued_at: status === 'QUEUED' ? new Date() : null,
    ...fields,
  };
  const cols = Object.keys(row);
  const { rows } = await pool.query(
    `INSERT INTO orders (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    cols.map((c) => row[c])
  );
  return rows[0];
}

const getOrder = async (id) => (await pool.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0];
const eventTypes = async (id) =>
  (await pool.query('SELECT event_type FROM order_events WHERE order_id = $1 ORDER BY id', [id])).rows.map((r) => r.event_type);
const alertsOf = async (id) =>
  (await pool.query('SELECT type, severity FROM alerts WHERE order_id = $1 ORDER BY id', [id])).rows;
const countRows = async (table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

const bot = (req, botId = 'bot-1') => req.set('X-Bot-Token', config.botToken).set('X-Bot-Id', botId);
const admin = (req) => req.set('X-Admin-Token', config.adminToken);
const claim = (botId = 'bot-1') => bot(api().post('/bot/orders/claim'), botId).send({});
const botFail = (orderNo, botId, errorType = 'TRANSIENT', errorCode = 'PROVIDER_TIMEOUT') =>
  bot(api().post(`/bot/orders/${orderNo}/fail`), botId).send({ errorType, errorCode, message: `${errorCode} เกิดขึ้น` });
const runScheduler = () => admin(api().post('/admin/scheduler/run')).send({});

/** ส่ง webhook ที่เซ็นถูกต้อง (หรือกำหนด signature เองเพื่อทดสอบลายเซ็นผิด) */
const paymentEvent = (order, overrides = {}) => ({
  eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'payment.succeeded',
  orderNo: order.order_no, paymentRef: `pay-${Math.random().toString(36).slice(2, 10)}`,
  amount: Number(order.amount), currency: order.currency, ...overrides,
});
function sendWebhook(body, { signature, raw } = {}) {
  const payload = raw !== undefined ? raw : JSON.stringify(body);
  const sig = signature !== undefined ? signature : sign(config.webhookSecret, Buffer.from(payload));
  const req = api().post('/webhooks/payment').set('Content-Type', 'application/json');
  if (sig !== null) req.set('X-Signature', sig);
  return req.send(payload);
}

module.exports = {
  pool, api, setupDb, resetDb, closeDb, newKey, validOrder, createOrder,
  config, setConfig, restoreConfig, seedOrder, getOrder, eventTypes, alertsOf, countRows,
  bot, admin, claim, botFail, runScheduler, paymentEvent, sendWebhook,
};
