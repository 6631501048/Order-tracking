# Order Tracking API

ระบบ Backend ติดตามออเดอร์เติมเกม: ลูกค้าดูได้ว่าออเดอร์อยู่ขั้นไหน, bot ไปจ่ายเงินและเติมเกมให้อัตโนมัติ, และเมื่อ bot ล่มหรือมีปัญหาอื่น ระบบต้อง **ตรวจเจอเอง** และ **แก้ได้เอง** เน้น 3 เรื่อง: **ไม่จ่ายซ้ำ/ไม่ประมวลผลซ้ำ**, **ทุกการเปลี่ยนสถานะตรวจย้อนหลังได้**, และ **ออเดอร์ที่ค้างไม่หายไปเงียบ ๆ**

สร้างด้วย Node.js (Express) และ PostgreSQL รันด้วยคำสั่งเดียว (`docker compose up`) รวม migration

## ฟีเจอร์

- สร้างออเดอร์พร้อม `Idempotency-Key` กดซ้ำหรือเน็ตหลุดแล้วส่งใหม่ก็ไม่เกิดออเดอร์ซ้ำ
- ค้นหาด้วยเลข `ORD-<13 หลัก>-<3 หลัก>` ตรวจรูปแบบ (400) และตอบ 404 เมื่อไม่พบ
- รายการออเดอร์แยก **ปัจจุบัน / ที่ผ่านมา** แบ่งหน้า เรียงใหม่ไปเก่า
- Timeline ประวัติการเปลี่ยนสถานะ บอกว่าใครเป็นคนเปลี่ยน (ลูกค้า / webhook / bot / scheduler / แอดมิน) และเพราะอะไร
- ลูกค้าแจ้งปัญหา แก้ UID แล้วลองใหม่ หรือขอคืนเงินได้เอง
- bot รับงานแบบ atomic มี lease + heartbeat ถ้าเงียบเกินเวลาระบบดึงงานคืนและลองใหม่แบบ exponential backoff ไม่เกิน 3 ครั้ง แล้วย้ายเป็น `DELAYED` พร้อมแจ้งแอดมิน
- รับ webhook ธนาคารที่ตรวจลายเซ็น กันซ้ำ และทนต่อการมาช้า/ผิดลำดับ
- scheduler เบื้องหลังหมดเวลาจ่ายเงิน, ดึง lease คืน, แจ้งเตือนคิวค้างเกิน SLA รันซ้ำกี่รอบก็ไม่เสียหาย
- error รูปแบบเดียวทั้งระบบ และ log JSON ที่ตามรอยด้วยเลขออเดอร์ได้

## เริ่มใช้งาน

ต้องมี **Docker** และ Docker Compose

```bash
# เปิด API + PostgreSQL (สร้างตารางให้อัตโนมัติ ไม่ต้องตั้งค่าอะไรก่อน)
docker compose up --build
```

เปิด <http://localhost:3000/health> เพื่อตรวจว่า API เชื่อมฐานข้อมูลได้ แล้วลองใช้งานผ่าน [`order-tracking.http`](order-tracking.http)

**หมายเหตุ**
- ค่าเริ่มต้นของ token ใน `docker-compose.yml` (`dev-bot-token-change-me` ฯลฯ) ไว้ใช้ตอนพัฒนา/สาธิต **ต้องเปลี่ยนก่อนใช้งานจริง** โดย `cp .env.example .env` แล้วตั้ง `BOT_TOKEN`, `ADMIN_TOKEN`, `WEBHOOK_SECRET`
- ถ้ารันนอก Docker (`npm install && npm start`) แล้วไม่ตั้ง token endpoint ภายในจะตอบ `503 AUTH_NOT_CONFIGURED` แทนการเปิดให้เรียกโดยไม่มี auth
- ฐานข้อมูลของ Compose เปิดที่พอร์ต **5433** (กันชนกับ Postgres บนเครื่อง) ถ้าพอร์ตนี้ถูกใช้อยู่ ให้เปลี่ยนใน `docker-compose.yml`
- ล้างข้อมูลทั้งหมดแล้วเริ่มใหม่: `docker compose down -v`

