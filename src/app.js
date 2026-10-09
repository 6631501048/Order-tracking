const express = require('express');
const { query } = require('./db');
const { requestContext } = require('./middleware/requestContext');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { asyncHandler } = require('./middleware/asyncHandler');
const ordersRouter = require('./routes/orders');
const botRouter = require('./routes/bot');
const webhooksRouter = require('./routes/webhooks');
const adminRouter = require('./routes/admin');

/**
 * @param {object} [options]
 * @param {(app: import('express').Express) => void} [options.mount] ผูก route เพิ่ม (ก่อน 404/error handler)
 */
function createApp({ mount } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext);
  // เก็บ raw body ไว้ตรวจลายเซ็น webhook (HMAC ต้องคำนวณจากไบต์ที่ได้รับจริง)
  app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  // health check ใช้กับ docker / platform deploy
  app.get(
    '/health',
    asyncHandler(async (req, res) => {
      await query('SELECT 1');
      res.json({ status: 'ok', db: 'up' });
    })
  );

  app.use('/orders', ordersRouter);
  app.use('/bot', botRouter);
  app.use('/webhooks', webhooksRouter);
  app.use('/admin', adminRouter);

  if (mount) mount(app);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
