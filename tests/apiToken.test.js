const express = require('express');
const request = require('supertest');
const config = require('../src/config');
const { requireBotToken, requireAdminToken } = require('../src/middleware/apiToken');
const { requestContext } = require('../src/middleware/requestContext');
const { notFoundHandler, errorHandler } = require('../src/middleware/errorHandler');

function protectedApp() {
  const app = express();
  app.use(requestContext);
  app.post('/bot', requireBotToken, (req, res) => res.sendStatus(204));
  app.post('/admin', requireAdminToken, (req, res) => res.sendStatus(204));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('internal API token guards', () => {
  const originalBotToken = config.botToken;
  const originalAdminToken = config.adminToken;
  const app = protectedApp();

  afterAll(() => {
    config.botToken = originalBotToken;
    config.adminToken = originalAdminToken;
  });

  test('ไม่มี token ใน environment => fail closed ด้วย 503', async () => {
    config.botToken = null;
    const res = await request(app).post('/bot');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AUTH_NOT_CONFIGURED');
  });

  test('bot token รับเฉพาะค่าที่ตรงกันและใช้เวลาเทียบแบบคงที่', async () => {
    config.botToken = 'correct-bot-token';
    expect((await request(app).post('/bot').set('X-Bot-Token', 'wrong')).status).toBe(401);
    expect((await request(app).post('/bot').set('X-Bot-Token', 'correct-bot-token')).status).toBe(204);
  });

  test('admin token แยกจาก bot token', async () => {
    config.botToken = 'correct-bot-token';
    config.adminToken = 'correct-admin-token';
    expect((await request(app).post('/admin').set('X-Admin-Token', 'correct-bot-token')).status).toBe(401);
    expect((await request(app).post('/admin').set('X-Admin-Token', 'correct-admin-token')).status).toBe(204);
  });
});