### ตัวแปรสภาพแวดล้อม

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `PORT` | `3000` | พอร์ต HTTP |
| `DB_HOST` / `DB_PORT` | `localhost` / `5433` | ที่อยู่ PostgreSQL (ภายใน Compose ใช้ `db:5432`) |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `orders` / `orders_pass` / `orders_db` | ข้อมูลเข้าฐานข้อมูล (เปลี่ยนก่อนใช้งานจริง) |
| `DATABASE_URL` | — | ใช้แทน `DB_*` ได้ (เหมาะกับ deploy) |
| `RUN_MIGRATIONS` | `true` | รัน migration ตอนเริ่มแอป |
| `PAYMENT_TTL_MINUTES` | `15` | เวลาที่ให้จ่ายเงินก่อนออเดอร์เป็น `EXPIRED` |
| `BOT_TOKEN` / `ADMIN_TOKEN` | `dev-*-change-me` (เฉพาะใน Compose) | secret ของ `/bot` และ `/admin` |
| `WEBHOOK_SECRET` | `dev-webhook-secret-change-me` (เฉพาะใน Compose) | HMAC secret ของ `POST /webhooks/payment` |
| `BOT_LEASE_SECONDS` | `120` | อายุ lease ตั้งแต่ claim / heartbeat |
| `BOT_MAX_RETRIES` | `3` | จำนวนครั้งสูงสุดที่ retry ได้ก่อนเป็น `DELAYED` |
| `RETRY_BASE_SECONDS` | `30` | ช่วง backoff เริ่มต้น (30, 60, 120 วินาที) |
| `RETRY_MAX_DELAY_SECONDS` | `900` | เพดานเวลาหน่วง retry |
| `SCHEDULER_ENABLED` | `true` | เปิด/ปิด scheduler ใน process |
| `SCHEDULER_INTERVAL_SECONDS` | `15` | ความถี่ scheduler |
| `QUEUE_SLA_SECONDS` | `600` | อยู่ใน `QUEUED` นานเกินนี้ถือว่าผิด SLA แล้วสร้าง alert |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |

## เอกสารที่เกี่ยวข้อง

| ไฟล์ | เนื้อหา |
|---|---|
| [`API.md`](API.md) | เอกสาร API: URL, Method, Header, ตัวอย่าง Request/Response ทั้งสำเร็จและ error, รหัส error ทั้งหมด |
| [`docs/state-machine.md`](docs/state-machine.md) | แผนภาพ state machine, ตารางทรานซิชันที่อนุญาต, schema และใครเป็นคนทำให้สถานะเปลี่ยน |
| [`db/migrations/001_init.sql`](db/migrations/001_init.sql) | SQL สร้างตารางพร้อม constraint และ index |
| [`order-tracking.http`](order-tracking.http) | คำขอทดสอบทุก endpoint (สำเร็จและ error) สำหรับ VS Code REST Client รันจากบนลงล่างได้ต่อเนื่อง ทุกคำขอมีบรรทัด `Expect` |

Endpoint หลัก (รายละเอียดทั้งหมดใน [`API.md`](API.md))

| Method | URL | หน้าที่ |
|---|---|---|
| `POST` | `/orders` | สร้างออเดอร์ (ต้องมี `Idempotency-Key`) |
| `GET` | `/orders/:orderNo` | ค้นหาด้วยเลขออเดอร์ |
| `GET` | `/orders?tab=current\|history&page=` | รายการออเดอร์ แบ่งหน้า ใหม่ไปเก่า |
| `GET` | `/orders/:orderNo/timeline` | ประวัติการเปลี่ยนสถานะ |
| `POST` | `/orders/:orderNo/report-issue` | ลูกค้าแจ้งปัญหา |
| `PATCH` | `/orders/:orderNo/uid` | แก้ UID แล้วลองใหม่ (ออเดอร์ `FAILED`) |
| `POST` | `/orders/:orderNo/refund-request` | ขอคืนเงิน (ออเดอร์ `FAILED` / `DELAYED`) |
| `POST` | `/webhooks/payment` | ธนาคารแจ้งจ่ายเงินสำเร็จ |
| `POST` | `/bot/orders/claim`, `/bot/orders/:orderNo/{heartbeat,complete,fail}` | bot รับงาน / ต่อ lease / ปิดงาน |
| `GET`, `POST` | `/admin/alerts`, `/admin/orders/:orderNo/{requeue,refund}`, `/admin/scheduler/run` | แอดมินดู alert / จัดการออเดอร์ที่ติดปัญหา |

## โครงสร้างโปรเจกต์

