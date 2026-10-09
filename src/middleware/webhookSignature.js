const crypto = require('crypto');
const config = require('../config');
const { AppError, unauthorized } = require('../errors');

function verifyWebhookSignature(req, res, next) {
  if (!config.webhookSecret) {
    return next(new AppError(503, 'WEBHOOK_AUTH_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่า WEBHOOK_SECRET'));
  }
  const match = /^sha256=([a-f0-9]{64})$/i.exec(req.get('X-Webhook-Signature') || '');
  if (!match || !Buffer.isBuffer(req.rawBody)) {
    return next(unauthorized('ลายเซ็น webhook ไม่ถูกต้องหรือไม่ได้ระบุ'));
  }
  const expected = crypto.createHmac('sha256', config.webhookSecret).update(req.rawBody).digest();
  const supplied = Buffer.from(match[1], 'hex');
  if (!crypto.timingSafeEqual(expected, supplied)) {
    return next(unauthorized('ลายเซ็น webhook ไม่ถูกต้องหรือไม่ได้ระบุ'));
  }
  return next();
}

module.exports = { verifyWebhookSignature };
