const { pool, api, setupDb, resetDb, closeDb, newKey, validOrder, createOrder } = require('./helpers');
const { ORDER_NO_REGEX } = require('../../src/domain/orderNo');

jest.setTimeout(30000);
beforeAll(setupDb);
beforeEach(resetDb);
afterAll(closeDb);

const count = async (table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

/** แทรกออเดอร์ตรง ๆ เพื่อทดสอบการแบ่งหน้า/เรียงลำดับ โดยกำหนดเวลาสร้างเองได้ */
async function seed(status, createdAt, customerRef = 'seed-user') {
  const orderNo = `ORD-${String(Math.floor(Math.random() * 1e13)).padStart(13, '0')}-${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
  await pool.query(
    `INSERT INTO orders (order_no, status, customer_ref, game_code, game_uid, package_code, amount, payment_expires_at, created_at)
     VALUES ($1,$2,$3,'ff','1','p',10, now() + interval '15 min', $4)`,
    [orderNo, status, customerRef, createdAt]
  );
  return orderNo;
}

describe('POST /orders', () => {
  test('สร้างสำเร็จ 201: PENDING_PAYMENT, เลขออเดอร์ถูกรูปแบบ, หมดอายุอีก ~15 นาที, ไม่หลุดข้อมูลภายใน', async () => {
    const res = await createOrder();
    expect(res.status).toBe(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    const o = res.body.data;
    expect(o.orderNo).toMatch(ORDER_NO_REGEX);
    expect(o).toMatchObject({ status: 'PENDING_PAYMENT', gameCode: 'freefire', amount: 35, currency: 'THB', paidAt: null });
    const ttlMin = (new Date(o.paymentExpiresAt) - new Date(o.createdAt)) / 60000;
    expect(ttlMin).toBeGreaterThan(14.9);
    expect(ttlMin).toBeLessThan(15.1);
    expect(JSON.stringify(res.body)).not.toMatch(/version|locked|lease|retry/i);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  test('สร้าง event ORDER_CREATED ลง timeline', async () => {
    const { body } = await createOrder();
    const tl = await api().get(`/orders/${body.data.orderNo}/timeline`);
    expect(tl.body.data.events).toHaveLength(1);
    expect(tl.body.data.events[0]).toMatchObject({ fromStatus: null, toStatus: 'PENDING_PAYMENT', eventType: 'ORDER_CREATED', actor: 'customer' });
  });

  test('ไม่ส่ง Idempotency-Key => 400 และไม่สร้างออเดอร์', async () => {
    const res = await api().post('/orders').send(validOrder());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
    expect(await count('orders')).toBe(0);
  });

  test('body ผิด => 400 VALIDATION_ERROR รายงานทุก field และไม่จอง key ทิ้งไว้', async () => {
    const key = newKey();
    const bad = await api().post('/orders').set('Idempotency-Key', key).send({ amount: 'abc' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(bad.body.error.details.map((d) => d.field).sort()).toEqual(['amount', 'customerRef', 'gameCode', 'gameUid', 'packageCode']);
    expect(await count('idempotency_keys')).toBe(0);
    // key เดิมใช้ส่งข้อมูลที่ถูกต้องต่อได้
    expect((await createOrder(validOrder(), key)).status).toBe(201);
  });

  describe('Idempotency', () => {
    test('ส่งซ้ำ key เดิม + body เดิม => response เดิม (201) + Idempotent-Replayed และมีออเดอร์เดียว', async () => {
      const key = newKey();
      const first = await createOrder(validOrder(), key);
      const second = await createOrder(validOrder(), key);
      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect(await count('orders')).toBe(1);
      expect(await count('order_events')).toBe(1);
    });

    test('ลำดับ field ต่างกัน / gameCode ตัวพิมพ์ต่างกัน ถือเป็น request เดียวกัน', async () => {
      const key = newKey();
      const first = await createOrder(validOrder({ gameCode: 'FreeFire' }), key);
      const second = await api().post('/orders').set('Idempotency-Key', key)
        .send({ amount: 35, packageCode: 'dia_100', gameUid: '123456789', gameCode: 'freefire', customerRef: 'user-1' });
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.data.orderNo).toBe(first.body.data.orderNo);
    });

    test('key เดิมแต่ body ต่าง => 422 IDEMPOTENCY_KEY_REUSED และไม่สร้างออเดอร์ใหม่', async () => {
      const key = newKey();
      await createOrder(validOrder(), key);
      const res = await createOrder(validOrder({ amount: 999 }), key);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await count('orders')).toBe(1);
    });

    test('key ต่างกัน => ออเดอร์แยกกัน เลขไม่ซ้ำ', async () => {
      const a = await createOrder();
      const b = await createOrder();
      expect(a.body.data.orderNo).not.toBe(b.body.data.orderNo);
      expect(await count('orders')).toBe(2);
    });

    test('ยิงพร้อมกัน 30 request ด้วย key เดียว (5 รอบ คนละ key) => ได้ออเดอร์เดียวต่อรอบ ทุก response ชี้เลขเดียวกัน', async () => {
      // หลายรอบเพราะ race condition ไม่เกิดทุกครั้ง รอบเดียวอาจรอดโดยบังเอิญ
      for (let round = 0; round < 5; round += 1) {
        await resetDb();
        const key = newKey();
        const results = await Promise.all(Array.from({ length: 30 }, () => createOrder(validOrder(), key)));
        expect(results.map((r) => r.status)).toEqual(Array(30).fill(201));
        expect(new Set(results.map((r) => r.body.data.orderNo)).size).toBe(1);
        expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(29);
        expect(await count('orders')).toBe(1);
        expect(await count('order_events')).toBe(1);
      }
    });

    test('ยิงพร้อมกันด้วย key เดียวแต่ body ต่างกัน => สำเร็จได้แค่ชุดเดียว ที่เหลือ 422', async () => {
      const key = newKey();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => createOrder(validOrder({ amount: 10 + (i % 2) }), key))
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
      expect(statuses.every((s) => s === 201 || s === 422)).toBe(true);
      expect(await count('orders')).toBe(1);
    });
  });
});

describe('GET /orders/:orderNo', () => {
  test('พบ => 200', async () => {
    const { body } = await createOrder();
    const res = await api().get(`/orders/${body.data.orderNo}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(body.data);
  });

  test('ไม่พบ (format ถูก) => 404 ORDER_NOT_FOUND', async () => {
    const res = await api().get('/orders/ORD-9999999999999-999');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    expect(res.body.error.requestId).toBeTruthy();
  });

  test.each(['ORD-123', 'ord-2587965432159-458', 'ORD-2587965432159', 'XYZ-2587965432159-458', "ORD-1'%20OR%201=1--"])(
    'format ผิด (%s) => 400 INVALID_ORDER_NO', async (bad) => {
      const res = await api().get(`/orders/${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ORDER_NO');
    }
  );
});

describe('GET /orders (current | history)', () => {
  test('แยก current/history ตามสถานะ และเรียงใหม่ -> เก่า', async () => {
    const t = (m) => new Date(Date.UTC(2026, 9, 1, 10, m));
    const q1 = await seed('QUEUED', t(1));
    const done = await seed('COMPLETED', t(2));
    const failed = await seed('FAILED', t(3));
    const pending = await seed('PENDING_PAYMENT', t(4));
    const expired = await seed('EXPIRED', t(5));
    const refunded = await seed('REFUNDED', t(6));
    const delayed = await seed('DELAYED', t(7));

    const cur = await api().get('/orders?tab=current');
    expect(cur.status).toBe(200);
    expect(cur.body.data.map((o) => o.orderNo)).toEqual([delayed, pending, failed, q1]);
    expect(cur.body.pagination).toEqual({ tab: 'current', page: 1, pageSize: 20, total: 4, totalPages: 1 });

    const his = await api().get('/orders?tab=history');
    expect(his.body.data.map((o) => o.orderNo)).toEqual([refunded, expired, done]);
    expect(his.body.pagination.total).toBe(3);
  });

  test('ไม่ระบุ tab => current', async () => {
    await seed('QUEUED', new Date());
    await seed('COMPLETED', new Date());
    const res = await api().get('/orders');
    expect(res.body.pagination.tab).toBe('current');
    expect(res.body.data).toHaveLength(1);
  });

  test('แบ่งหน้า: เรียงต่อเนื่องไม่ซ้ำไม่ตกหล่น, หน้าเกินคือรายการว่าง, เวลาเท่ากันเรียงด้วย id', async () => {
    const same = new Date(Date.UTC(2026, 9, 1, 12, 0));
    const created = [];
    for (let i = 0; i < 7; i += 1) created.push(await seed('QUEUED', i < 3 ? same : new Date(Date.UTC(2026, 9, 1, 12, i))));

    const pages = [];
    for (const page of [1, 2, 3, 4]) {
      const res = await api().get(`/orders?tab=current&page=${page}&pageSize=3`);
      expect(res.status).toBe(200);
      pages.push(res.body);
    }
    expect(pages.map((p) => p.data.length)).toEqual([3, 3, 1, 0]);
    expect(pages[0].pagination).toMatchObject({ total: 7, totalPages: 3, page: 1, pageSize: 3 });
    expect(pages[3].pagination).toMatchObject({ total: 7, totalPages: 3, page: 4 });
    const all = pages.flatMap((p) => p.data.map((o) => o.orderNo));
    expect(new Set(all).size).toBe(7);
    expect(new Set(all)).toEqual(new Set(created));
    const times = pages.flatMap((p) => p.data.map((o) => o.createdAt));
    expect([...times].sort().reverse()).toEqual(times);
  });

  test('กรองด้วย customerRef', async () => {
    await seed('QUEUED', new Date(), 'alice');
    await seed('QUEUED', new Date(), 'bob');
    const res = await api().get('/orders?tab=current&customerRef=alice');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].customerRef).toBe('alice');
  });

  test.each(['tab=all', 'page=0', 'page=abc', 'page=1&page=2', 'pageSize=101', 'pageSize=0', 'tab=history&page=-3'])(
    'query ผิด (%s) => 400 VALIDATION_ERROR', async (qs) => {
      const res = await api().get(`/orders?${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  );

  test('ไม่มีข้อมูล => 200 รายการว่าง totalPages 0', async () => {
    const res = await api().get('/orders?tab=history');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: [], pagination: { total: 0, totalPages: 0 } });
  });

  test('ออเดอร์ที่สร้างผ่าน API ใหม่สุดอยู่บนสุดของ current', async () => {
    const a = await createOrder();
    const b = await createOrder();
    const res = await api().get('/orders?tab=current');
    expect(res.body.data.map((o) => o.orderNo)).toEqual([b.body.data.orderNo, a.body.data.orderNo]);
  });
});

