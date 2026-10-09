const { backoffDelaySeconds, decideRetry } = require('../src/domain/retryPolicy');

const policy = { maxRetries: 3, baseSeconds: 30, maxDelaySeconds: 900 };

describe('เคส 1: retry policy (exponential backoff ไม่เกิน 3 ครั้ง)', () => {
  test('หน่วงเพิ่มเป็นเท่าตัวทุกครั้ง: 30, 60, 120 วินาที', () => {
    expect([1, 2, 3].map((n) => backoffDelaySeconds(n, policy))).toEqual([30, 60, 120]);
  });

  test('หน่วงไม่เกิน maxDelay (ไม่พุ่งเป็น Infinity แม้ retry ครั้งที่สูงมาก)', () => {
    expect(backoffDelaySeconds(10, policy)).toBe(900);
    expect(backoffDelaySeconds(5000, policy)).toBe(900);
  });

  test('retry ได้ 3 ครั้ง (นับ 0->1->2->3) ครั้งที่ 4 ยอมแพ้', () => {
    expect(decideRetry(0, policy)).toEqual({ action: 'RETRY', retryCount: 1, delaySeconds: 30 });
    expect(decideRetry(1, policy)).toEqual({ action: 'RETRY', retryCount: 2, delaySeconds: 60 });
    expect(decideRetry(2, policy)).toEqual({ action: 'RETRY', retryCount: 3, delaySeconds: 120 });
    expect(decideRetry(3, policy)).toEqual({ action: 'GIVE_UP', retryCount: 3 });
  });

  test('retryCount เกินเพดานแล้ว (ข้อมูลเพี้ยน) ก็ยังยอมแพ้ ไม่ retry ต่อ', () => {
    expect(decideRetry(99, policy).action).toBe('GIVE_UP');
  });

  test('maxRetries = 0 => ไม่ retry เลย', () => {
    expect(decideRetry(0, { ...policy, maxRetries: 0 }).action).toBe('GIVE_UP');
  });

  test('base = 0 (ใช้ในเทสต์) => ลองใหม่ได้ทันที', () => {
    expect(decideRetry(0, { ...policy, baseSeconds: 0 })).toMatchObject({ action: 'RETRY', delaySeconds: 0 });
  });

  test.each([-1, 1.5, '2', null, undefined, NaN])('retryCount ที่ไม่ใช่จำนวนเต็ม >= 0 (%p) => RangeError', (bad) => {
    expect(() => decideRetry(bad, policy)).toThrow(RangeError);
  });

  test.each([0, -1, 1.5, '1'])('retryNumber ที่ไม่ใช่จำนวนเต็ม >= 1 (%p) => RangeError', (bad) => {
    expect(() => backoffDelaySeconds(bad, policy)).toThrow(RangeError);
  });
});
