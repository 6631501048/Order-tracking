const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool(
  config.databaseUrl
    ? {
        connectionString: config.databaseUrl,
        // Render/Railway/Neon ส่วนใหญ่ต้องใช้ SSL เมื่อเชื่อมจากภายนอก ปิดได้ด้วย DB_SSL=false
        ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
        max: 10,
      }
    : { ...config.db, max: 10, idleTimeoutMillis: 30000 }
);

pool.on('error', (err) => {
  console.error('Unexpected PG pool error:', err.message);
});

const query = (text, params) => pool.query(text, params);

/** รันงานใน transaction เดียว: สำเร็จ => COMMIT, throw => ROLLBACK */
async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
