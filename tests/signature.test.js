const { sign, verifySignature } = require('../src/domain/signature');

const secret = 'top-secret';
const body = Buffer.from('{"eventId":"e1","amount":35}');

describe('เคส 3: ตรวจลายเซ็น webhook', () => {
  test('ลายเซ็นถูกต้อง => ผ่าน', () => {
    expect(verifySignature(secret, body, sign(secret, body))).toBe(true);
  });

  test('ตัวพิมพ์ใหญ่/เล็กของ hex และช่องว่างหัวท้ายไม่มีผล', () => {
    const sig = sign(secret, body);
    expect(verifySignature(secret, body, sig.toUpperCase().replace('SHA256', 'sha256'))).toBe(true);
    expect(verifySignature(secret, body, `  ${sig}  `)).toBe(true);
  });

  test('แก้ body แม้ 1 ไบต์ => ไม่ผ่าน', () => {
    const sig = sign(secret, body);
    expect(verifySignature(secret, Buffer.from('{"eventId":"e1","amount":36}'), sig)).toBe(false);
  });

  test('JSON เดียวกันแต่จัดรูปแบบต่าง (ช่องว่าง/ลำดับ key) ต้องไม่ผ่าน เพราะลายเซ็นผูกกับไบต์จริง', () => {
    const sig = sign(secret, body);
    expect(verifySignature(secret, Buffer.from('{ "eventId": "e1", "amount": 35 }'), sig)).toBe(false);
  });

  test('secret ผิด => ไม่ผ่าน', () => {
    expect(verifySignature('other', body, sign(secret, body))).toBe(false);
  });

  test.each([
    [undefined], [null], [''], ['abc'], ['sha256='], ['sha256=zz'], ['sha1=' + 'a'.repeat(40)],
    ['sha256=' + 'a'.repeat(63)], ['sha256=' + 'a'.repeat(65)], [123], [['sha256=' + 'a'.repeat(64)]],
  ])('header ผิดรูปแบบ (%p) => false และไม่ throw', (header) => {
    expect(verifySignature(secret, body, header)).toBe(false);
  });

  test('ไม่มี secret หรือไม่มี raw body => false (ไม่ใช่ผ่านเพราะ HMAC ของค่าว่าง)', () => {
    expect(verifySignature('', body, sign('', body))).toBe(false);
    expect(verifySignature(null, body, sign(secret, body))).toBe(false);
    expect(verifySignature(secret, undefined, sign(secret, body))).toBe(false);
    expect(verifySignature(secret, 'string-not-buffer', sign(secret, body))).toBe(false);
  });
});
