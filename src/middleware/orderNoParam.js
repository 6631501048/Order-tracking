const { assertValidOrderNo } = require('../domain/orderNo');
const { setContext } = require('../logger');

/**
 * ใช้กับ router.param('orderNo', orderNoParam)
 * - ตรวจ format ก่อนถึง handler (ผิด => 400 ผ่าน error handler กลาง)
 * - ใส่ orderNo ลง log context => ทุก log ของ request นี้ตามรอยด้วยเลขออเดอร์ได้
 */
function orderNoParam(req, res, next, value) {
  try {
    assertValidOrderNo(value);
    setContext({ orderNo: value });
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { orderNoParam };
