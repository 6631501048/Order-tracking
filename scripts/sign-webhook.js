/**
 * สร้างลายเซ็น (X-Signature) สำหรับยิง POST /webhooks/payment ด้วยมือ
 *
 *   npm run sign -- ORD-1234567890123-456            # ยอด 35 THB
 *   npm run sign -- ORD-1234567890123-456 120 THB    # ระบุยอดและสกุลเงิน
 *
 * อ่าน WEBHOOK_SECRET จาก .env (หรือ environment); ถ้าไม่ตั้ง ใช้ค่าเริ่มต้นเดียวกับ docker-compose.yml
 * พิมพ์ body (บรรทัดเดียว) และค่า signature ให้คัดลอกไปใส่ในไฟล์ order-tracking.http
 * ต้องส่ง body ตามที่พิมพ์ทุกไบต์ เพราะลายเซ็นคำนวณจาก raw body
 */
require('dotenv').config();
const { sign } = require('../src/domain/signature');

const DEFAULT_SECRET = 'dev-webhook-secret-change-me';

const [orderNo, amountArg = '35', currency = 'THB'] = process.argv.slice(2);
if (!/^ORD-\d{13}-\d{3}$/.test(orderNo || '')) {
  console.error('ใช้: npm run sign -- <orderNo> [amount] [currency]   เช่น ORD-1234567890123-456 35 THB');
  process.exit(1);
}
const amount = Number(amountArg);
if (!Number.isFinite(amount) || amount <= 0) {
  console.error('amount ต้องเป็นตัวเลขมากกว่า 0');
  process.exit(1);
}

const secret = process.env.WEBHOOK_SECRET || DEFAULT_SECRET;
const body = JSON.stringify({
  eventId: `evt-${orderNo}`,
  type: 'payment.succeeded',
  orderNo,
  paymentRef: `pay-${orderNo}`,
  amount,
  currency,
});

console.log('body:');
console.log(body);
console.log('\nX-Signature:');
console.log(sign(secret, body));