```
├── db/migrations/001_init.sql   ตาราง, constraint, index
├── docker-compose.yml           PostgreSQL 16 + app (migrate อัตโนมัติ)
├── Dockerfile
├── order-tracking.http          ไฟล์ทดสอบ API (สำเร็จ + error ทุกแบบ)
├── API.md                       เอกสาร API
├── docs/state-machine.md        state machine และ schema
├── scripts/sign-webhook.js      สร้างลายเซ็น webhook สำหรับทดสอบ (npm run sign)
├── src/
│   ├── server.js, app.js        เริ่มเซิร์ฟเวอร์ / ประกอบ middleware และ route
│   ├── scheduler.js             loop งานเบื้องหลัง
│   ├── db.js, migrate.js        connection pool + withTransaction / migration runner
│   ├── routes/                  รับ-ส่ง HTTP เท่านั้น
│   ├── services/                business logic และ SQL
│   ├── domain/                  ฟังก์ชันล้วน ไม่แตะ DB (state machine, retry, payment policy, signature)
│   ├── validators.js            ตรวจข้อมูลนำเข้า
│   ├── errors.js                AppError
│   ├── logger.js                structured logger (AsyncLocalStorage)
│   └── middleware/              error handler กลาง, request context, token
└── tests/                       unit test (Jest) และ tests/integration (PostgreSQL จริง)
```

แยกเป็น routes → services → domain เพื่อให้ logic สำคัญ (เช่น `decideRetry`, `decidePaymentAction`, `assertTransition`) เป็นฟังก์ชันล้วนที่เทสได้โดยไม่ต้องมีฐานข้อมูล

## การตัดสินใจออกแบบ

### 0. State machine และการเปลี่ยนสถานะทุกครั้งต้องผ่านจุดเดียว

```
ปกติ:    PENDING_PAYMENT → QUEUED → IN_PROGRESS → COMPLETED
มีปัญหา: DELAYED (ล่าช้า/รอตรวจสอบ), FAILED (ไม่สำเร็จ), EXPIRED (หมดอายุ),
         REFUND_PENDING (รอคืนเงิน), REFUNDED (คืนเงินแล้ว)
```

เพิ่ม `REFUND_PENDING` จากที่โจทย์ให้มา เพราะ "ขอคืนเงิน" กับ "คืนเงินแล้ว" เป็นคนละเหตุการณ์ (ระบบนี้ไม่ได้โอนเงินเอง แอดมินเป็นคนยืนยัน) ถ้ารวมเป็นสถานะเดียวจะตอบลูกค้าไม่ได้ว่า "กำลังดำเนินการ" หรือ "เสร็จแล้ว"

กฎทรานซิชันอยู่ที่เดียวใน [`src/domain/orderStatus.js`](src/domain/orderStatus.js) ทุกการเปลี่ยนสถานะผ่าน `applyTransition()` ซึ่งล็อกแถวออเดอร์ (`FOR UPDATE`) ตรวจกฎ เพิ่ม `version` และเขียน `order_events` ใน transaction เดียวกัน ผลคือ **สถานะกับ timeline ไม่มีทางไม่ตรงกัน** และสถานะที่ผิดกฎถูกปฏิเสธ (`409 INVALID_TRANSITION`) ไม่ว่าจะมาจากทางไหน

### เคส 2 — Bot สองตัวแย่งออเดอร์เดียวกัน (claim แบบ atomic)

bot เลือกแถว `QUEUED` ด้วย `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` ใน transaction เดียวกับการเปลี่ยนเป็น `IN_PROGRESS`, ตั้ง lease, เพิ่ม version, เพิ่ม timeline event และสร้าง `fulfillment_attempts` มี unique index บางส่วน `uq_attempt_active_per_order` เป็นด่านสุดท้าย (หนึ่งออเดอร์มี attempt ที่ `IN_FLIGHT`/`SUCCEEDED` ได้ไม่เกิน 1)

เหตุผลที่เลือกวิธีนี้:
- **worker หลายตัวช่วยกันดึงคิวได้โดยไม่รอกัน** `SKIP LOCKED` ข้ามแถวที่ตัวอื่นถืออยู่ ไม่ต้องมี distributed lock แยก
- **ไม่มีสถานะครึ่งทาง** ถ้า insert event หรือ attempt พัง transaction ROLLBACK ทั้งก้อน
- **มีด่านสุดท้ายในฐานข้อมูล** ต่อให้ logic ใน app พลาด unique index ก็กันจ่ายซ้ำ และ CHECK constraint บังคับว่า `locked_by` มีได้เฉพาะตอน `IN_PROGRESS`

