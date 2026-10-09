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
const { retryOrDelay } = require('../src/services/retryService');
const { STATUS } = require('../src/domain/orderStatus');
const { reclaimExpiredLeases } = require('../src/services/schedulerService');

describe('expired bot lease recovery', () => {
  let client;
  let lockedOrder;

  beforeEach(() => {
    lockedOrder = {
      id: 23,
      order_no: 'ORD-1234567890123-456',
      status: STATUS.IN_PROGRESS,
      retry_count: 1,
      locked_by: 'worker-1',
    };
    client = {
      query: jest.fn(async (sql) => {
        if (sql.includes('SELECT * FROM orders')) return { rows: [lockedOrder] };
        if (sql.includes('UPDATE fulfillment_attempts')) return { rowCount: 1, rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    query.mockResolvedValue({ rows: [{ id: lockedOrder.id }] });
    withTransaction.mockImplementation((work) => work(client));
    retryOrDelay.mockResolvedValue({ action: 'RETRY' });
  });

  afterEach(() => jest.clearAllMocks());

  test('locks and rechecks expired lease before abandoning attempt and applying retry policy', async () => {
    const result = await reclaimExpiredLeases({ limit: 25 });

    expect(result).toEqual({ processed: 1, skipped: 0, failed: 0 });
    expect(client.query.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(client.query.mock.calls[0][1]).toEqual([lockedOrder.id, STATUS.IN_PROGRESS]);
    expect(client.query.mock.calls[1][0]).toContain("status = 'IN_FLIGHT'");
    expect(retryOrDelay).toHaveBeenCalledWith(client, lockedOrder, expect.objectContaining({
      actor: 'scheduler',
      eventType: 'LEASE_EXPIRED',
      metadata: { previousBot: 'worker-1' },
    }));
  });

  test('skips candidates whose lease was renewed before the row lock', async () => {
    query.mockResolvedValue({ rows: [{ id: lockedOrder.id }] });
    client.query.mockResolvedValueOnce({ rows: [] });

    const result = await reclaimExpiredLeases();

    expect(result).toEqual({ processed: 0, skipped: 1, failed: 0 });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(retryOrDelay).not.toHaveBeenCalled();
  });
});
