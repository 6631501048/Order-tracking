/**
 * Express 4 ไม่จับ promise ที่ reject ใน handler แบบ async => request ค้างไม่มีวันตอบ
 * ห่อ handler ทุกตัวที่เป็น async ด้วยฟังก์ชันนี้ เพื่อส่ง error เข้า error handler กลาง
 *
 *   router.get('/x', asyncHandler(async (req, res) => { ... }));
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { asyncHandler };