ทางเลือกที่พิจารณาแล้วไม่เลือก: optimistic lock (`UPDATE ... WHERE version = $n` แล้ว retry) ทำงานได้เหมือนกันแต่ bot ที่แพ้ต้องวนลองใหม่เอง ส่วน `SKIP LOCKED` ให้แต่ละตัวได้งานถัดไปทันที คอลัมน์ `version` ยังเก็บไว้เป็นตัวนับการเปลี่ยนแปลงเพื่อตรวจสอบย้อนหลัง

### เคส 1 — Bot ล่ม / เงียบ (lease + heartbeat + backoff)

- claim ได้ lease `BOT_LEASE_SECONDS` bot ต้องส่ง heartbeat เพื่อต่ออายุ heartbeat/complete/fail จาก bot ที่ไม่ได้ถือ lease หรือ lease หมดแล้วถูกปฏิเสธ (`409 BOT_LEASE_NOT_OWNED`) bot ที่ถูกดึงงานคืนไปแล้วจึงกลับมาปิดงานทับไม่ได้
- scheduler หา `IN_PROGRESS` ที่ lease หมดอายุ ทำเครื่องหมาย attempt เดิมเป็น `ABANDONED` แล้วส่งเข้านโยบาย retry: หน่วง `RETRY_BASE_SECONDS × 2^(n-1)` (30, 60, 120 วินาที ไม่เกิน `RETRY_MAX_DELAY_SECONDS`) แล้วกลับ `QUEUED`
- ลองใหม่ครบ `BOT_MAX_RETRIES` (3) ครั้งแล้วรอบถัดไปพลาดอีก (รวมทำ 4 รอบ) → `DELAYED` + alert `BOT_RETRY_EXHAUSTED` (CRITICAL)
- "bot รายงาน TRANSIENT error" กับ "bot เงียบจน lease หมด" ใช้ฟังก์ชัน `retryOrDelay` เดียวกัน นับรวมในเพดานเดียวกัน

เหตุผล: เวลา lease/retry คำนวณจากนาฬิกาของฐานข้อมูล (`now()`) ไม่ใช่ของ app เพื่อไม่ให้ clock skew ทำให้ lease หมดเร็วหรือช้าผิดปกติ ส่วนเพดาน retry กัน provider ที่ล่มยาวทำให้งานวนไม่รู้จบ เกินเพดานแล้วให้คนตัดสินใจ (ลองใหม่/คืนเงิน)

### เคส 4 — เติมไม่สำเร็จ (แยก transient / permanent)

bot รายงาน `errorType` มาเอง: `TRANSIENT` (เช่น provider timeout) เข้านโยบาย retry ข้างบน ส่วน `PERMANENT` (เช่น UID ผิด) ไป `FAILED` ทันทีโดยไม่นับ retry เหตุผลถูกเก็บใน timeline และใน `fulfillment_attempts` จากนั้นมีทางออก 2 ทาง:

- ลูกค้า `PATCH /orders/:orderNo/uid` แก้ UID → `QUEUED` (นับ retry ใหม่ ล้าง error เดิม) รับเฉพาะ `FAILED` และ UID ต้องต่างจากเดิม
- ลูกค้า `POST /orders/:orderNo/refund-request` → `REFUND_PENDING` แล้วแอดมินยืนยัน `POST /admin/orders/:orderNo/refund` (แอดมินสั่ง `requeue` ออเดอร์ `DELAYED`/`FAILED` ได้เช่นกัน)

เหตุผล: ไม่ควร retry ข้อมูลที่ผิดถาวรเพราะเปลือง attempt โดยไม่เปลี่ยนผล และ provider อาจนับเป็นการเติมผิดซ้ำ การแก้ UID กับการเปลี่ยนสถานะอยู่ใน transaction เดียว ทุกคำขอล็อกแถวก่อนตรวจสถานะ ถ้าส่งพร้อมกันสำเร็จได้แค่คำขอเดียว

### เคส 3 — Webhook ธนาคารมาซ้ำ / มาช้า / ผิดลำดับ

ทำเป็น 4 ชั้น เรียงจากนอกเข้าใน

