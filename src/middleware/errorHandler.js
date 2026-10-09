const { AppError } = require('../errors');
const { InvalidTransitionError } = require('../domain/orderStatus');
const { logger } = require('../logger');

function send(res, req, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  error.requestId = req.id;
  return res.status(status).json({ error });
}

function notFoundHandler(req, res) {
  return send(res, req, 404, 'ROUTE_NOT_FOUND', `ไม่พบ endpoint ${req.method} ${req.originalUrl.split('?')[0]}`);
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // ตอบไปแล้วครึ่งทาง ปล่อยให้ express ปิด connection เอง
  if (res.headersSent) return next(err);

  // body parser
  if (err.type === 'entity.parse.failed') {
    return send(res, req, 400, 'INVALID_JSON', 'รูปแบบ JSON ไม่ถูกต้อง');
  }
  if (err.type === 'entity.too.large') {
    return send(res, req, 413, 'PAYLOAD_TOO_LARGE', 'ข้อมูลที่ส่งมามีขนาดใหญ่เกินไป');
  }

  // error ที่ตั้งใจโยนจาก business logic
  if (err instanceof AppError) {
    return send(res, req, err.status, err.code, err.message, err.details);
  }
  // ผ่าน state machine ไม่ได้ => 409
  if (err instanceof InvalidTransitionError) {
    return send(res, req, 409, err.code, err.message, { from: err.from, to: err.to });
  }

  // Postgres (กันเหนียวนอกเหนือจาก logic ใน service)
  if (err.code === '23505') return send(res, req, 409, 'DUPLICATE', 'ข้อมูลซ้ำกับที่มีอยู่แล้ว');
  if (err.code === '23503') return send(res, req, 400, 'INVALID_REFERENCE', 'ข้อมูลอ้างอิงไม่ถูกต้อง');
  if (err.code === '22P02') return send(res, req, 400, 'INVALID_INPUT', 'รูปแบบข้อมูลไม่ถูกต้อง');

  // ที่เหลือคือ bug / ระบบพัง: log เต็ม แต่ไม่เปิดเผยรายละเอียดให้ client
  logger.error('unhandled error', { err });
  return send(res, req, 500, 'INTERNAL_ERROR', 'เกิดข้อผิดพลาดภายในระบบ');
}

module.exports = { notFoundHandler, errorHandler };
