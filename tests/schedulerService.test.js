jest.mock('../src/db', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('../src/services/orderTransitions', () => ({
  applyTransition: jest.fn(),
}));
jest.mock('../src/services/retryService', () => ({
  retryOrDelay: jest.fn(),
}));

const { query, withTransaction } = require('../src/db');
const { applyTransition } = require('../src/services/orderTransitions');
const { retryOrDelay } = require('../src/services/retryService');
const { STATUS } = require('../src/domain/orderStatus');
const {
  expirePendingPayments,
  reclaimExpiredLeases,
  alertStaleQueue,
  runSchedulerOnce,
} = require('../src/services/schedulerService');

describe('repeat-safe order scheduler', () => {
  let client;
  let orderRows;

  beforeEach(() => {
    orderRows = [];
    client = {
      query: jest.fn(async (sql) => {
        if (sql.includes('SELECT * FROM orders')) {
          return { rows: orderRows };
        }
        if (sql.includes('UPDATE fulfillment_attempts')) return { rowCount: 0, rows: [] };
        throw new Error(`Unexpected transaction query: ${sql}`);
      }),
    };
    query.mockImplementation(async (sql) => {
      if (sql.includes('INSERT INTO alerts')) return { rowCount: 0, rows: [] };
      return { rows: [] };
    });
    withTransaction.mockImplementation((work) => work(client));
    applyTransition.mockResolvedValue({});
    retryOrDelay.mockResolvedValue({});
  });

  afterEach(() => jest.clearAllMocks());

  test('expires only currently due unpaid orders and records the transition', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 11 }] }).mockResolvedValueOnce({ rows: [] });
    orderRows = [{ id: 11, order_no: 'ORD-1234567890123-456', status: STATUS.PENDING_PAYMENT }];

    const first = await expirePendingPayments({ limit: 10 });
    const second = await expirePendingPayments({ limit: 10 });

    expect(first).toEqual({ processed: 1, skipped: 0, failed: 0 });
    expect(second).toEqual({ processed: 0, skipped: 0, failed: 0 });
    expect(applyTransition).toHaveBeenCalledWith(client, expect.objectContaining({
      orderId: 11,
      toStatus: STATUS.EXPIRED,
      eventType: 'PAYMENT_EXPIRED',
      actor: 'scheduler',
    }));
    expect(client.query.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
  });

  test('reclaims expired leases using the common bounded retry policy', async () => {
    query.mockResolvedValue({ rows: [{ id: 12 }] });
    orderRows = [{
      id: 12,
      order_no: 'ORD-1234567890123-457',
      status: STATUS.IN_PROGRESS,
      retry_count: 1,
      locked_by: 'bot-1',
    }];

    const result = await reclaimExpiredLeases();

    expect(result).toEqual({ processed: 1, skipped: 0, failed: 0 });
    expect(client.query.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE fulfillment_attempts'), [
      12, 'TRANSIENT', 'BOT_LEASE_EXPIRED', expect.any(String),
    ]);
    expect(retryOrDelay).toHaveBeenCalledWith(client, orderRows[0], expect.objectContaining({
      actor: 'scheduler',
      eventType: 'LEASE_EXPIRED',
      error: expect.objectContaining({ code: 'BOT_LEASE_EXPIRED' }),
    }));
  });

  test('stale queue alerts use a unique per-queue-cycle dedupe key', async () => {
    query.mockResolvedValue({ rowCount: 2, rows: [] });

    const result = await alertStaleQueue();

    expect(result).toEqual({ created: 2 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (dedupe_key) DO NOTHING');
    expect(sql).toContain('extract(epoch from COALESCE(queued_at, created_at))');
    expect(params[1]).toBe(STATUS.QUEUED);
  });

  test('runs all jobs and reports per-job summaries in one scheduler cycle', async () => {
    query.mockResolvedValue({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await runSchedulerOnce();

    expect(result).toEqual({
      expiredPayments: { processed: 0, skipped: 0, failed: 0 },
      reclaimedLeases: { processed: 0, skipped: 0, failed: 0 },
      queueSlaAlerts: { created: 0 },
    });
  });
});