1. **ลายเซ็น** ตรวจ `X-Signature` (HMAC-SHA256) จาก **raw bytes** ของ request ก่อนทำอะไรทั้งสิ้น (คำนวณจาก JSON ที่ parse แล้ว stringify ใหม่ไม่ได้ เพราะลำดับ key/ช่องว่างอาจต่าง) เทียบแบบ constant-time
2. **event id** จองด้วย `INSERT INTO processed_webhooks ... ON CONFLICT DO NOTHING` ใน transaction เดียวกับการเปลี่ยนสถานะ ซ้ำ → ตอบ `DUPLICATE_EVENT` ไม่ทำซ้ำ ถ้าประมวลผลพัง ROLLBACK ทั้งก้อน event จึงไม่ถูกจดว่าทำแล้ว ธนาคารส่งซ้ำมาก็ทำต่อได้
3. **เทียบสถานะปัจจุบัน** ล็อกแถวออเดอร์แล้วให้ `decidePaymentAction` (ฟังก์ชันล้วน) ตัดสินจากสถานะ "ตอนนี้": `PENDING_PAYMENT` → `QUEUED`, `EXPIRED` (เงินมาช้า) → `REFUND_PENDING` + alert, สถานะอื่น (จ่ายซ้ำ) / ยอดไม่ตรง / `paymentRef` เคยใช้กับออเดอร์อื่น / ไม่รู้จักออเดอร์ → **ไม่เปลี่ยนสถานะ** แต่สร้าง alert ให้แอดมิน
4. **ฐานข้อมูล** unique index `uq_orders_payment_ref` กันผูกเลขอ้างอิงจ่ายเงินซ้ำข้ามออเดอร์เป็นด่านสุดท้าย

ทุกกรณีที่ประมวลผลแล้วตอบ `200` (รวมกรณีผิดปกติที่แจ้งแอดมินแล้ว) เพื่อให้ธนาคารหยุด retry ส่วน payload ที่ผิดรูปแบบตอบ `400` โดยไม่จด event ให้ส่งใหม่ที่ถูกต้องได้

เหตุผลที่เก็บ event id ในฐานข้อมูลแทน cache ใน memory: ใช้ได้ถูกต้องเมื่อรีสตาร์ท app หรือรันหลาย instance

### เคส 5 — ออเดอร์ค้าง / หมดอายุ (scheduler ที่รันซ้ำได้)

scheduler รันทุก `SCHEDULER_INTERVAL_SECONDS` (และสั่งเองได้ที่ `POST /admin/scheduler/run`) ทำ 3 งาน: `PENDING_PAYMENT` เกินเวลาจ่าย → `EXPIRED`, lease หมด → ดึงคืน (เคส 1), `QUEUED` นานเกิน `QUEUE_SLA_SECONDS` → alert `QUEUE_SLA_BREACH` (ไม่ย้ายสถานะ เพราะออเดอร์ยังอยู่ในคิวปกติ แค่ให้คนดู)

ที่ทำให้ **รันซ้ำได้โดยไม่เสียหาย**:
- เลือกเฉพาะแถวที่ยังเข้าเงื่อนไข แล้วเช็กเงื่อนไขซ้ำหลังล็อกแถว (`FOR UPDATE SKIP LOCKED`) แถวที่จัดการไปแล้ว หรือที่ webhook จ่ายเงินเข้ามาทันก่อน จะถูกข้าม
- alert ใช้ `dedupe_key` unique (ผูกกับรอบที่เข้าคิว) รันกี่รอบก็ได้ alert เดียว
- แต่ละออเดอร์ใช้ transaction ของตัวเอง ออเดอร์หนึ่งพังไม่ลากตัวอื่นไปด้วย
- loop ใช้ `setTimeout` ต่อเนื่อง (ไม่ใช้ `setInterval`) รอบใหม่จึงไม่เริ่มซ้อนตอนรอบเก่ายังไม่จบ และรอบแรกรันเร็ว ๆ หลังสตาร์ทเพื่อเก็บงานค้างจากตอน app ดับ

ไม่ต้องพึ่ง singleton lock ภายนอก เพราะทุกงานป้องกันที่ฐานข้อมูล จึงรันหลาย instance ได้

### Idempotency ของการสร้างออเดอร์

