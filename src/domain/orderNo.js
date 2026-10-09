/**
 * เลขออเดอร์รูปแบบ ORD-<13 หลัก>-<3 หลัก> เช่น ORD-2587965432159-458
 * ใช้ตัวเลขสุ่ม (crypto) ไม่ใช่ลำดับ/timestamp เพื่อไม่ให้เดาเลขออเดอร์คนอื่นได้ง่าย
 * ต้องตรงกับ CHECK constraint orders_order_no_chk ใน migration
 */
const crypto = require('crypto');
const { badRequest } = require('../errors');

const ORDER_NO_REGEX = /^ORD-\d{13}-\d{3}$/;

const isValidOrderNo = (value) => typeof value === 'string' && ORDER_NO_REGEX.test(value);

function generateOrderNo() {
  const main = String(crypto.randomInt(1, 1e13)).padStart(13, '0');
  const suffix = String(crypto.randomInt(0, 1000)).padStart(3, '0');
  return `ORD-${main}-${suffix}`;
}

/** ตรวจ format; ผิด => 400 INVALID_ORDER_NO */
function assertValidOrderNo(value) {
  if (!isValidOrderNo(value)) {
    throw badRequest('INVALID_ORDER_NO', 'รูปแบบเลขออเดอร์ไม่ถูกต้อง ต้องเป็น ORD-<13 หลัก>-<3 หลัก>', {
      received: String(value).slice(0, 40),
      example: 'ORD-2587965432159-458',
    });
  }
  return value;
}

module.exports = { ORDER_NO_REGEX, isValidOrderNo, generateOrderNo, assertValidOrderNo };
