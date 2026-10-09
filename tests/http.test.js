const express = require('express');
const request = require('supertest');
const { createApp } = require('../src/app');
const { badRequest, notFound, conflict } = require('../src/errors');
const { assertTransition, STATUS } = require('../src/domain/orderStatus');
const { orderNoParam } = require('../src/middleware/orderNoParam');
const { asyncHandler } = require('../src/middleware/asyncHandler');
const { logger, setLevel, setSink, resetSink } = require('../src/logger');

const ORDER = 'ORD-2587965432159-458';
let lines;

function buildApp() {
  return createApp({
    mount(app) {
      const r = express.Router();
      r.param('orderNo', orderNoParam);
      r.get('/orders/:orderNo', (req, res) => {
        logger.info('lookup', { step: 'service' });
        res.json({ orderNo: req.params.orderNo });
      });
      r.get('/orders/:orderNo/missing', () => {
        throw notFound('ORDER_NOT_FOUND', 'ไม่พบออเดอร์');
      });
      r.get('/orders/:orderNo/bad-transition', () => assertTransition(STATUS.QUEUED, STATUS.COMPLETED));
      app.get('/t/bad', () => {
        throw badRequest('BAD_THING', 'ข้อมูลไม่ถูกต้อง', { field: 'x' });
      });
      app.get('/t/conflict', () => {
        throw conflict('CONFLICT_THING', 'ชนกัน');
      });
      app.get('/t/boom', () => {
        throw new Error('secret db password leaked in message');
      });
      app.get(
        '/t/async-boom',
        asyncHandler(async () => {
          throw new Error('async secret');
        })
      );
      app.get('/t/pg-dup', (req, res, next) => next(Object.assign(new Error('dup'), { code: '23505' })));
      app.get('/t/pg-ref', (req, res, next) => next(Object.assign(new Error('fk'), { code: '23503' })));
      app.get('/t/pg-text', (req, res, next) => next(Object.assign(new Error('x'), { code: '22P02' })));
      app.post('/t/echo', (req, res) => res.json(req.body));
      app.use('/t', r);
    },
  });
}

beforeEach(() => {
  lines = [];
  setLevel('debug');
  setSink((l) => lines.push(JSON.parse(l)));
});
afterEach(() => {
  setLevel('silent');
  resetSink();
});

describe('error format กลาง', () => {
  const app = buildApp();

  const expectShape = (body, code) => {
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error.code).toBe(code);
    expect(typeof body.error.message).toBe('string');
    expect(typeof body.error.requestId).toBe('string');
  };

  test('route ไม่มี => 404 ROUTE_NOT_FOUND', async () => {
    const res = await request(app).get('/nope?x=1');
    expect(res.status).toBe(404);
    expectShape(res.body, 'ROUTE_NOT_FOUND');
    expect(res.body.error.message).not.toContain('x=1');
  });

  test('AppError => status/code/details ตามที่โยน', async () => {
    const res = await request(app).get('/t/bad');
    expect(res.status).toBe(400);
    expectShape(res.body, 'BAD_THING');
    expect(res.body.error.details).toEqual({ field: 'x' });
  });

  test('conflict => 409', async () => {
    const res = await request(app).get('/t/conflict');
    expect(res.status).toBe(409);
    expectShape(res.body, 'CONFLICT_THING');
  });

  test('InvalidTransitionError => 409 INVALID_TRANSITION พร้อม from/to', async () => {
    const res = await request(app).get(`/t/orders/${ORDER}/bad-transition`);
    expect(res.status).toBe(409);
    expectShape(res.body, 'INVALID_TRANSITION');
    expect(res.body.error.details).toEqual({ from: 'QUEUED', to: 'COMPLETED' });
  });

  test('JSON พัง => 400 INVALID_JSON', async () => {
    const res = await request(app).post('/t/echo').set('Content-Type', 'application/json').send('{"a":');
    expect(res.status).toBe(400);
    expectShape(res.body, 'INVALID_JSON');
  });

  test('body ใหญ่เกิน => 413', async () => {
    const res = await request(app).post('/t/echo').send({ blob: 'x'.repeat(200 * 1024) });
    expect(res.status).toBe(413);
    expectShape(res.body, 'PAYLOAD_TOO_LARGE');
  });

  test.each([
    ['/t/pg-dup', 409, 'DUPLICATE'],
    ['/t/pg-ref', 400, 'INVALID_REFERENCE'],
    ['/t/pg-text', 400, 'INVALID_INPUT'],
  ])('Postgres error %s => %i %s', async (path, status, code) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(status);
    expectShape(res.body, code);
  });

  test.each(['/t/boom', '/t/async-boom'])('error ที่ไม่คาดคิด (%s) => 500 โดยไม่เปิดเผยข้อความจริง และ log รายละเอียด', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(500);
    expectShape(res.body, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/secret/);
    const logged = lines.find((l) => l.msg === 'unhandled error');
    expect(logged.level).toBe('error');
    expect(logged.err.message).toMatch(/secret/);
  });
});