จอง key ด้วย `INSERT ... ON CONFLICT DO NOTHING` ใน transaction เดียวกับการสร้างออเดอร์ แล้วเก็บ response ไว้กับ key เดียวกัน ส่งซ้ำได้ response เดิม (`Idempotent-Replayed: true`) ถ้าสองคำขอมาพร้อมกัน ตัวที่สองรอจนตัวแรก commit แล้วได้ออเดอร์เดียวกัน ถ้าตัวแรกพัง key ไม่ถูกจอง ตัวที่รอจึงสร้างต่อได้ ส่วน key เดิมที่ข้อมูลต่างกัน (เทียบด้วย hash) ตอบ `422`

### Error และ log

- Error ทุกตัวอยู่ในรูป `{ "error": { "code", "message", "details?", "requestId" } }` error ที่ไม่คาดคิดตอบ `500 INTERNAL_ERROR` โดยไม่เปิดเผยรายละเอียดภายใน (log เต็มเก็บฝั่งเซิร์ฟเวอร์)
- log เป็น JSON บรรทัดเดียว ใช้ `AsyncLocalStorage` ติด `requestId` และ `orderNo` ให้ทุกบรรทัดของ request/job เดียวกันโดยไม่ต้องส่ง logger ผ่านทุกฟังก์ชัน `docker compose logs app | grep ORD-2587965432159-458` เห็นทั้ง request, bot, webhook และ scheduler ของออเดอร์นั้น
- ตรวจข้อมูลสองชั้น: ที่ API (`validators.js` แจ้งทุกฟิลด์ที่ผิดในครั้งเดียว) และที่ฐานข้อมูล (CHECK, UNIQUE, FOREIGN KEY)

### Timeline

`order_events` เพิ่มอย่างเดียว ไม่แก้ไขไม่ลบ ทุกการเปลี่ยนสถานะมี `actor` และ `reason` การ heartbeat ก็บันทึกเป็น event (`BOT_HEARTBEAT`) แต่ไม่แสดงใน `GET /orders/:orderNo/timeline` เพื่อไม่ให้ลูกค้าเห็นรายการถี่ ๆ ที่ไม่มีความหมาย ส่วน `ISSUE_REPORTED` ไม่เปลี่ยนสถานะ (ตั้งใจ: ถ้าให้ลูกค้ากดแล้วดึงออเดอร์ออกจากคิวเอง bot จะไม่ได้ทำงานต่อ และ bot ที่ถือ lease อยู่จะถูกแย่งงานกลางคัน) แต่สร้าง alert ให้แอดมินตัดสินใจ

## การทดสอบ

```bash
npm test                                   # unit test (Jest) ไม่ต้องมีฐานข้อมูล
docker compose up -d db && npm run test:int   # integration test กับ PostgreSQL จริง
```

- integration tests ใช้ PostgreSQL ของ Compose ที่ `localhost:5433` และฐานข้อมูล `orders_test`; หากใช้พอร์ตอื่นให้กำหนด `TEST_DB_PORT` (เช่น PowerShell: `$env:TEST_DB_PORT='5432'; npm run test:int`)
- `npm test` 260 เคส (17 ชุด) ครอบคลุม state machine (ทรานซิชันที่อนุญาตและที่ต้องห้าม), นโยบาย retry/backoff, นโยบายตัดสิน webhook, ลายเซ็น, validation, logger, token และการเรียงลำดับ SQL ของแต่ละ service
- `npm run test:int` กว่า 100 เคส ใช้ PostgreSQL จริงเพราะ unit test ที่ mock ฐานข้อมูลพิสูจน์พฤติกรรมของ lock ไม่ได้ ครอบคลุมทั้ง 5 เคส (แยกไฟล์ `case1`-`case5`) และ e2e ตลอดวงจรออเดอร์ เช่น claim พร้อมกันหลาย bot ได้ออเดอร์ไม่ซ้ำ, webhook ซ้ำพร้อมกัน, scheduler รันซ้ำ
- integration test ใช้ฐานข้อมูล `orders_test` แยกเสมอ และปฏิเสธการรันกับฐานข้อมูลที่ชื่อไม่มีคำว่า `test`

