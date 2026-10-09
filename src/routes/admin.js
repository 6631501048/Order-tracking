const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { orderNoParam } = require('../middleware/orderNoParam');
const { requireAdminToken } = require('../middleware/apiToken');
const { parseAlertId, parseAlertListQuery } = require('../validators');
const recovery = require('../services/recoveryService');
const { runSchedulerOnce } = require('../services/schedulerService');

const router = express.Router();
router.use(requireAdminToken);
router.param('orderNo', orderNoParam);

router.get('/alerts', asyncHandler(async (req, res) => {
  res.json({ data: await recovery.listAlerts(parseAlertListQuery(req.query)) });
}));

router.post('/alerts/:alertId/acknowledge', asyncHandler(async (req, res) => {
  res.json({ data: await recovery.acknowledgeAlert(parseAlertId(req.params.alertId)) });
}));

router.post('/orders/:orderNo/requeue', asyncHandler(async (req, res) => {
  res.json({ data: await recovery.adminRequeue(req.params.orderNo) });
}));

router.post('/orders/:orderNo/refund', asyncHandler(async (req, res) => {
  res.json({ data: await recovery.adminConfirmRefund(req.params.orderNo) });
}));

// สั่งรัน scheduler ทันทีหนึ่งรอบ (ไว้ demo/ทดสอบ; รันซ้ำได้ปลอดภัย)
router.post('/scheduler/run', asyncHandler(async (req, res) => {
  res.json({ data: await runSchedulerOnce() });
}));

module.exports = router;
