# Order Tracking API

REST API ติดตามออเดอร์เติมเกม: สร้างออเดอร์, ดูสถานะและ timeline, bot รับงานไปเติม, รับ webhook การจ่ายเงิน และแอดมินจัดการเคสที่ติดปัญหา

- **Base URL (local):** `http://localhost:3000`
- **รูปแบบข้อมูล:** JSON (UTF-8)
- **เวลา:** ISO 8601 (UTC) เช่น `2026-10-08T08:22:43.200Z`
- **จำนวนเงิน:** ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง (`0 < amount ≤ 1,000,000`) สกุลเงินเริ่มต้น `THB`

## สารบัญ

1. [ข้อกำหนดทั่วไป](#ข้อกำหนดทั่วไป)
2. [Endpoint ทั้งหมด](#endpoint-ทั้งหมด)
3. [Orders](#orders) · [Bot](#bot) · [Webhook](#webhook) · [Admin](#admin) · [Health](#health)
4. [สถานะของออเดอร์](#สถานะของออเดอร์)
5. [รหัส Error ทั้งหมด](#รหัส-error-ทั้งหมด)

---

## ข้อกำหนดทั่วไป

### Headers

| Header | ค่า | ใช้กับ |
|---|---|---|
| `Content-Type` | `application/json` | ทุก request ที่มี body |
| `Idempotency-Key` | 8-128 ตัวอักษร (`A-Z a-z 0-9 _ . : -`) เช่น UUID | `POST /orders` (บังคับ) |
| `X-Bot-Token` | ค่าของ `BOT_TOKEN` | ทุก endpoint ใต้ `/bot` |
| `X-Bot-Id` | รหัส bot 1-64 ตัวอักษร (`A-Z a-z 0-9 _ . : -`) | ทุก endpoint ใต้ `/bot` |
| `X-Admin-Token` | ค่าของ `ADMIN_TOKEN` | ทุก endpoint ใต้ `/admin` |
| `X-Signature` | `sha256=<hex>` HMAC-SHA256 ของ raw body ด้วย `WEBHOOK_SECRET` | `POST /webhooks/payment` |
| `X-Request-Id` | ไม่บังคับ ถ้าส่งมาจะถูกใช้ต่อ ไม่ส่งระบบสร้างให้ | ทุก request (ตอบกลับใน header เสมอ) |

endpoint สำหรับลูกค้า (`/orders`) ยังไม่มีการล็อกอิน ดูข้อจำกัดใน [README](README.md#ข้อจำกัดและสิ่งที่ทำต่อได้)

### รูปแบบ Response

**สำเร็จ:** ข้อมูลอยู่ใน `data` ส่วน list จะมี `pagination` เพิ่มมาด้วย

```json
{ "data": { }, "pagination": { } }
```

**ผิดพลาด:** รูปแบบเดียวกันทุก endpoint

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "ข้อมูลที่ส่งมาไม่ถูกต้อง",
    "details": [],
    "requestId": "3f0c2c1e-6f0a-4a8e-9b53-2d1d1a7d2a10"
  }
}
```

`details` มีเฉพาะบาง error ให้ใช้ `code` ในการเขียนโปรแกรม ส่วน `message` ไว้แสดงผู้ใช้ และนำ `requestId` ไปค้น log ได้ (log เป็น JSON บรรทัดเดียว มี `requestId` และ `orderNo` ทุกบรรทัด)

### การแบ่งหน้า (Pagination)

| Query | ค่าเริ่มต้น | ขอบเขต |
|---|---|---|
| `page` | `1` | 1 - 1,000,000 |
| `pageSize` | `20` | 1 - 100 |

`pagination` ที่ตอบกลับ: `{ "tab": "current", "page": 1, "pageSize": 20, "total": 45, "totalPages": 3 }`

### รูปแบบเลขออเดอร์

`ORD-<ตัวเลข 13 หลัก>-<ตัวเลข 3 หลัก>` เช่น `ORD-2587965432159-458` ทุก endpoint ที่มี `:orderNo` ตรวจรูปแบบก่อน ผิดรูปแบบตอบ `400 INVALID_ORDER_NO` ถูกรูปแบบแต่ไม่มีในระบบตอบ `404 ORDER_NOT_FOUND`

---

## Endpoint ทั้งหมด

| Method | URL | ผู้เรียก | หน้าที่ |
|---|---|---|---|
| `GET` | `/health` | ทุกคน | ตรวจว่า API และฐานข้อมูลพร้อมใช้งาน |
| `POST` | `/orders` | ลูกค้า | สร้างออเดอร์ (กันซ้ำด้วย `Idempotency-Key`) |
| `GET` | `/orders` | ลูกค้า | รายการออเดอร์ `tab=current\|history` แบ่งหน้า ใหม่ไปเก่า |
| `GET` | `/orders/:orderNo` | ลูกค้า | ดูออเดอร์รายตัว |
| `GET` | `/orders/:orderNo/timeline` | ลูกค้า | ประวัติการเปลี่ยนสถานะพร้อมเวลา |
| `POST` | `/orders/:orderNo/report-issue` | ลูกค้า | แจ้งปัญหา |
| `PATCH` | `/orders/:orderNo/uid` | ลูกค้า | แก้ UID แล้วลองใหม่ (ออเดอร์ `FAILED`) |
| `POST` | `/orders/:orderNo/refund-request` | ลูกค้า | ขอคืนเงิน (ออเดอร์ `FAILED` / `DELAYED`) |
| `POST` | `/webhooks/payment` | ธนาคาร | แจ้งจ่ายเงินสำเร็จ |
| `POST` | `/bot/orders/claim` | bot | รับงานหนึ่งออเดอร์จากคิว |
| `POST` | `/bot/orders/:orderNo/heartbeat` | bot | ต่อ lease |
| `POST` | `/bot/orders/:orderNo/complete` | bot | แจ้งเติมสำเร็จ |
| `POST` | `/bot/orders/:orderNo/fail` | bot | แจ้งเติมไม่สำเร็จ |
| `GET` | `/admin/alerts` | แอดมิน | ดู alert |
| `POST` | `/admin/alerts/:alertId/acknowledge` | แอดมิน | รับทราบ alert |
| `POST` | `/admin/orders/:orderNo/requeue` | แอดมิน | ส่งออเดอร์ `DELAYED` / `FAILED` กลับเข้าคิว |
| `POST` | `/admin/orders/:orderNo/refund` | แอดมิน | ยืนยันว่าคืนเงินแล้ว |
| `POST` | `/admin/scheduler/run` | แอดมิน | สั่งรัน scheduler หนึ่งรอบ |

---

## Orders

### POST /orders

สร้างออเดอร์ใหม่ สถานะเริ่มต้น `PENDING_PAYMENT` และมีเวลาจ่ายเงิน `PAYMENT_TTL_MINUTES` (ค่าเริ่มต้น 15 นาที)

**Headers:** `Content-Type: application/json`, `Idempotency-Key`

**Request body**

| ฟิลด์ | ชนิด | จำเป็น | หมายเหตุ |
|---|---|---|---|
| `customerRef` | string | ใช่ | รหัสลูกค้า ยาวไม่เกิน 100 |
| `gameCode` | string | ใช่ | `a-z 0-9 _ -` ไม่เกิน 32 (แปลงเป็นตัวพิมพ์เล็ก) |
| `gameUid` | string | ใช่ | `A-Z a-z 0-9 _ : # -` ไม่เกิน 64 |
| `packageCode` | string | ใช่ | รูปแบบเดียวกับ `gameCode` |
| `amount` | number | ใช่ | มากกว่า 0 ไม่เกิน 1,000,000 ทศนิยมไม่เกิน 2 ตำแหน่ง |
| `currency` | string | ไม่ | รหัส 3 ตัวอักษร ค่าเริ่มต้น `THB` |

```json
{
  "customerRef": "cust-001",
  "gameCode": "freefire",
  "gameUid": "uid-12345",
  "packageCode": "diamonds",
  "amount": 35,
  "currency": "THB"
}
```

**201 Created**

```json
{
  "data": {
    "orderNo": "ORD-2587965432159-458",
    "status": "PENDING_PAYMENT",
    "customerRef": "cust-001",
    "gameCode": "freefire",
    "gameUid": "uid-12345",
    "packageCode": "diamonds",
    "amount": 35,
    "currency": "THB",
    "paymentExpiresAt": "2026-10-08T08:37:43.200Z",
    "paidAt": null,
    "queuedAt": null,
    "completedAt": null,
    "createdAt": "2026-10-08T08:22:43.200Z",
    "updatedAt": "2026-10-08T08:22:43.200Z"
  }
}
```

**การกันซ้ำ:** ส่ง `Idempotency-Key` เดิมพร้อมข้อมูลเดิม จะได้ `201` และออเดอร์เดิม (ไม่สร้างใหม่) พร้อม header `Idempotent-Replayed: true` ส่ง key เดิมแต่ข้อมูลต่างกันได้ `422`

| Status | code | เมื่อไร |
|---|---|---|
| 400 | `MISSING_IDEMPOTENCY_KEY` | ไม่ส่ง `Idempotency-Key` |
| 400 | `INVALID_IDEMPOTENCY_KEY` | รูปแบบ key ไม่ถูกต้อง |
| 400 | `VALIDATION_ERROR` | ข้อมูลผิด (`details` แจ้งทุกฟิลด์ที่ผิดในครั้งเดียว) |
| 400 | `INVALID_JSON` | JSON ผิดรูปแบบ |
| 422 | `IDEMPOTENCY_KEY_REUSED` | key เดิมถูกใช้กับข้อมูลชุดอื่น |

---

### GET /orders

รายการออเดอร์ เรียงใหม่ไปเก่า แบ่งหน้า

| Query | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `tab` | `current` | `current` = ยังต้องมีใครทำอะไรต่อ (`PENDING_PAYMENT`, `QUEUED`, `IN_PROGRESS`, `DELAYED`, `FAILED`, `REFUND_PENDING`) / `history` = จบแล้ว (`COMPLETED`, `EXPIRED`, `REFUNDED`) |
| `page`, `pageSize` | `1`, `20` | ดู [การแบ่งหน้า](#การแบ่งหน้า-pagination) |
| `customerRef` | — | กรองเฉพาะลูกค้าคนนี้ (ถ้าไม่ส่งจะได้ออเดอร์ของทุกคน) |

**200 OK**

```json
{
  "data": [ { "orderNo": "ORD-2587965432159-458", "status": "QUEUED", "...": "..." } ],
  "pagination": { "tab": "current", "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
}
```

| Status | code | เมื่อไร |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `tab` ไม่ใช่ `current` / `history`, `page` / `pageSize` นอกขอบเขต |

---

### GET /orders/:orderNo

**200 OK** — `data` เป็นออเดอร์รูปแบบเดียวกับตอนสร้าง ถ้า bot เคยรายงานปัญหา จะมี `issue` เพิ่ม

```json
{
  "data": {
    "orderNo": "ORD-2587965432159-458",
    "status": "FAILED",
    "gameUid": "uid-wrong-0001",
    "issue": { "code": "WRONG_UID", "message": "ไม่พบผู้เล่นตาม UID นี้" },
    "...": "..."
  }
}
```

| Status | code | เมื่อไร |
|---|---|---|
| 400 | `INVALID_ORDER_NO` | รูปแบบเลขออเดอร์ไม่ถูกต้อง (`details.example` ให้ตัวอย่าง) |
| 404 | `ORDER_NOT_FOUND` | ไม่พบออเดอร์ |

---

### GET /orders/:orderNo/timeline

ประวัติการเปลี่ยนสถานะเรียงเก่าไปใหม่ พร้อมผู้ทำ (`actor`) และเหตุผล รายการ `BOT_HEARTBEAT` ไม่แสดง

**200 OK**

```json
{
  "data": {
    "orderNo": "ORD-2587965432159-458",
    "status": "QUEUED",
    "events": [
      {
        "fromStatus": null,
        "toStatus": "PENDING_PAYMENT",
        "eventType": "ORDER_CREATED",
        "reason": "สร้างออเดอร์",
        "actor": "customer",
        "createdAt": "2026-10-08T08:22:43.200Z"
      },
      {
        "fromStatus": "PENDING_PAYMENT",
        "toStatus": "QUEUED",
        "eventType": "PAYMENT_CONFIRMED",
        "reason": "ได้รับการชำระเงิน เข้าคิวรอ bot",
        "actor": "webhook",
        "createdAt": "2026-10-08T08:23:10.512Z"
      }
    ]
  }
}
```

`actor` คือ `customer`, `webhook`, `scheduler`, `admin` หรือ `bot:<botId>`

| Status | code |
|---|---|
| 400 | `INVALID_ORDER_NO` |
| 404 | `ORDER_NOT_FOUND` |

---

### POST /orders/:orderNo/report-issue

ลูกค้าแจ้งปัญหา บันทึกลง timeline (`ISSUE_REPORTED`) และสร้าง alert ให้แอดมิน **ไม่เปลี่ยนสถานะออเดอร์** เพื่อไม่ให้ลูกค้าดึงงานออกจากคิวหรือแย่ง bot ที่กำลังทำงานอยู่

**Request body**

| ฟิลด์ | ชนิด | จำเป็น | หมายเหตุ |
|---|---|---|---|
| `category` | string | ใช่ | `NOT_RECEIVED`, `WRONG_UID`, `PAYMENT_PROBLEM`, `OTHER` |
| `message` | string | ใช่ | ไม่เกิน 1,000 ตัวอักษร |

```json
{ "category": "NOT_RECEIVED", "message": "จ่ายเงินแล้ว 1 ชั่วโมงยังไม่ได้เพชร" }
```

**201 Created**

```json
{
  "data": {
    "orderNo": "ORD-2587965432159-458",
    "status": "QUEUED",
    "category": "NOT_RECEIVED",
    "reportedAt": "2026-10-08T09:30:00.000Z"
  }
}
```

| Status | code | เมื่อไร |
|---|---|---|
| 400 | `VALIDATION_ERROR` / `INVALID_ORDER_NO` | ข้อมูลหรือเลขออเดอร์ผิด |
| 404 | `ORDER_NOT_FOUND` | ไม่พบออเดอร์ |

---

### PATCH /orders/:orderNo/uid

เคสเติมไม่สำเร็จเพราะ UID ผิด: ลูกค้าแก้ UID แล้วออเดอร์กลับเข้าคิว (`FAILED` → `QUEUED`) นับ retry ใหม่จากศูนย์

```json
{ "gameUid": "uid-correct-0002" }
```

**200 OK** — `data` เป็นออเดอร์ (status `QUEUED`, `gameUid` ใหม่)

| Status | code | เมื่อไร |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `gameUid` ผิดรูปแบบ |
| 409 | `UID_UPDATE_NOT_ALLOWED` | ออเดอร์ไม่ได้อยู่ในสถานะ `FAILED` (`details.status` บอกสถานะปัจจุบัน) |
| 422 | `UID_UNCHANGED` | UID ใหม่ซ้ำกับของเดิม |

---

### POST /orders/:orderNo/refund-request

ลูกค้าขอคืนเงิน (`FAILED` / `DELAYED` → `REFUND_PENDING`) และสร้าง alert ให้แอดมิน ไม่มี body

**200 OK** — `data` เป็นออเดอร์ (status `REFUND_PENDING`)

| Status | code | เมื่อไร |
|---|---|---|
| 409 | `REFUND_NOT_ALLOWED` | ออเดอร์ไม่ได้อยู่ใน `FAILED` / `DELAYED` |

---

## Bot

ทุก request ต้องมี `X-Bot-Token` และ `X-Bot-Id` ผิด token ได้ `401 UNAUTHORIZED` ไม่ส่ง `X-Bot-Id` ได้ `400 VALIDATION_ERROR`

### POST /bot/orders/claim

รับงานหนึ่งออเดอร์ที่พร้อมทำ (`QUEUED` และถึงเวลา retry แล้ว) เรียงตามเวลาเข้าคิว ใช้ `FOR UPDATE SKIP LOCKED` ใน transaction เดียวกับการเปลี่ยนเป็น `IN_PROGRESS` ตั้ง lease และสร้าง attempt จึงไม่มี bot สองตัวได้ออเดอร์เดียวกัน ไม่มี body

**200 OK**

```json
{
  "data": {
    "orderNo": "ORD-2587965432159-458",
    "gameCode": "freefire",
    "gameUid": "uid-12345",
    "packageCode": "diamonds",
    "amount": 35,
    "currency": "THB",
    "attemptNo": 1,
    "leaseExpiresAt": "2026-10-08T09:32:00.000Z"
  }
}
```

ไม่มีงานในคิว: `{ "data": null }`

### POST /bot/orders/:orderNo/heartbeat

ต่อ lease อีก `BOT_LEASE_SECONDS` (ค่าเริ่มต้น 120 วินาที) ถ้า bot เงียบจน lease หมด scheduler จะดึงงานคืน

**200 OK**

```json
{ "data": { "orderNo": "ORD-2587965432159-458", "leaseExpiresAt": "2026-10-08T09:34:00.000Z" } }
```

### POST /bot/orders/:orderNo/complete

แจ้งเติมสำเร็จ (`IN_PROGRESS` → `COMPLETED`) ไม่มี body

**200 OK**

```json
{ "data": { "orderNo": "ORD-2587965432159-458", "status": "COMPLETED", "completedAt": "2026-10-08T09:33:10.000Z" } }
```

### POST /bot/orders/:orderNo/fail

แจ้งเติมไม่สำเร็จ

| ฟิลด์ | ชนิด | จำเป็น | หมายเหตุ |
|---|---|---|---|
| `errorType` | string | ใช่ | `TRANSIENT` ลองใหม่ได้ / `PERMANENT` ลองใหม่ไปก็ไม่หาย (เช่น UID ผิด) |
| `errorCode` | string | ใช่ | เช่น `PROVIDER_TIMEOUT`, `WRONG_UID` |
| `message` | string | ใช่ | ไม่เกิน 500 ตัวอักษร เก็บไว้ใน timeline |

```json
{ "errorType": "TRANSIENT", "errorCode": "PROVIDER_TIMEOUT", "message": "ผู้ให้บริการไม่ตอบกลับ" }
```

**200 OK**

```json
{ "data": { "orderNo": "ORD-2587965432159-458", "status": "QUEUED" } }
```

| `errorType` | ผลลัพธ์ |
|---|---|
| `TRANSIENT` | กลับ `QUEUED` พร้อมหน่วง `RETRY_BASE_SECONDS × 2^(n-1)` วินาที (30, 60, 120) ถ้าลองใหม่ครบ `BOT_MAX_RETRIES` ครั้งแล้วพลาดอีก เป็น `DELAYED` และสร้าง alert `BOT_RETRY_EXHAUSTED` |
| `PERMANENT` | เป็น `FAILED` ทันที ไม่ retry อัตโนมัติ รอลูกค้าแก้ UID หรือขอคืนเงิน |

**Error ที่ใช้ร่วมกันของ heartbeat / complete / fail**

| Status | code | เมื่อไร |
|---|---|---|
| 409 | `BOT_LEASE_NOT_OWNED` | bot ไม่ได้ถือ lease ของออเดอร์นี้ / lease หมดอายุแล้ว / ออเดอร์ไม่ได้อยู่ใน `IN_PROGRESS` |
| 409 | `FULFILLMENT_ATTEMPT_NOT_FOUND` | (complete, fail) ไม่พบ attempt ที่กำลังทำของ bot นี้ |
| 404 | `ORDER_NOT_FOUND` | ไม่พบออเดอร์ |

---

## Webhook

### POST /webhooks/payment

ธนาคารแจ้งจ่ายเงินสำเร็จ ตรวจลายเซ็นจาก raw body ก่อนทำอะไรทั้งสิ้น

**Headers:** `Content-Type: application/json`, `X-Signature: sha256=<hex>`

คำนวณลายเซ็น (Node.js) หรือใช้ `npm run sign -- <orderNo>`

```js
require('crypto').createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')
```

**Request body**

```json
{
  "eventId": "provider-event-123",
  "type": "payment.succeeded",
  "orderNo": "ORD-2587965432159-458",
  "paymentRef": "payment-reference-123",
  "amount": 35,
  "currency": "THB"
}
```

`type` อื่นที่ไม่รู้จักจะถูกบันทึกแล้วข้าม (`IGNORED_UNSUPPORTED_TYPE`) ไม่ถือเป็น error

**200 OK** — `data.outcome` บอกว่าระบบทำอะไร ทุกกรณีที่ประมวลผลแล้วตอบ 200 เพื่อให้ธนาคารหยุดส่งซ้ำ

```json
{ "data": { "eventId": "provider-event-123", "outcome": "APPLIED" } }
```

| `outcome` | ความหมาย |
|---|---|
| `APPLIED` | ออเดอร์ `PENDING_PAYMENT` → `QUEUED` |
| `DUPLICATE_EVENT` | `eventId` เคยประมวลผลแล้ว ไม่ทำซ้ำ (มี `previousOutcome` ประกอบ) |
| `IGNORED_ALREADY_PAID` | `paymentRef` เดิมของออเดอร์นี้ ส่งมาใหม่ด้วย `eventId` ใหม่ ไม่ต้องทำอะไร |
| `LATE_PAYMENT_REFUND` | เงินเข้าหลังออเดอร์ `EXPIRED` → `REFUND_PENDING` + alert `LATE_PAYMENT` |
| `DUPLICATE_PAYMENT` | ออเดอร์จ่ายไปแล้วแต่มีเงินเข้าอีกก้อน ไม่เปลี่ยนสถานะ + alert `DUPLICATE_PAYMENT` |
| `AMOUNT_MISMATCH` | ยอดหรือสกุลเงินไม่ตรงออเดอร์ ไม่เปลี่ยนสถานะ + alert `PAYMENT_AMOUNT_MISMATCH` |
| `PAYMENT_REF_REUSED` | `paymentRef` เคยผูกกับออเดอร์อื่น ไม่เปลี่ยนสถานะ + alert `PAYMENT_REF_REUSED` |
| `UNKNOWN_ORDER` | ไม่มีออเดอร์นี้ในระบบ + alert `PAYMENT_UNKNOWN_ORDER` |
| `IGNORED_UNSUPPORTED_TYPE` | `type` ที่ไม่รองรับ |

| Status | code | เมื่อไร |
|---|---|---|
| 400 | `VALIDATION_ERROR` | body ผิด (ไม่จด event ไว้ ธนาคารส่งใหม่ที่ถูกต้องได้) |
| 401 | `INVALID_SIGNATURE` | ไม่ส่งลายเซ็น หรือลายเซ็นไม่ตรง |
| 503 | `AUTH_NOT_CONFIGURED` | ยังไม่ได้ตั้ง `WEBHOOK_SECRET` |

---

## Admin

ทุก request ต้องมี `X-Admin-Token` ผิด token ได้ `401 UNAUTHORIZED` ยังไม่ได้ตั้ง `ADMIN_TOKEN` ได้ `503 AUTH_NOT_CONFIGURED`

### GET /admin/alerts

| Query | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `status` | `open` | `open` = ยังไม่รับทราบ / `all` = ทั้งหมด |
| `limit` | `50` | 1 - 200 เรียงใหม่ไปเก่า |

**200 OK**

```json
{
  "data": [
    {
      "id": 12,
      "orderNo": "ORD-2587965432159-458",
      "type": "BOT_RETRY_EXHAUSTED",
      "severity": "CRITICAL",
      "message": "ORD-2587965432159-458 ลองใหม่ครบ 3 ครั้งแล้วยังไม่สำเร็จ (PROVIDER_TIMEOUT) ย้ายเป็น DELAYED รอตรวจสอบ",
      "createdAt": "2026-10-08T09:40:00.000Z",
      "acknowledgedAt": null
    }
  ]
}
```

`type` ที่พบ: `BOT_RETRY_EXHAUSTED`, `QUEUE_SLA_BREACH`, `CUSTOMER_REPORT`, `REFUND_REQUESTED`, `LATE_PAYMENT`, `DUPLICATE_PAYMENT`, `PAYMENT_AMOUNT_MISMATCH`, `PAYMENT_REF_REUSED`, `PAYMENT_UNKNOWN_ORDER`

### POST /admin/alerts/:alertId/acknowledge

รับทราบ alert กดซ้ำได้ผลเหมือนเดิม **200 OK** — `data` เป็น alert (`acknowledgedAt` มีค่า)

| Status | code |
|---|---|
| 400 | `INVALID_ALERT_ID` |
| 404 | `ALERT_NOT_FOUND` |

### POST /admin/orders/:orderNo/requeue

ส่งออเดอร์ `DELAYED` / `FAILED` กลับเข้าคิว (นับ retry ใหม่จากศูนย์) **200 OK** — `data` เป็นออเดอร์ (status `QUEUED`)

| Status | code | เมื่อไร |
|---|---|---|
| 409 | `REQUEUE_NOT_ALLOWED` | ออเดอร์ไม่ได้อยู่ใน `DELAYED` / `FAILED` |

### POST /admin/orders/:orderNo/refund

ยืนยันว่าคืนเงินแล้ว (`REFUND_PENDING` → `REFUNDED`) ระบบนี้ไม่ได้โอนเงินเอง **200 OK** — `data` เป็นออเดอร์

| Status | code | เมื่อไร |
|---|---|---|
| 409 | `REFUND_NOT_PENDING` | ออเดอร์ไม่ได้อยู่ใน `REFUND_PENDING` |

### POST /admin/scheduler/run

รัน scheduler หนึ่งรอบทันที (ไว้ demo/ทดสอบ) รันซ้ำได้ปลอดภัย

**200 OK**

```json
{
  "data": {
    "expiredPayments": { "processed": 1, "skipped": 0, "failed": 0 },
    "reclaimedLeases": { "processed": 0, "skipped": 0, "failed": 0 },
    "queueSlaAlerts": { "created": 0 }
  }
}
```

---

## Health

### GET /health

**200 OK** `{ "status": "ok", "db": "up" }` ถ้าเชื่อมฐานข้อมูลไม่ได้จะตอบ `500 INTERNAL_ERROR`

---

## สถานะของออเดอร์

| สถานะ | ความหมาย | ไปต่อได้ |
|---|---|---|
| `PENDING_PAYMENT` | รอลูกค้าจ่ายเงิน | `QUEUED`, `EXPIRED` |
| `QUEUED` | จ่ายแล้ว รอ bot รับงาน | `IN_PROGRESS`, `DELAYED` |
| `IN_PROGRESS` | bot กำลังเติม (ถือ lease) | `COMPLETED`, `QUEUED`, `DELAYED`, `FAILED` |
| `COMPLETED` | เติมสำเร็จ | — |
| `DELAYED` | ลองใหม่ครบแล้วยังไม่สำเร็จ รอแอดมินตรวจ | `QUEUED`, `FAILED`, `REFUND_PENDING` |
| `FAILED` | เติมไม่สำเร็จแบบถาวร (เช่น UID ผิด) | `QUEUED`, `REFUND_PENDING` |
| `EXPIRED` | ไม่จ่ายเงินภายในเวลาที่กำหนด | `REFUND_PENDING` (กรณีเงินเข้ามาช้า) |
| `REFUND_PENDING` | รอคืนเงิน | `REFUNDED` |
| `REFUNDED` | คืนเงินแล้ว | — |

แผนภาพและ schema อยู่ใน [`docs/state-machine.md`](docs/state-machine.md) การเปลี่ยนสถานะที่ไม่อยู่ในตารางนี้ตอบ `409 INVALID_TRANSITION`

---

## รหัส Error ทั้งหมด

| Status | code | ความหมาย |
|---|---|---|
| 400 | `VALIDATION_ERROR` | ข้อมูลหรือพารามิเตอร์ผิด (`details` ระบุฟิลด์) |
| 400 | `INVALID_JSON` | JSON ผิดรูปแบบ |
| 400 | `INVALID_ORDER_NO` | รูปแบบเลขออเดอร์ไม่ถูกต้อง |
| 400 | `INVALID_ALERT_ID` | `alertId` ไม่ใช่จำนวนเต็มบวก |
| 400 | `MISSING_IDEMPOTENCY_KEY` | ไม่ส่ง `Idempotency-Key` |
| 400 | `INVALID_IDEMPOTENCY_KEY` | `Idempotency-Key` ผิดรูปแบบ |
| 400 | `INVALID_INPUT` / `INVALID_REFERENCE` | ฐานข้อมูลปฏิเสธรูปแบบข้อมูล (กันเหนียว ปกติไม่เจอ) |
| 401 | `UNAUTHORIZED` | token ไม่ถูกต้องหรือไม่ได้ส่ง |
| 401 | `INVALID_SIGNATURE` | ลายเซ็น webhook ไม่ถูกต้อง |
| 404 | `ORDER_NOT_FOUND` | ไม่พบออเดอร์ |
| 404 | `ALERT_NOT_FOUND` | ไม่พบ alert |
| 404 | `ROUTE_NOT_FOUND` | ไม่มี endpoint นี้ |
| 409 | `BOT_LEASE_NOT_OWNED` | bot ไม่ได้ถือ lease ที่ยังใช้งานได้ |
| 409 | `FULFILLMENT_ATTEMPT_NOT_FOUND` | ไม่พบ attempt ที่กำลังทำของ bot |
| 409 | `UID_UPDATE_NOT_ALLOWED` | แก้ UID ได้เฉพาะออเดอร์ `FAILED` |
| 409 | `REFUND_NOT_ALLOWED` | ขอคืนเงินได้เฉพาะ `FAILED` / `DELAYED` |
| 409 | `REQUEUE_NOT_ALLOWED` | requeue ได้เฉพาะ `DELAYED` / `FAILED` |
| 409 | `REFUND_NOT_PENDING` | ยืนยันคืนเงินได้เฉพาะ `REFUND_PENDING` |
| 409 | `INVALID_TRANSITION` | เปลี่ยนสถานะผิดกฎ state machine (`details.from`, `details.to`) |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | คำขอที่ใช้ key เดียวกันกำลังประมวลผลอยู่ ลองใหม่ |
| 409 | `DUPLICATE` | ข้อมูลซ้ำกับที่มีอยู่ (กันเหนียวจาก unique constraint) |
| 413 | `PAYLOAD_TOO_LARGE` | body เกิน 100 KB |
| 422 | `IDEMPOTENCY_KEY_REUSED` | key เดิมใช้กับข้อมูลชุดอื่น |
| 422 | `UID_UNCHANGED` | UID ใหม่ซ้ำกับของเดิม |
| 500 | `INTERNAL_ERROR` | ความผิดพลาดภายใน (ไม่เปิดเผยรายละเอียดออกไป ดู log ด้วย `requestId`) |
| 503 | `AUTH_NOT_CONFIGURED` | ยังไม่ได้ตั้ง token / secret ที่ endpoint นั้นต้องใช้ |
