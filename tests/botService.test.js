jest.mock('../src/db', () => ({
  withTransaction: jest.fn(),
}));

const { withTransaction } = require('../src/db');
const config = require('../src/config');
const { STATUS } = require('../src/domain/orderStatus');
const { claimOrder, heartbeat, completeOrder, failOrder } = require('../src/services/botService');

const ORDER_NO = 'ORD-1234567890123-456';
const LEASE_EXPIRES_AT = new Date(Date.now() + 60_000);

function createFakeClient(initial = {}) {
  const state = {
    order: {
      id: 27,
      order_no: ORDER_NO,
      status: STATUS.QUEUED,
      version: 0,
      retry_count: 0,
      next_retry_at: null,
      queued_at: new Date('2026-10-08T14:00:00.000Z'),
      created_at: new Date('2026-10-08T13:00:00.000Z'),
      game_code: 'freefire',
      game_uid: 'uid-123',
      package_code: 'diamonds',
      amount: '35.00',
      currency: 'THB',
      locked_by: null,
      lease_expires_at: null,
      ...initial.order,
    },
    attempts: initial.attempts || [],
    events: [],
    alerts: [],
  };
  const calls = [];

  const client = {
    calls,
    state,
    query: jest.fn(async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        return state.order.status === STATUS.QUEUED ? { rows: [{ ...state.order }] } : { rows: [] };
      }
      if (sql.includes('lease_active') && sql.includes('FOR UPDATE')) {
        return {
          rows: [{
            ...state.order,
            lease_active: state.order.lease_expires_at instanceof Date
              && state.order.lease_expires_at.getTime() > Date.now(),
          }],
        };
      }
      if (sql.startsWith('SELECT * FROM orders WHERE id')) {
        return { rows: [{ ...state.order }] };
      }
      if (sql.includes('FROM orders') && sql.includes('FOR UPDATE')) {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT now() + make_interval')) {
        return { rows: [{ expires_at: LEASE_EXPIRES_AT }] };
      }
      if (sql.includes('MAX(attempt_no)')) {
        const maxAttempt = state.attempts.reduce((max, attempt) => Math.max(max, attempt.attempt_no), 0);
        return { rows: [{ attempt_no: maxAttempt + 1 }] };
      }
      if (sql.startsWith('UPDATE orders SET status')) {
        const updated = { ...state.order, status: params[0], version: state.order.version + 1 };
        const columns = [...sql.matchAll(/([a-z_]+) = \$(\d+)/g)];
        for (const [, column, index] of columns) {
          if (column === 'status' || column === 'version' || column === 'updated_at') continue;
          updated[column] = params[Number(index) - 1];
        }
        state.order = updated;
        return { rows: [{ ...state.order }] };
      }
      if (sql.startsWith('UPDATE orders') && sql.includes('lease_expires_at =')) {
        state.order.lease_expires_at = params[0];
        state.order.version += 1;
        return { rows: [{ version: state.order.version }] };
      }
      if (sql.startsWith('INSERT INTO order_events')) {
        state.events.push({ sql, params });
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO fulfillment_attempts')) {
        state.attempts.push({
          id: state.attempts.length + 1,
          order_id: params[0],
          attempt_no: params[1],
          bot_id: params[2],
          status: 'IN_FLIGHT',
        });
        return { rows: [] };
      }
      if (sql.includes('FROM fulfillment_attempts') && sql.includes('FOR UPDATE')) {
        const attempt = state.attempts.find((item) =>
          item.order_id === params[0] && item.bot_id === params[1] && item.status === 'IN_FLIGHT'
        );
        return { rows: attempt ? [{ id: attempt.id }] : [] };
      }
      if (sql.trimStart().startsWith('UPDATE fulfillment_attempts')) {
        const attempt = state.attempts.find((item) => item.id === params[params.length - 1]);
        if (attempt) {
          attempt.status = sql.includes("'SUCCEEDED'") ? 'SUCCEEDED' : 'FAILED';
          if (attempt.status === 'FAILED') {
            [attempt.error_type, attempt.error_code, attempt.error_message] = params;
          }
          attempt.finished_at = new Date();
        }
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO alerts')) {
        state.alerts.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };

  return client;
}

describe('bot service', () => {
  let client;

  beforeEach(() => {
    client = createFakeClient();
    withTransaction.mockImplementation((work) => work(client));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('claim uses SKIP LOCKED and atomically records in-progress state and attempt', async () => {
    const result = await claimOrder('worker-1');

    const claimSql = client.calls.find(({ sql }) => sql.includes('FOR UPDATE SKIP LOCKED'));
    expect(claimSql).toBeDefined();
    expect(result).toMatchObject({
      orderNo: ORDER_NO,
      gameCode: 'freefire',
      gameUid: 'uid-123',
      packageCode: 'diamonds',
      amount: 35,
      currency: 'THB',
      attemptNo: 1,
    });
    expect(client.state.order).toMatchObject({
      status: STATUS.IN_PROGRESS,
      version: 1,
      locked_by: 'worker-1',
      lease_expires_at: LEASE_EXPIRES_AT,
    });
    expect(client.state.attempts).toEqual([{
      id: 1,
      order_id: 27,
      attempt_no: 1,
      bot_id: 'worker-1',
      status: 'IN_FLIGHT',
    }]);
    expect(client.state.events).toHaveLength(1);
    expect(client.state.events[0].params[3]).toBe('BOT_CLAIMED');
  });

  test('returns null when no queued order can be claimed', async () => {
    client.state.order.status = STATUS.IN_PROGRESS;

    await expect(claimOrder('worker-1')).resolves.toBeNull();

    expect(client.calls).toHaveLength(1);
    expect(client.state.attempts).toHaveLength(0);
  });

  test('heartbeat extends lease only for its current owner and increments version', async () => {
    client.state.order.status = STATUS.IN_PROGRESS;
    client.state.order.locked_by = 'worker-1';
    client.state.order.lease_expires_at = new Date(Date.now() + 10_000);

    const result = await heartbeat(ORDER_NO, 'worker-1');

    expect(result).toEqual({ orderNo: ORDER_NO, leaseExpiresAt: LEASE_EXPIRES_AT.toISOString() });
    expect(client.state.order.lease_expires_at).toBe(LEASE_EXPIRES_AT);
    expect(client.state.order.version).toBe(1);
    expect(client.state.events[0].sql).toContain("'BOT_HEARTBEAT'");
  });

  test('rejects heartbeat from another bot or after lease expiry', async () => {
    client.state.order.status = STATUS.IN_PROGRESS;
    client.state.order.locked_by = 'worker-1';
    client.state.order.lease_expires_at = new Date(Date.now() + 10_000);
    await expect(heartbeat(ORDER_NO, 'worker-2')).rejects.toMatchObject({ code: 'BOT_LEASE_NOT_OWNED' });

    client.state.order.lease_expires_at = new Date(Date.now() - 10_000);
    await expect(heartbeat(ORDER_NO, 'worker-1')).rejects.toMatchObject({ code: 'BOT_LEASE_NOT_OWNED' });
  });

  test('complete marks order and active attempt successful', async () => {
    client.state.order.status = STATUS.IN_PROGRESS;
    client.state.order.locked_by = 'worker-1';
    client.state.order.lease_expires_at = new Date(Date.now() + 60_000);
    client.state.attempts.push({ id: 9, order_id: 27, bot_id: 'worker-1', status: 'IN_FLIGHT' });

    const result = await completeOrder(ORDER_NO, 'worker-1');

    expect(result).toMatchObject({ orderNo: ORDER_NO, status: STATUS.COMPLETED });
    expect(client.state.order).toMatchObject({
      status: STATUS.COMPLETED,
      version: 1,
      locked_by: null,
      lease_expires_at: null,
    });
    expect(client.state.attempts[0].status).toBe('SUCCEEDED');
  });

  test.each([
    ['TRANSIENT', STATUS.QUEUED, 1],
    ['PERMANENT', STATUS.FAILED, 0],
  ])('failure type %s selects status %s with retry_count %i', async (errorType, status, retryCount) => {
    client.state.order.status = STATUS.IN_PROGRESS;
    client.state.order.locked_by = 'worker-1';
    client.state.order.lease_expires_at = new Date(Date.now() + 60_000);
    client.state.attempts.push({ id: 9, order_id: 27, bot_id: 'worker-1', status: 'IN_FLIGHT' });

    const result = await failOrder(ORDER_NO, 'worker-1', {
      errorType,
      errorCode: 'PROVIDER_ERROR',
      message: 'provider failure',
    });

    expect(result).toEqual({ orderNo: ORDER_NO, status });
    expect(client.state.order).toMatchObject({
      status,
      retry_count: retryCount,
      last_error_type: errorType,
      last_error_code: 'PROVIDER_ERROR',
      locked_by: null,
      lease_expires_at: null,
    });
    expect(client.state.attempts[0].status).toBe('FAILED');
    expect(client.state.attempts[0]).toMatchObject({
      error_type: errorType,
      error_code: 'PROVIDER_ERROR',
      error_message: 'provider failure',
    });
  });

  test('transient failures schedule exponential backoff and move to DELAYED after retry limit', async () => {
    client.state.order.status = STATUS.IN_PROGRESS;
    client.state.order.locked_by = 'worker-1';
    client.state.order.lease_expires_at = new Date(Date.now() + 60_000);
    client.state.order.retry_count = 1;
    client.state.attempts.push({ id: 9, order_id: 27, bot_id: 'worker-1', status: 'IN_FLIGHT' });

    await failOrder(ORDER_NO, 'worker-1', {
      errorType: 'TRANSIENT',
      errorCode: 'TIMEOUT',
      message: 'retry me',
    });

    expect(client.calls.find(({ sql }) => sql.includes('make_interval(secs => $1::int)'))).toMatchObject({
      params: [config.retryBaseSeconds * 2],
    });

    client = createFakeClient({
      order: { status: STATUS.IN_PROGRESS, locked_by: 'worker-1', lease_expires_at: new Date(Date.now() + 60_000), retry_count: config.maxRetries },
      attempts: [{ id: 11, order_id: 27, bot_id: 'worker-1', status: 'IN_FLIGHT' }],
    });
    withTransaction.mockImplementation((work) => work(client));

    const result = await failOrder(ORDER_NO, 'worker-1', {
      errorType: 'TRANSIENT',
      errorCode: 'TIMEOUT',
      message: 'retry exhausted',
    });
    expect(result.status).toBe(STATUS.DELAYED);
    expect(client.state.order.retry_count).toBe(config.maxRetries);
    expect(client.state.alerts).toHaveLength(1);
    expect(client.state.alerts[0].params[1]).toBe('BOT_RETRY_EXHAUSTED');
  });
});
