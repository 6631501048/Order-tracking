/**
 * Error ที่ตั้งใจโยนจาก business logic
 * ทุก error ในระบบตอบรูปแบบเดียวกัน: { error: { code, message, details?, requestId } }
 */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const notFound = (code, message, details) => new AppError(404, code, message, details);
const conflict = (code, message, details) => new AppError(409, code, message, details);
const unprocessable = (code, message, details) => new AppError(422, code, message, details);
const unauthorized = (message = 'ไม่ได้รับอนุญาต') => new AppError(401, 'UNAUTHORIZED', message);

module.exports = { AppError, badRequest, notFound, conflict, unprocessable, unauthorized };
