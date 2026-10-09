const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const config = require('../src/config');
const { verifyWebhookSignature } = require('../src/middleware/webhookSignature');
const { requestContext } = require('../src/middleware/requestContext');
const { notFoundHandler, errorHandler } = require('../src/middleware/errorHandler');

function createSignatureApp() {
  const app = express();
  app.use(requestContext);
  app.use(express.json({
    verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); },
  }));
  app.post('/webhook', verifyWebhookSignature, (req, res) => res.json({ ok: true }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('webhook signature verification', () => {
  const originalSecret = config.webhookSecret;
  const app = createSignatureApp();

  afterAll(() => { config.webhookSecret = originalSecret; });

  test('fails closed if the webhook secret is not configured', async () => {
    config.webhookSecret = null;
    const res = await request(app).post('/webhook').send({ eventId: 'e-1' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('WEBHOOK_AUTH_NOT_CONFIGURED');
  });

  test('rejects missing, malformed, or incorrect signatures', async () => {
    config.webhookSecret = 'secret';
    const body = { eventId: 'e-1' };
    expect((await request(app).post('/webhook').send(body)).status).toBe(401);
    expect((await request(app).post('/webhook').set('X-Webhook-Signature', 'sha256=bad').send(body)).status).toBe(401);
  });

  test('accepts HMAC-SHA256 over exact raw request bytes', async () => {
    config.webhookSecret = 'secret';
    const body = JSON.stringify({ eventId: 'e-1', data: { amount: 2 } });
    const signature = crypto.createHmac('sha256', config.webhookSecret).update(body).digest('hex');
    const res = await request(app).post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', `sha256=${signature}`)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