ทดสอบด้วยมือผ่าน [`order-tracking.http`](order-tracking.http): ติดตั้งส่วนเสริม REST Client ใน VS Code เปิดไฟล์ แล้วกด "Send Request" ไล่จากบนลงล่าง (สร้างออเดอร์ → จ่ายเงิน → bot รับงาน → เติมสำเร็จ แล้วต่อด้วยเส้นทางเติมไม่สำเร็จ → แก้ UID → คืนเงิน) บรรทัด `Expect` เป็นคำอธิบายผลที่คาดหวัง; คำขอที่ตั้งใจทดสอบ error จะตอบ 4xx ตามที่ระบุ ไม่ใช่ความล้มเหลวของระบบ. มีขั้นตอนที่ต้องทำด้วยมือ 2 จุด คือสร้างลายเซ็น webhook ด้วย `npm run sign -- <เลขออเดอร์>` (REST Client คำนวณ HMAC เองไม่ได้) แล้ววางค่าลงในไฟล์

## ข้อจำกัดและสิ่งที่ทำต่อได้

- endpoint สำหรับลูกค้า (`/orders`) ยังไม่มีระบบล็อกอิน ใครรู้เลขออเดอร์ก็แก้ UID/ขอคืนเงินได้ และ `GET /orders` ที่ไม่ส่ง `customerRef` จะเห็นออเดอร์ของทุกคน ของจริงควรผูกออเดอร์กับตัวตนลูกค้า (เช่น JWT) แล้วกรองตามเจ้าของเสมอ
- token แบบ shared secret ใน header และ scheduler ภายใน process เหมาะกับขอบเขตของโจทย์นี้ ไม่ใช่ระบบ identity สำหรับ production: ควรเก็บ secret ใน secret manager, ใช้ HTTPS, หมุนเวียน token และออก credential แยกต่อ bot/แอดมิน
- webhook ที่ `eventId` เดิมแต่ payload ต่างกัน จะถูกมองเป็นซ้ำและไม่ถูกประมวลผล (ตอบ `DUPLICATE_EVENT`) ยังไม่ได้เทียบ payload เพื่อแจ้งว่าผิดปกติ
- ระบบนี้ไม่ได้โอนเงินคืนเอง `REFUNDED` คือแอดมินยืนยันว่าคืนแล้ว
- แบ่งหน้าแบบ offset ถ้ามีออเดอร์จำนวนมากควรเปลี่ยนเป็น keyset (`created_at, id`) ซึ่งมี index รองรับอยู่แล้ว
- heartbeat เขียน event ทุกครั้ง ถ้ามี bot จำนวนมากควรลดความถี่หรือเก็บแยกตาราง
- ทรานซิชัน `QUEUED → DELAYED` อยู่ใน state machine แต่ยังไม่มี endpoint ที่สั่ง (เผื่อให้แอดมินพักออเดอร์ตรวจสอบ)
- ยังไม่มี rate limit ที่ endpoint สาธารณะ

## การใช้ AI ในการพัฒนา

ใช้ Claude ช่วยออกแบบและเขียนโค้ดแบบทำทีละขั้น (state machine และ schema → Docker Compose → error/logger → API หลัก → แก้เคสทีละข้อ → test → เอกสาร) โดยเรียงจากรากฐานไปหาส่วนที่ซับซ้อน เพราะแต่ละเคสต่อยอดจากขั้นก่อน (เช่น เคส 1 ใช้ claim/attempt ของเคส 2)

การตัดสินใจเรื่องความถูกต้องอิงกับ state machine และ constraint ใน PostgreSQL ไม่ได้ให้ AI ตัดสินจากตัวอย่างโค้ดอย่างเดียว: จุด concurrency ตรวจด้วย integration test กับ PostgreSQL จริง, ส่วน security ตรวจพฤติกรรม fail-closed เมื่อไม่ตั้ง secret, ตรวจ HMAC กับ raw body และทดสอบ token ที่ไม่ตรง

ตัวอย่างสิ่งที่พบจากการตรวจทาน (ไม่เชื่อผลจาก AI ตรง ๆ): ตอนทบทวนก่อนส่งงานพบว่าเอกสารเคยบรรยายพฤติกรรมที่โค้ดไม่ได้ทำ (เช่น `409 WEBHOOK_EVENT_ID_REUSED`, ตัวอย่าง backoff 5/10/20 วินาทีทั้งที่ค่าจริงคือ 30/60/120, และ query ของ `/admin/alerts`) จึงแก้เอกสารให้ตรงกับโค้ดและบันทึกส่วนที่ยังไม่ได้ทำไว้ใน "ข้อจำกัด" แทนการเขียนให้ดูครบ
