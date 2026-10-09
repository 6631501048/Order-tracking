/**
 * เวลาทั้งหมดที่ใช้ตัดสินใจ (lease, backoff, หมดอายุ) อ้างอิงนาฬิกาของ DB (now()) เสมอ
 * ไม่ใช้ new Date() ของ app เพราะหลาย instance/เครื่องนาฬิกาเพี้ยนกันได้ => เทียบกันผิด
 */
async function dbNowPlus(client, seconds = 0) {
  const { rows } = await client.query(
    'SELECT now() + make_interval(secs => $1::int) AS expires_at',
    [seconds]
  );
  return rows[0].expires_at;
}

module.exports = { dbNowPlus };
