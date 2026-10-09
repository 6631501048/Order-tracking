const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { orderNoParam } = require('../middleware/orderNoParam');
const { parseIdempotencyKey, validateCreateOrder, validateReportIssue, parseListQuery, validateUidUpdate } = require('../validators');
const orderService = require('../services/orderService');
const recovery = require('../services/recoveryService');

const router = express.Router();
router.param('orderNo', orderNoParam);

// สร้างออเดอร์ (ต้องมี Idempotency-Key)
router.post('/', asyncHandler(async (req, res) => {
  const idempotencyKey = parseIdempotencyKey(req.get('Idempotency-Key'));
  const input = validateCreateOrder(req.body);
  const result = await orderService.createOrder({ idempotencyKey, input });
  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  res.status(result.status).json(result.body);
}));

// รายการออเดอร์ current | history
router.get('/', asyncHandler(async (req, res) => {
  res.json(await orderService.listOrders(parseListQuery(req.query)));
}));

router.get('/:orderNo', asyncHandler(async (req, res) => {
  res.json({ data: await orderService.getOrder(req.params.orderNo) });
}));

router.get('/:orderNo/timeline', asyncHandler(async (req, res) => {
  res.json({ data: await orderService.getTimeline(req.params.orderNo) });
}));

router.post('/:orderNo/report-issue', asyncHandler(async (req, res) => {
  const input = validateReportIssue(req.body);
  res.status(201).json({ data: await orderService.reportIssue(req.params.orderNo, input) });
}));

// เคส 4: UID ผิด (ออเดอร์ FAILED) => แก้ UID แล้วเข้าคิวใหม่
router.patch('/:orderNo/uid', asyncHandler(async (req, res) => {
  const { gameUid } = validateUidUpdate(req.body);
  res.json({ data: await recovery.updateUidAndRetry(req.params.orderNo, gameUid) });
}));

// เคส 4: หรือขอคืนเงิน (ออเดอร์ FAILED / DELAYED)
router.post('/:orderNo/refund-request', asyncHandler(async (req, res) => {
  res.json({ data: await recovery.requestRefund(req.params.orderNo) });
}));

module.exports = router;
