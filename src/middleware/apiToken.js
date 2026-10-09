const crypto = require('crypto');
const config = require('../config');
const { AppError, unauthorized } = require('../errors');

function tokensMatch(expected, actual) {
  if (typeof actual !== 'string') return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function tokenGuard({ headerName, configName, role }) {
  return function requireToken(req, res, next) {
    const expected = config[configName];
    if (!expected) {
      return next(new AppError(503, 'AUTH_NOT_CONFIGURED', `ยังไม่ได้ตั้งค่า token สำหรับ ${role}`));
    }
    if (!tokensMatch(expected, req.get(headerName))) {
      return next(unauthorized('token ไม่ถูกต้องหรือไม่ได้ระบุ'));
    }
    return next();
  };
}

const requireBotToken = tokenGuard({
  headerName: 'X-Bot-Token',
  configName: 'botToken',
  role: 'bot',
});

const requireAdminToken = tokenGuard({
  headerName: 'X-Admin-Token',
  configName: 'adminToken',
  role: 'admin',
});

module.exports = { requireBotToken, requireAdminToken };
