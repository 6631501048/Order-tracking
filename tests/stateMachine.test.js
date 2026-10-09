const fs = require('fs');
const path = require('path');
const sm = require('../src/domain/orderStatus');

const { STATUS, ALL_STATUSES, TRANSITIONS } = sm;

describe('order state machine', () => {
  test('ทุกสถานะมีนิยามใน TRANSITIONS และปลายทางเป็นสถานะที่มีอยู่จริง', () => {
    for (const from of ALL_STATUSES) {
      expect(Array.isArray(TRANSITIONS[from])).toBe(true);
      for (const to of TRANSITIONS[from]) expect(ALL_STATUSES).toContain(to);
    }
  });

  test('happy path: PENDING_PAYMENT -> QUEUED -> IN_PROGRESS -> COMPLETED', () => {
    expect(sm.canTransition(STATUS.PENDING_PAYMENT, STATUS.QUEUED)).toBe(true);
    expect(sm.canTransition(STATUS.QUEUED, STATUS.IN_PROGRESS)).toBe(true);
    expect(sm.canTransition(STATUS.IN_PROGRESS, STATUS.COMPLETED)).toBe(true);
  });

  test('COMPLETED และ REFUNDED เป็นสถานะสุดท้าย เปลี่ยนต่อไม่ได้', () => {
    expect([...sm.TERMINAL_STATUSES].sort()).toEqual([STATUS.COMPLETED, STATUS.REFUNDED].sort());
    for (const to of ALL_STATUSES) {
      expect(sm.canTransition(STATUS.COMPLETED, to)).toBe(false);
      expect(sm.canTransition(STATUS.REFUNDED, to)).toBe(false);
    }
  });

  test.each([
    [STATUS.PENDING_PAYMENT, STATUS.IN_PROGRESS], // ข้ามคิวไม่ได้
    [STATUS.PENDING_PAYMENT, STATUS.COMPLETED],
    [STATUS.QUEUED, STATUS.COMPLETED],             // ต้องผ่าน IN_PROGRESS
    [STATUS.EXPIRED, STATUS.QUEUED],               // หมดอายุแล้วห้ามกลับเข้าคิวเอง
    [STATUS.COMPLETED, STATUS.REFUNDED],
    [STATUS.REFUND_PENDING, STATUS.QUEUED],
  ])('ห้ามเปลี่ยน %s -> %s', (from, to) => {
    expect(sm.canTransition(from, to)).toBe(false);
    expect(() => sm.assertTransition(from, to)).toThrow(sm.InvalidTransitionError);
  });

  test.each([
    [STATUS.IN_PROGRESS, STATUS.QUEUED],        // lease หมด -> retry (เคส 1)
    [STATUS.IN_PROGRESS, STATUS.DELAYED],       // retry ครบ 3 ครั้ง (เคส 1)
    [STATUS.IN_PROGRESS, STATUS.FAILED],        // permanent error (เคส 4)
    [STATUS.FAILED, STATUS.QUEUED],             // แก้ UID แล้วลองใหม่ (เคส 4)
    [STATUS.PENDING_PAYMENT, STATUS.EXPIRED],   // scheduler (เคส 5)
    [STATUS.EXPIRED, STATUS.REFUND_PENDING],    // จ่ายช้า (เคส 3)
    [STATUS.REFUND_PENDING, STATUS.REFUNDED],
  ])('อนุญาต %s -> %s', (from, to) => {
    expect(sm.canTransition(from, to)).toBe(true);
    expect(() => sm.assertTransition(from, to)).not.toThrow();
  });

  test('เปลี่ยนเป็นสถานะเดิม (no-op) ถือว่าไม่ใช่ transition ที่ถูกต้อง', () => {
    for (const s of ALL_STATUSES) expect(sm.canTransition(s, s)).toBe(false);
  });

  test('สถานะที่ไม่รู้จักถูกปฏิเสธ', () => {
    expect(sm.canTransition('NOPE', STATUS.QUEUED)).toBe(false);
    expect(sm.canTransition(STATUS.QUEUED, 'NOPE')).toBe(false);
    expect(sm.isValidStatus('NOPE')).toBe(false);
  });

  test('InvalidTransitionError มี code และ from/to', () => {
    try {
      sm.assertTransition(STATUS.QUEUED, STATUS.COMPLETED);
    } catch (err) {
      expect(err.code).toBe('INVALID_TRANSITION');
      expect(err.from).toBe(STATUS.QUEUED);
      expect(err.to).toBe(STATUS.COMPLETED);
    }
  });

  test('current กับ history แยกกันครบ ไม่ซ้ำ ไม่ตกหล่น', () => {
    const merged = [...sm.CURRENT_STATUSES, ...sm.HISTORY_STATUSES];
    expect(merged.sort()).toEqual([...ALL_STATUSES].sort());
    expect(sm.CURRENT_STATUSES.filter((s) => sm.HISTORY_STATUSES.includes(s))).toEqual([]);
  });

  test('สถานะสุดท้ายทุกตัวอยู่ใน history (ออเดอร์ที่จบแล้วไม่อยู่ในแท็บปัจจุบัน)', () => {
    for (const s of sm.TERMINAL_STATUSES) expect(sm.HISTORY_STATUSES).toContain(s);
  });
});

describe('schema สอดคล้องกับ state machine', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '001_init.sql'), 'utf8');
  const checkBlock = sql.match(/orders_status_chk CHECK \(status IN \(([\s\S]*?)\)\)/)[1];
  const inSql = [...checkBlock.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);

  test('CHECK constraint ของ orders.status ตรงกับ ALL_STATUSES เป๊ะ', () => {
    expect(inSql.sort()).toEqual([...ALL_STATUSES].sort());
  });
});
