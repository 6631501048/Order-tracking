require('dotenv').config();

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && value !== undefined && value !== '' ? n : fallback;
};

module.exports = {
  port: int(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL || null,
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: int(process.env.DB_PORT, 5433),
    user: process.env.DB_USER || 'orders',
    password: process.env.DB_PASSWORD || 'orders_pass',
    database: process.env.DB_NAME || 'orders_db',
  },
  runMigrations: (process.env.RUN_MIGRATIONS || 'true') !== 'false',
  paymentTtlMinutes: int(process.env.PAYMENT_TTL_MINUTES, 15),
  botToken: process.env.BOT_TOKEN || null,
  adminToken: process.env.ADMIN_TOKEN || null,
  botLeaseSeconds: int(process.env.BOT_LEASE_SECONDS, 120),
  webhookSecret: process.env.WEBHOOK_SECRET || null,

  // เคส 1: retry แบบ exponential backoff (หน่วงรอบที่ n = base * 2^(n-1) วินาที ไม่เกิน maxDelay)
  maxRetries: int(process.env.BOT_MAX_RETRIES, 3),
  retryBaseSeconds: int(process.env.RETRY_BASE_SECONDS, 30),
  retryMaxDelaySeconds: int(process.env.RETRY_MAX_DELAY_SECONDS, 900),

  // เคส 5: scheduler
  queueSlaSeconds: int(process.env.QUEUE_SLA_SECONDS, 600),
  schedulerEnabled: (process.env.SCHEDULER_ENABLED || 'true') !== 'false',
  schedulerIntervalSeconds: int(process.env.SCHEDULER_INTERVAL_SECONDS, 15),
};