describe('GET /orders/:orderNo/timeline', () => {
  test('เรียงเก่า -> ใหม่ และมีสถานะปัจจุบัน', async () => {
    const { body } = await createOrder();
    await api().post(`/orders/${body.data.orderNo}/report-issue`).send({ category: 'OTHER', message: 'ทดสอบ' });
    const res = await api().get(`/orders/${body.data.orderNo}/timeline`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orderNo: body.data.orderNo, status: 'PENDING_PAYMENT' });
    expect(res.body.data.events.map((e) => e.eventType)).toEqual(['ORDER_CREATED', 'ISSUE_REPORTED']);
    const times = res.body.data.events.map((e) => e.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  test('ไม่พบ => 404, format ผิด => 400', async () => {
    expect((await api().get('/orders/ORD-9999999999999-999/timeline')).status).toBe(404);
    expect((await api().get('/orders/bad/timeline')).status).toBe(400);
  });
});

describe('POST /orders/:orderNo/report-issue', () => {
  test('บันทึกลง timeline + สร้าง alert และ "ไม่เปลี่ยนสถานะ"', async () => {
    const { body } = await createOrder();
    const no = body.data.orderNo;
    const res = await api().post(`/orders/${no}/report-issue`).send({ category: 'not_received', message: 'จ่ายแล้วแต่ยังไม่ได้ของ' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ orderNo: no, status: 'PENDING_PAYMENT', category: 'NOT_RECEIVED' });
    expect(res.body.data.reportedAt).toBeTruthy();

    const ev = (await api().get(`/orders/${no}/timeline`)).body.data.events.at(-1);
    expect(ev).toMatchObject({ eventType: 'ISSUE_REPORTED', fromStatus: 'PENDING_PAYMENT', toStatus: 'PENDING_PAYMENT', reason: 'จ่ายแล้วแต่ยังไม่ได้ของ', actor: 'customer' });
    expect((await api().get(`/orders/${no}`)).body.data.status).toBe('PENDING_PAYMENT');
    expect(await count('alerts')).toBe(1);
  });

  test('แจ้งซ้ำ category เดิมในสถานะเดิม: บันทึก event ทุกครั้งแต่ alert ไม่ซ้ำ; category ใหม่ได้ alert ใหม่', async () => {
    const { body } = await createOrder();
    const no = body.data.orderNo;
    for (let i = 0; i < 3; i += 1) {
      await api().post(`/orders/${no}/report-issue`).send({ category: 'OTHER', message: `ครั้งที่ ${i}` });
    }
    expect(await count('alerts')).toBe(1);
    await api().post(`/orders/${no}/report-issue`).send({ category: 'WRONG_UID', message: 'UID ผิด' });
    expect(await count('alerts')).toBe(2);
    const events = (await api().get(`/orders/${no}/timeline`)).body.data.events;
    expect(events.filter((e) => e.eventType === 'ISSUE_REPORTED')).toHaveLength(4);
  });

  test('PAYMENT_PROBLEM => alert ระดับ CRITICAL', async () => {
    const { body } = await createOrder();
    await api().post(`/orders/${body.data.orderNo}/report-issue`).send({ category: 'PAYMENT_PROBLEM', message: 'โอนแล้ว' });
    const { rows } = await pool.query('SELECT severity, type FROM alerts');
    expect(rows).toEqual([{ severity: 'CRITICAL', type: 'CUSTOMER_REPORT' }]);
  });

  test('แจ้งพร้อมกัน 10 request => alert เดียว ไม่มี error', async () => {
    const { body } = await createOrder();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => api().post(`/orders/${body.data.orderNo}/report-issue`).send({ category: 'OTHER', message: 'ช้า' }))
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(await count('alerts')).toBe(1);
  });

  test('แจ้งได้ทุกสถานะ รวมถึงออเดอร์ที่จบแล้ว', async () => {
    const done = await seed('COMPLETED', new Date());
    const res = await api().post(`/orders/${done}/report-issue`).send({ category: 'NOT_RECEIVED', message: 'ยังไม่เข้าเกม' });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('COMPLETED');
  });

  test('ไม่พบออเดอร์ => 404 และไม่สร้าง alert', async () => {
    const res = await api().post('/orders/ORD-9999999999999-999/report-issue').send({ category: 'OTHER', message: 'x' });
    expect(res.status).toBe(404);
    expect(await count('alerts')).toBe(0);
  });

  test('format เลขออเดอร์ผิด => 400 INVALID_ORDER_NO (ตรวจก่อน body)', async () => {
    const res = await api().post('/orders/bad/report-issue').send({});
    expect(res.body.error.code).toBe('INVALID_ORDER_NO');
  });

  test('body ผิด => 400 และไม่บันทึกอะไร', async () => {
    const { body } = await createOrder();
    const res = await api().post(`/orders/${body.data.orderNo}/report-issue`).send({ category: 'BOGUS', message: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.field).sort()).toEqual(['category', 'message']);
    expect(await count('alerts')).toBe(0);
    expect(await count('order_events')).toBe(1);
  });
});
