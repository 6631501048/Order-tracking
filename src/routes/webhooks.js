const express = require('express');
const config = require('../config');
const { AppError } = require('../errors');
const { asyncHandler } = require('../middleware/asyncHandler');
const { verifySignature } = require('../domain/signature');
const { processPaymentWebhook } = require('../services/webhookService');

const router = express.Router();

// POST /webhooks/payment — ต้องมี X-Signature: sha256=<HMAC-SHA256(WEBHOOK_SECRET, raw body)>
router.post('/payment', asyncHandler(async (req, res) => {
  if (!config.webhookSecret) {
    throw new AppError(503, 'AUTH_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่า WEBHOOK_SECRET');
  }
  if (!verifySignature(config.webhookSecret, req.rawBody, req.get('X-Signature'))) {
    throw new AppError(401, 'INVALID_SIGNATURE', 'ลายเซ็น webhook ไม่ถูกต้องหรือไม่ได้ระบุ');
  }
  res.json({ data: await processPaymentWebhook(req.body) });
}));

module.exports = router;