describe('requestId', () => {
  const app = buildApp();

  test('สร้างให้เองและส่งกลับทั้ง header และ body ของ error (ค่าเดียวกัน)', async () => {
    const res = await request(app).get('/t/bad');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  test('รับ X-Request-Id ที่ปลอดภัยจาก client', async () => {
    const res = await request(app).get('/t/bad').set('X-Request-Id', 'trace-abc_123');
    expect(res.headers['x-request-id']).toBe('trace-abc_123');
  });

  test('X-Request-Id ที่มีอักขระแปลก (กัน log injection) ถูกทิ้งแล้วสร้างใหม่', async () => {
    const res = await request(app).get('/t/bad').set('X-Request-Id', 'a b"c');
    expect(res.headers['x-request-id']).not.toBe('a b"c');
  });
});

describe('ตามรอยด้วยเลขออเดอร์', () => {
  const app = buildApp();

  test('format ถูก => log ทุกบรรทัดของ request มี orderNo เดียวกัน (รวมบรรทัดจาก service และสรุปตอนจบ)', async () => {
    const res = await request(app).get(`/t/orders/${ORDER}`);
    expect(res.status).toBe(200);
    const mine = lines.filter((l) => l.requestId === res.headers['x-request-id']);
    expect(mine.map((l) => l.msg)).toEqual(['lookup', 'request completed']);
    for (const l of mine) expect(l.orderNo).toBe(ORDER);
    expect(mine[1]).toMatchObject({ method: 'GET', path: `/t/orders/${ORDER}`, status: 200 });
    expect(typeof mine[1].durationMs).toBe('number');
  });

  test('error ที่เกิดหลังรู้เลขออเดอร์ (404) => log มี orderNo และระดับ warn', async () => {
    const res = await request(app).get(`/t/orders/${ORDER}/missing`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    const done = lines.find((l) => l.msg === 'request completed');
    expect(done).toMatchObject({ orderNo: ORDER, status: 404, level: 'warn' });
  });

  test('format ผิด => 400 INVALID_ORDER_NO ก่อนถึง handler และไม่เอาค่าขยะไปเป็น orderNo ใน log', async () => {
    const res = await request(app).get('/t/orders/ORD-123');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ORDER_NO');
    expect(res.body.error.details.example).toBe('ORD-2587965432159-458');
    expect(lines.some((l) => l.msg === 'lookup')).toBe(false);
    expect(lines.every((l) => l.orderNo === undefined)).toBe(true);
  });

  test('5xx => level error', async () => {
    await request(app).get('/t/boom');
    expect(lines.find((l) => l.msg === 'request completed')).toMatchObject({ status: 500, level: 'error' });
  });

  test('สอง request พร้อมกันคนละออเดอร์ log ไม่ปนกัน', async () => {
    const A = 'ORD-1111111111111-111';
    const B = 'ORD-2222222222222-222';
    const [ra, rb] = await Promise.all([request(app).get(`/t/orders/${A}`), request(app).get(`/t/orders/${B}`)]);
    for (const [res, no] of [[ra, A], [rb, B]]) {
      const mine = lines.filter((l) => l.requestId === res.headers['x-request-id']);
      expect(mine.length).toBeGreaterThan(0);
      for (const l of mine) expect(l.orderNo).toBe(no);
    }
  });
});
