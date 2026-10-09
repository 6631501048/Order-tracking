const crypto = require('crypto');
const { logger, runWithContext, getContext } = require('../logger');

const SAFE_ID = /^[\w.-]{1,64}$/;

/**
 * - กำหนด requestId (รับจาก X-Request-Id ถ้าปลอดภัย ไม่งั้นสร้างใหม่) และส่งกลับใน header
 * - เปิด context ของ logger ตลอดอายุ request
 * - log 1 บรรทัดตอนจบ request (มี orderNo ถ้า route นั้นมี :orderNo)
 */
function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  const requestId = incoming && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  const startedAt = process.hrtime.bigint();

  runWithContext({ requestId }, () => {
    // เก็บ store ไว้ใช้ตอน finish เพื่อไม่พึ่งว่า event callback จะอยู่ใน async context เดิม
    const ctx = getContext();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const fields = {
        requestId: ctx.requestId,
        orderNo: ctx.orderNo,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
      };
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level]('request completed', fields);
    });
    next();
  });
}

module.exports = { requestContext };
