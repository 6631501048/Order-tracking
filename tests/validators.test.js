const {
  parseIdempotencyKey, validateCreateOrder, validateReportIssue, parseListQuery,
} = require('../src/validators');
const { hashRequest } = require('../src/services/orderService');
const { toOrderDto } = require('../src/mappers');

const valid = () => ({ customerRef: 'user-1', gameCode: 'FreeFire', gameUid: '123456789', packageCode: 'dia_100', amount: 35 });
const catchErr = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const fields = (err) => err.details.map((d) => d.field).sort();

describe('parseIdempotencyKey', () => {
  test('ขาด => 400 MISSING_IDEMPOTENCY_KEY', () => {
    expect(catchErr(() => parseIdempotencyKey(undefined)).code).toBe('MISSING_IDEMPOTENCY_KEY');
    expect(catchErr(() => parseIdempotencyKey('   ')).code).toBe('MISSING_IDEMPOTENCY_KEY');
  });
  test.each(['short', 'has space in it!', 'x'.repeat(129), 'ไทยไทยไทยไทยไทย'])('รูปแบบผิด: %s', (k) => {
    const err = catchErr(() => parseIdempotencyKey(k));
    expect(err.status).toBe(400);
    expect(err.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });
  test('UUID ผ่าน และ trim ให้', () => {
    expect(parseIdempotencyKey(' 3f2b8c1e-5d4a-4c1b-9e0a-1a2b3c4d5e6f ')).toBe('3f2b8c1e-5d4a-4c1b-9e0a-1a2b3c4d5e6f');
  });
});

describe('validateCreateOrder', () => {
  test('ข้อมูลถูก => normalize (trim, gameCode/packageCode เป็นตัวพิมพ์เล็ก, currency default THB)', () => {
    expect(validateCreateOrder({ ...valid(), customerRef: '  user-1 ' })).toEqual({
      customerRef: 'user-1', gameCode: 'freefire', gameUid: '123456789', packageCode: 'dia_100', amount: 35, currency: 'THB',
    });
  });

  test('currency ตัวพิมพ์เล็กถูกแปลงเป็นตัวใหญ่', () => {
    expect(validateCreateOrder({ ...valid(), currency: 'usd' }).currency).toBe('USD');
  });

  test('ผิดหลาย field => รายงานครบทุก field ในครั้งเดียว', () => {
    const err = catchErr(() => validateCreateOrder({ amount: -1 }));
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(fields(err)).toEqual(['amount', 'customerRef', 'gameCode', 'gameUid', 'packageCode']);
  });

  test.each([null, undefined, 'text', 42, [], [valid()]])('body ไม่ใช่ object (%j) => 400', (body) => {
    expect(catchErr(() => validateCreateOrder(body)).code).toBe('VALIDATION_ERROR');
  });

  test.each([
    [0], [-5], [1000000.01], ['35'], [null], [NaN], [Infinity], [10.999], [0.001],
  ])('amount %j ไม่ผ่าน', (amount) => {
    const err = catchErr(() => validateCreateOrder({ ...valid(), amount }));
    expect(fields(err)).toEqual(['amount']);
  });

  test.each([[0.01], [19.99], [1000000], [35.5]])('amount %j ผ่าน', (amount) => {
    expect(validateCreateOrder({ ...valid(), amount }).amount).toBe(amount);
  });

  test.each([
    ['gameUid', "12'; DROP TABLE orders;--"],
    ['gameUid', 'x'.repeat(65)],
    ['gameUid', ' '],
    ['gameCode', 'free fire'],
    ['gameCode', '../etc'],
    ['packageCode', ''],
    ['customerRef', 'u'.repeat(101)],
    ['customerRef', 123],
  ])('%s = %j ไม่ผ่าน', (field, value) => {
    expect(fields(catchErr(() => validateCreateOrder({ ...valid(), [field]: value })))).toEqual([field]);
  });

  test.each([['TH'], ['THBX'], [1], ['12 ']])('currency %j ไม่ผ่าน', (currency) => {
    expect(fields(catchErr(() => validateCreateOrder({ ...valid(), currency })))).toEqual(['currency']);
  });
});

describe('hashRequest', () => {
  test('input เดียวกัน => hash เดียวกัน; ต่างกันนิดเดียว => ต่าง', () => {
    const a = validateCreateOrder(valid());
    expect(hashRequest(a)).toBe(hashRequest(validateCreateOrder(valid())));
    expect(hashRequest(a)).not.toBe(hashRequest({ ...a, amount: 36 }));
    expect(hashRequest(a)).not.toBe(hashRequest({ ...a, gameUid: '123456780' }));
  });
  test('ลำดับ field ใน body ไม่มีผลกับ hash', () => {
    const a = validateCreateOrder(valid());
    const reordered = validateCreateOrder({ amount: 35, packageCode: 'dia_100', gameUid: '123456789', gameCode: 'FreeFire', customerRef: 'user-1' });
    expect(hashRequest(reordered)).toBe(hashRequest(a));
  });
  test('35 กับ 35.00 ถือว่าเหมือนกัน', () => {
    expect(hashRequest({ ...validateCreateOrder(valid()), amount: 35 })).toBe(hashRequest({ ...validateCreateOrder(valid()), amount: 35.0 }));
  });
});

describe('validateReportIssue', () => {
  test('ถูก => normalize category เป็นตัวใหญ่', () => {
    expect(validateReportIssue({ category: 'wrong_uid', message: ' UID ผิดค่ะ ' })).toEqual({ category: 'WRONG_UID', message: 'UID ผิดค่ะ' });
  });
  test('category ไม่รู้จัก / message ว่าง => 400 พร้อมระบุ field', () => {
    expect(fields(catchErr(() => validateReportIssue({ category: 'BOGUS', message: '  ' })))).toEqual(['category', 'message']);
  });
  test('message ยาวเกิน 1000 => 400', () => {
    expect(fields(catchErr(() => validateReportIssue({ category: 'OTHER', message: 'x'.repeat(1001) })))).toEqual(['message']);
  });
  test('body ไม่ใช่ object => 400', () => {
    expect(catchErr(() => validateReportIssue(null)).code).toBe('VALIDATION_ERROR');
  });
});

describe('parseListQuery', () => {
  test('ค่าเริ่มต้น: current, หน้า 1, 20 รายการ', () => {
    expect(parseListQuery({})).toEqual({ tab: 'current', page: 1, pageSize: 20, customerRef: undefined });
  });
  test('รับค่าที่ถูกต้อง', () => {
    expect(parseListQuery({ tab: 'history', page: '3', pageSize: '50', customerRef: ' u1 ' }))
      .toEqual({ tab: 'history', page: 3, pageSize: 50, customerRef: 'u1' });
  });
  test.each([
    [{ tab: 'all' }, 'tab'], [{ tab: ['current', 'history'] }, 'tab'], [{ tab: '' }, 'tab'],
    [{ page: '0' }, 'page'], [{ page: '-1' }, 'page'], [{ page: '1.5' }, 'page'], [{ page: 'abc' }, 'page'],
    [{ page: ['1', '2'] }, 'page'], [{ page: '1e3' }, 'page'],
    [{ pageSize: '101' }, 'pageSize'], [{ pageSize: '0' }, 'pageSize'],
    [{ customerRef: '' }, 'customerRef'], [{ customerRef: ['a', 'b'] }, 'customerRef'],
  ])('query %j => 400 (%s)', (query, field) => {
    const err = catchErr(() => parseListQuery(query));
    expect(err.status).toBe(400);
    expect(fields(err)).toEqual([field]);
  });
});

describe('toOrderDto', () => {
  const row = {
    order_no: 'ORD-2587965432159-458', status: 'FAILED', customer_ref: 'u', game_code: 'ff', game_uid: '1', package_code: 'p',
    amount: '35.00', currency: 'THB', payment_expires_at: new Date('2026-10-08T10:00:00Z'), paid_at: null, queued_at: null,
    completed_at: null, created_at: new Date('2026-10-08T09:00:00Z'), updated_at: new Date('2026-10-08T09:00:00Z'),
    version: 7, locked_by: 'bot-1', lease_expires_at: new Date(), retry_count: 2, last_error_code: null, last_error_message: null,
  };
  test('แปลง amount เป็นตัวเลข, วันที่เป็น ISO, null คงเป็น null', () => {
    const dto = toOrderDto(row);
    expect(dto.amount).toBe(35);
    expect(dto.createdAt).toBe('2026-10-08T09:00:00.000Z');
    expect(dto.paidAt).toBeNull();
  });
  test('ไม่หลุดข้อมูลภายใน (version, lockedBy, retryCount, lease)', () => {
    const json = JSON.stringify(toOrderDto(row));
    expect(json).not.toMatch(/version|locked|lease|retry/i);
  });
  test('มี issue เฉพาะเมื่อมี error ล่าสุด', () => {
    expect(toOrderDto(row).issue).toBeUndefined();
    expect(toOrderDto({ ...row, last_error_code: 'INVALID_UID', last_error_message: 'UID ไม่ถูกต้อง' }).issue)
      .toEqual({ code: 'INVALID_UID', message: 'UID ไม่ถูกต้อง' });
  });
});

// ---------------------------------------------------------------------------
// validator ของ webhook / แก้ UID / admin (ขั้นที่ 5-6)
// ---------------------------------------------------------------------------
const {
  validateWebhookEnvelope, validatePaymentSucceeded, validateUidUpdate, parseAlertId, parseAlertListQuery,
} = require('../src/validators');

const goodEvent = () => ({ eventId: 'evt-1', type: 'payment.succeeded', orderNo: 'ORD-2587965432159-458', paymentRef: 'pay-1', amount: 35 });

describe('validatePaymentSucceeded / envelope', () => {
  test('ถูกต้อง => normalize (currency default THB)', () => {
    expect(validatePaymentSucceeded(goodEvent())).toEqual({ ...goodEvent(), currency: 'THB' });
  });
  test('envelope ต้องการแค่ eventId + type (type อื่นไม่ต้องมี field ของการจ่ายเงิน)', () => {
    expect(validateWebhookEnvelope({ eventId: 'e1', type: 'payment.refunded', whatever: 1 })).toEqual({ eventId: 'e1', type: 'payment.refunded' });
  });
  test.each([null, 'x', [], 7])('body ไม่ใช่ object (%j) => 400', (b) => {
    expect(catchErr(() => validateWebhookEnvelope(b)).code).toBe('VALIDATION_ERROR');
  });
  test('ผิดหลาย field รายงานครบในครั้งเดียว', () => {
    expect(fields(catchErr(() => validatePaymentSucceeded({ eventId: 'e1', type: 'payment.succeeded', amount: -5 }))))
      .toEqual(['amount', 'orderNo', 'paymentRef']);
  });
  test.each([
    ['orderNo', 'ORD-123'], ['orderNo', "ORD-1'; DROP--"], ['paymentRef', 'has space'], ['paymentRef', 'x'.repeat(129)],
    ['eventId', ''], ['eventId', 'bad id!'], ['amount', '35'], ['amount', 0], ['amount', 10.001], ['currency', 'THBB'],
  ])('%s = %j ไม่ผ่าน', (field, value) => {
    expect(fields(catchErr(() => validatePaymentSucceeded({ ...goodEvent(), [field]: value })))).toEqual([field]);
  });
});

describe('validateUidUpdate', () => {
  test('ถูกต้อง => trim', () => expect(validateUidUpdate({ gameUid: ' 99887766 ' })).toEqual({ gameUid: '99887766' }));
  test.each([[{}], [{ gameUid: '' }], [{ gameUid: "1';--" }], [{ gameUid: 'x'.repeat(65) }], [{ gameUid: 123 }], [null]])(
    '%j => 400', (b) => expect(catchErr(() => validateUidUpdate(b)).status).toBe(400)
  );
});

describe('admin validators', () => {
  test('parseAlertId', () => {
    expect(parseAlertId('42')).toBe(42);
    for (const bad of ['0', '-1', '1.5', 'abc', '', '01', '9'.repeat(16), undefined]) {
      expect(catchErr(() => parseAlertId(bad)).code).toBe('INVALID_ALERT_ID');
    }
  });
  test('parseAlertListQuery: ค่าเริ่มต้น open/50, รับ all, ผิด => 400', () => {
    expect(parseAlertListQuery({})).toEqual({ status: 'open', limit: 50 });
    expect(parseAlertListQuery({ status: 'all', limit: '200' })).toEqual({ status: 'all', limit: 200 });
    expect(catchErr(() => parseAlertListQuery({ status: 'closed' })).status).toBe(400);
    expect(catchErr(() => parseAlertListQuery({ limit: '201' })).status).toBe(400);
  });
});
