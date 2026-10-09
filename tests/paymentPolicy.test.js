const { decidePaymentAction } = require('../src/domain/paymentPolicy');
const { ALL_STATUSES, STATUS } = require('../src/domain/orderStatus');

const order = (overrides = {}) => ({
  id: 7, order_no: 'ORD-2587965432159-458', status: STATUS.PENDING_PAYMENT, amount: '35.00', currency: 'THB', payment_ref: null, ...overrides,
});
const event = (overrides = {}) => ({
  eventId: 'evt-1', orderNo: 'ORD-2587965432159-458', paymentRef: 'pay-1', amount: 35, currency: 'THB', ...overrides,
});

describe('เคส 3: ตัดสินใจกับ webhook จ่ายเงิน (เทียบ state ก่อนเปลี่ยนสถานะ)', () => {
  test('PENDING_PAYMENT + ยอดตรง => APPLIED เข้า QUEUED ไม่มี alert', () => {
    const d = decidePaymentAction(order(), event());
    expect(d.outcome).toBe('APPLIED');
    expect(d.transition).toMatchObject({ to: STATUS.QUEUED, eventType: 'PAYMENT_CONFIRMED' });
    expect(d.alert).toBeUndefined();
  });

  test('EXPIRED (มาช้า) => ไม่ฟื้นออเดอร์ ตั้ง REFUND_PENDING + alert LATE_PAYMENT', () => {
    const d = decidePaymentAction(order({ status: STATUS.EXPIRED }), event());
    expect(d.outcome).toBe('LATE_PAYMENT_REFUND');
    expect(d.transition.to).toBe(STATUS.REFUND_PENDING);
    expect(d.alert).toMatchObject({ type: 'LATE_PAYMENT', severity: 'WARNING' });
  });

  test.each(ALL_STATUSES.filter((s) => ![STATUS.PENDING_PAYMENT, STATUS.EXPIRED].includes(s)))(
    'ออเดอร์จ่ายแล้วอยู่สถานะ %s + เงินก้อนใหม่ (ref ต่าง) => DUPLICATE_PAYMENT ไม่เปลี่ยนสถานะ + alert CRITICAL',
    (status) => {
      const d = decidePaymentAction(order({ status, payment_ref: 'pay-ORIGINAL' }), event({ paymentRef: 'pay-SECOND' }));
      expect(d.outcome).toBe('DUPLICATE_PAYMENT');
      expect(d.transition).toBeUndefined();
      expect(d.alert.severity).toBe('CRITICAL');
    }
  );

  test.each(ALL_STATUSES)('paymentRef เดิมส่งมาใหม่ด้วย event id ใหม่ (สถานะ %s) => IGNORED_ALREADY_PAID เงียบ ๆ', (status) => {
    const d = decidePaymentAction(order({ status, payment_ref: 'pay-1' }), event({ eventId: 'evt-NEW' }));
    expect(d).toEqual({ outcome: 'IGNORED_ALREADY_PAID' });
  });

  test('ไม่พบออเดอร์ => UNKNOWN_ORDER + alert CRITICAL (เงินเข้าแต่ไม่รู้ของใคร)', () => {
    const d = decidePaymentAction(null, event());
    expect(d.outcome).toBe('UNKNOWN_ORDER');
    expect(d.alert).toMatchObject({ type: 'PAYMENT_UNKNOWN_ORDER', severity: 'CRITICAL' });
    expect(d.transition).toBeUndefined();
  });

  test.each([
    ['ยอดน้อยกว่า', { amount: 34.99 }],
    ['ยอดมากกว่า', { amount: 35.01 }],
    ['สกุลเงินต่าง', { currency: 'USD' }],
  ])('%s => AMOUNT_MISMATCH ไม่เปลี่ยนสถานะ (กันเติมเกมทั้งที่จ่ายไม่ครบ)', (_, override) => {
    const d = decidePaymentAction(order(), event(override));
    expect(d.outcome).toBe('AMOUNT_MISMATCH');
    expect(d.transition).toBeUndefined();
    expect(d.alert.severity).toBe('CRITICAL');
  });

  test('ยอดเท่ากันแม้ทศนิยมเขียนต่างกัน (35 vs "35.00") => ผ่าน; ปัญหาทศนิยมลอยตัว 0.1+0.2 ไม่ทำให้ยอดเพี้ยน', () => {
    expect(decidePaymentAction(order({ amount: '35.00' }), event({ amount: 35 })).outcome).toBe('APPLIED');
    expect(decidePaymentAction(order({ amount: '0.30' }), event({ amount: 0.1 + 0.2 })).outcome).toBe('APPLIED');
  });

  test('paymentRef ถูกผูกกับออเดอร์อื่นแล้ว => PAYMENT_REF_REUSED (ตรวจก่อนเรื่องยอด/สถานะ)', () => {
    const d = decidePaymentAction(order(), event(), { refOwnerOrderId: 999 });
    expect(d.outcome).toBe('PAYMENT_REF_REUSED');
    expect(d.transition).toBeUndefined();
  });

  test('paymentRef ผูกกับออเดอร์เดียวกันอยู่แล้ว ไม่ใช่การใช้ซ้ำข้ามออเดอร์', () => {
    const d = decidePaymentAction(order({ payment_ref: 'pay-1' }), event(), { refOwnerOrderId: 7 });
    expect(d.outcome).toBe('IGNORED_ALREADY_PAID');
  });

  test('id ที่ได้จาก pg เป็น string (BIGINT) ต้องเทียบกับ id ฝั่งอื่นได้ถูกต้องไม่ว่าชนิดไหน', () => {
    expect(decidePaymentAction(order({ id: '7', payment_ref: 'pay-1' }), event(), { refOwnerOrderId: '7' }).outcome).toBe('IGNORED_ALREADY_PAID');
    expect(decidePaymentAction(order({ id: '7', payment_ref: 'pay-1' }), event(), { refOwnerOrderId: 7 }).outcome).toBe('IGNORED_ALREADY_PAID');
    expect(decidePaymentAction(order({ id: 7, payment_ref: 'pay-1' }), event(), { refOwnerOrderId: '7' }).outcome).toBe('IGNORED_ALREADY_PAID');
    expect(decidePaymentAction(order({ id: '7' }), event(), { refOwnerOrderId: '8' }).outcome).toBe('PAYMENT_REF_REUSED');
  });

  test('การตัดสินใจเป็นฟังก์ชันล้วน: ไม่แก้ order/event ที่รับเข้ามา', () => {
    const o = Object.freeze(order());
    const e = Object.freeze(event());
    expect(() => decidePaymentAction(o, e)).not.toThrow();
  });
});
