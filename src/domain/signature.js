/**
 * ตรวจลายเซ็น webhook: header  X-Signature: sha256=<hex ของ HMAC-SHA256(secret, rawBody)>
 * ต้องคำนวณจาก "raw body ที่ได้รับจริง" ไม่ใช่ JSON ที่ parse แล้ว stringify ใหม่ (ลำดับ key/ช่องว่างอาจต่าง)
 */
const crypto = require('crypto');

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;

function sign(secret, rawBody) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function verifySignature(secret, rawBody, headerValue) {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof headerValue !== 'string') return false;
  const match = SIGNATURE_PATTERN.exec(headerValue.trim());
  if (!match) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(match[1], 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { sign, verifySignature };
