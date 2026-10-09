/**
 * Migration runner แบบเบา: รันไฟล์ db/migrations/*.sql ตามลำดับชื่อ ครั้งละไฟล์ใน transaction
 * - จดว่ารันไฟล์ไหนแล้วใน schema_migrations (รันซ้ำได้ ไม่เสียหาย)
 * - ใช้ advisory lock กัน app หลาย instance migrate พร้อมกัน
 * - รอ DB พร้อมก่อน (เผื่อ start เร็วกว่า DB นอก docker compose)
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const { logger } = require('./logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const LOCK_ID = 727001; // เลขอะไรก็ได้ ขอแค่คงที่

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDb(retries = 30, delayMs = 1000) {
  for (let i = 1; i <= retries; i += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === retries) throw err;
      logger.warn('waiting for database', { attempt: i, retries, reason: err.message });
      await sleep(delayMs);
    }
  }
}

async function migrate() {
  await waitForDb();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const executed = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        executed.push(file);
        logger.info('migration applied', { file });
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} ล้มเหลว: ${err.message}`);
      }
    }
    if (executed.length === 0) logger.info('schema is up to date');
    return executed;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
