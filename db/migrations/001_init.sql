-- =====================================================================
-- Order Tracking API : schema เริ่มต้น
-- สถานะต้องตรงกับ src/domain/orderStatus.js (มี test ตรวจให้)
-- =====================================================================

-- ---------------------------------------------------------------------
-- orders : ตารางหลัก + คอลัมน์สำหรับ concurrency / lease / retry
-- ---------------------------------------------------------------------
CREATE TABLE orders (
  id               BIGSERIAL PRIMARY KEY,
  order_no         TEXT        NOT NULL UNIQUE,
  status           TEXT        NOT NULL DEFAULT 'PENDING_PAYMENT',

  -- ข้อมูลออเดอร์เติมเกม
  customer_ref     TEXT        NOT NULL,
  game_code        TEXT        NOT NULL,
  game_uid         TEXT        NOT NULL,
  package_code     TEXT        NOT NULL,
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency         CHAR(3)     NOT NULL DEFAULT 'THB',

  -- การจ่ายเงินของลูกค้า (มาจาก webhook ธนาคาร)
  payment_expires_at TIMESTAMPTZ NOT NULL,
  paid_at          TIMESTAMPTZ,
  payment_ref      TEXT,

  -- Concurrency control (เคส 2) / lease + heartbeat (เคส 1)
  version          INTEGER     NOT NULL DEFAULT 0,
  locked_by        TEXT,
  lease_expires_at TIMESTAMPTZ,

  -- Retry (เคส 1 / 4)
  retry_count      INTEGER     NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at    TIMESTAMPTZ,
  last_error_type  TEXT        CHECK (last_error_type IN ('TRANSIENT', 'PERMANENT')),
  last_error_code  TEXT,
  last_error_message TEXT,

  queued_at        TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT orders_status_chk CHECK (status IN (
    'PENDING_PAYMENT', 'QUEUED', 'IN_PROGRESS', 'COMPLETED',
    'DELAYED', 'FAILED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED'
  )),
  CONSTRAINT orders_order_no_chk CHECK (order_no ~ '^ORD-[0-9]{13}-[0-9]{3}$'),
  -- lock ต้องมาเป็นคู่ และมีได้เฉพาะตอน IN_PROGRESS
  CONSTRAINT orders_lock_pair_chk CHECK ((locked_by IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT orders_lock_status_chk CHECK (locked_by IS NULL OR status = 'IN_PROGRESS')
);

-- bot ดึงงาน: QUEUED ที่ถึงเวลา retry เรียงตามเวลาเข้าคิว (เคส 2)
CREATE INDEX idx_orders_claim ON orders (next_retry_at NULLS FIRST, queued_at, id)
  WHERE status = 'QUEUED';
-- scheduler หา lease ที่หมดอายุ (เคส 1)
CREATE INDEX idx_orders_lease ON orders (lease_expires_at)
  WHERE status = 'IN_PROGRESS';
-- scheduler หาออเดอร์ที่รอจ่ายเกินเวลา (เคส 5)
CREATE INDEX idx_orders_payment_expiry ON orders (payment_expires_at)
  WHERE status = 'PENDING_PAYMENT';
-- รายการออเดอร์ใหม่ -> เก่า + กรองตามสถานะ
CREATE INDEX idx_orders_list ON orders (created_at DESC, id DESC);
CREATE INDEX idx_orders_status_list ON orders (status, created_at DESC, id DESC);
-- กัน payment_ref ซ้ำข้ามออเดอร์
CREATE UNIQUE INDEX uq_orders_payment_ref ON orders (payment_ref) WHERE payment_ref IS NOT NULL;

-- ---------------------------------------------------------------------
-- order_events : timeline ประวัติการเปลี่ยนสถานะ (append-only)
-- ---------------------------------------------------------------------
CREATE TABLE order_events (
  id          BIGSERIAL PRIMARY KEY,
  order_id    BIGINT      NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,                       -- NULL = ตอนสร้างออเดอร์
  to_status   TEXT        NOT NULL,
  event_type  TEXT        NOT NULL,       -- เช่น ORDER_CREATED, PAYMENT_CONFIRMED, BOT_CLAIMED, LEASE_EXPIRED
  reason      TEXT,
  actor       TEXT        NOT NULL,       -- customer | system | scheduler | webhook | bot:<id> | admin
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_events_order ON order_events (order_id, created_at, id);

-- ---------------------------------------------------------------------
-- fulfillment_attempts : รอบที่ bot ไปจ่ายเงิน/เติมเกม
-- unique บางส่วน = ออเดอร์หนึ่งมีรายการที่ "กำลังจ่าย/จ่ายสำเร็จ" ได้ไม่เกิน 1 (เคส 2)
-- ---------------------------------------------------------------------
CREATE TABLE fulfillment_attempts (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT      NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  attempt_no    INTEGER     NOT NULL,
  bot_id        TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'IN_FLIGHT'
                CHECK (status IN ('IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'ABANDONED')),
  error_type    TEXT        CHECK (error_type IN ('TRANSIENT', 'PERMANENT')),
  error_code    TEXT,
  error_message TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  UNIQUE (order_id, attempt_no)
);
CREATE UNIQUE INDEX uq_attempt_active_per_order ON fulfillment_attempts (order_id)
  WHERE status IN ('IN_FLIGHT', 'SUCCEEDED');

-- ---------------------------------------------------------------------
-- processed_webhooks : เก็บ event id ที่ประมวลผลแล้ว (เคส 3)
-- ---------------------------------------------------------------------
CREATE TABLE processed_webhooks (
  event_id     TEXT        PRIMARY KEY,
  provider     TEXT        NOT NULL,
  order_id     BIGINT      REFERENCES orders(id) ON DELETE SET NULL,
  event_type   TEXT        NOT NULL,
  outcome      TEXT        NOT NULL,      -- APPLIED | IGNORED_DUPLICATE_STATE | LATE_REFUND | UNKNOWN_ORDER ...
  payload      JSONB       NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- idempotency_keys : กันสร้างออเดอร์ซ้ำ (POST /orders)
-- request_hash ใช้จับกรณี key เดิมแต่ body ต่าง
-- ---------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  scope           TEXT        NOT NULL DEFAULT 'POST /orders',
  key             TEXT        NOT NULL,
  request_hash    TEXT        NOT NULL,
  response_status INTEGER,
  response_body   JSONB,
  order_id        BIGINT      REFERENCES orders(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- ---------------------------------------------------------------------
-- alerts : แจ้งแอดมิน (เคส 1, 5) — dedupe_key ทำให้ scheduler รันซ้ำได้โดยไม่เกิด alert ซ้ำ
-- ---------------------------------------------------------------------
CREATE TABLE alerts (
  id              BIGSERIAL PRIMARY KEY,
  order_id        BIGINT      REFERENCES orders(id) ON DELETE CASCADE,
  type            TEXT        NOT NULL,   -- BOT_RETRY_EXHAUSTED | QUEUE_SLA_BREACH | LATE_PAYMENT ...
  severity        TEXT        NOT NULL DEFAULT 'WARNING' CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  message         TEXT        NOT NULL,
  dedupe_key      TEXT        NOT NULL UNIQUE,
  acknowledged_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alerts_open ON alerts (created_at DESC) WHERE acknowledged_at IS NULL;
