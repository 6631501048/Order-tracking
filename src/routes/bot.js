const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { orderNoParam } = require('../middleware/orderNoParam');
const { requireBotToken } = require('../middleware/apiToken');
const { parseBotId, validateBotFailure } = require('../validators');
const botService = require('../services/botService');

const router = express.Router();
router.use(requireBotToken);
router.param('orderNo', orderNoParam);

router.post('/orders/claim', asyncHandler(async (req, res) => {
  const botId = parseBotId(req.get('X-Bot-Id'));
  res.json({ data: await botService.claimOrder(botId) });
}));

router.post('/orders/:orderNo/heartbeat', asyncHandler(async (req, res) => {
  const botId = parseBotId(req.get('X-Bot-Id'));
  res.json({ data: await botService.heartbeat(req.params.orderNo, botId) });
}));

router.post('/orders/:orderNo/complete', asyncHandler(async (req, res) => {
  const botId = parseBotId(req.get('X-Bot-Id'));
  res.json({ data: await botService.completeOrder(req.params.orderNo, botId) });
}));

router.post('/orders/:orderNo/fail', asyncHandler(async (req, res) => {
  const botId = parseBotId(req.get('X-Bot-Id'));
  const failure = validateBotFailure(req.body);
  res.json({ data: await botService.failOrder(req.params.orderNo, botId, failure) });
}));

module.exports = router;
