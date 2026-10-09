const { isValidOrderNo, generateOrderNo, assertValidOrderNo, ORDER_NO_REGEX } = require('../src/domain/orderNo');

describe('orderNo', () => {
  test.each(['ORD-2587965432159-458', 'ORD-0000000000001-000'])('รูปแบบถูก: %s', (v) => {
    expect(isValidOrderNo(v)).toBe(true);
  });

  test.each([
    'ORD-123',
    'ord-2587965432159-458',      // ตัวพิมพ์เล็ก
    'ORD-258796543215-458',       // กลาง 12 หลัก
    'ORD-25879654321590-458',     // กลาง 14 หลัก
    'ORD-2587965432159-45',       // ท้าย 2 หลัก
    'ORD-2587965432159-4581',
    ' ORD-2587965432159-458',
    'ORD-2587965432159-458\n',    // regex ไม่ควรปล่อย newline ท้ายผ่าน
    'ORD-25879654321ab-458',
    '',
    null,
    undefined,
    12345,
    { a: 1 },
  ])('รูปแบบผิด: %j', (v) => {
    expect(isValidOrderNo(v)).toBe(false);
  });

  test('assertValidOrderNo ผิด => AppError 400 INVALID_ORDER_NO พร้อมตัวอย่าง', () => {
    try {
      assertValidOrderNo('ORD-1');
      throw new Error('should throw');
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.code).toBe('INVALID_ORDER_NO');
      expect(err.details.example).toMatch(ORDER_NO_REGEX);
    }
  });

  test('assertValidOrderNo ถูก => คืนค่าเดิม', () => {
    expect(assertValidOrderNo('ORD-2587965432159-458')).toBe('ORD-2587965432159-458');
  });

  test('generateOrderNo ได้รูปแบบถูกเสมอ และไม่ซ้ำกันในชุดตัวอย่างใหญ่', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i += 1) {
      const no = generateOrderNo();
      expect(no).toMatch(ORDER_NO_REGEX);
      seen.add(no);
    }
    expect(seen.size).toBe(2000);
  });
});
