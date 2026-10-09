jest.mock('../src/db', () => ({
  withTransaction: jest.fn(),
}));
jest.mock('../src/services/orderTransitions', () => ({
  applyTransition: jest.fn(),
}));
jest.mock('../src/services/alertService', () => ({
  createAlert: jest.fn(),
}));

const { withTransaction } = require('../src/db');
const { applyTransition } = require('../src/services/orderTransitions');
const { createAlert } = require('../src/services/alertService');
const { STATUS } = require('../src/domain/orderStatus');
const { processPaymentWebhook } = require('../src/services/webhookService');

const payment = Object.freeze({
  eventId: 'evt-123',
  type: 'payment.succeeded',
  orderNo: 'ORD-1234567890123-456',
  paymentRef: 'payment-123',
  amount: 35,
  currency: 'THB',
});

function createClient(initialStatus = STATUS.PENDING_PAYMENT) {
  const processed = new Map();
  const order = {
    id: 17,
    order_no: payment.orderNo,
    status: initialStatus,
    amount: '35.00',
    currency: 'THB',
    payment_ref: null,
  };
  const client = {
    order,
    processed,
    query: jest.fn(async (sql, params = []) => {
      if (sql.includes('INSERT INTO processed_webhooks')) {
        if (processed.has(params[0])) return { rowCount: 0, rows: [] };
        processed.set(params[0], {
          outcome: 'PROCESSING',
          payload: JSON.parse(params[3]),
          orderId: null,
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SELECT outcome FROM processed_webhooks')) {
        const event = processed.get(params[0]);
        return { rows: [{ outcome: event.outcome }] };
      }
      if (sql.includes('SELECT * FROM orders WHERE order_no')) return { rows: [{ ...order }] };
      if (sql.includes('SELECT id FROM orders WHERE payment_ref')) return { rows: [] };
      if (sql.includes('SELECT now() + make_interval')) return { rows: [{ expires_at: new Date() }] };
      if (sql.includes('UPDATE processed_webhooks SET outcome = $2')) {
        const event = processed.get(params[0]);
        event.outcome = params[1];
        event.orderId = params[2];
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
  return client;
}

describe('payment webhook idempotency and state reconciliation', () => {
  let client;

  beforeEach(() => {
    client = createClient();
    withTransaction.mockImplementation((work) => work(client));
    applyTransition.mockImplementation(async (_client, transition) => {
      client.order.status = transition.toStatus;
      return { ...client.order, ...transition.updates };
    });
    createAlert.mockResolvedValue(true);
  });

  afterEach(() => jest.clearAllMocks());

  test('payment moves a pending order to QUEUED and records payment fields', async () => {
    const result = await processPaymentWebhook(payment);

    expect(result).toEqual({ eventId: payment.eventId, outcome: 'APPLIED' });
    expect(applyTransition).toHaveBeenCalledWith(client, expect.objectContaining({
      orderId: 17,
      toStatus: STATUS.QUEUED,
      eventType: 'PAYMENT_CONFIRMED',
      updates: expect.objectContaining({ payment_ref: payment.paymentRef }),
    }));
    expect(client.processed.get(payment.eventId)).toMatchObject({ outcome: 'APPLIED', orderId: 17 });
  });

  test('duplicate event id does not repeat the transition', async () => {
    client.processed.set(payment.eventId, { outcome: 'APPLIED', payload: { ...payment }, orderId: 17 });

    const result = await processPaymentWebhook(payment);

    expect(result).toEqual({
      eventId: payment.eventId,
      outcome: 'DUPLICATE_EVENT',
      previousOutcome: 'APPLIED',
    });
    expect(applyTransition).not.toHaveBeenCalled();
  });

  test('duplicate event id with a different payload is still ignored without another side effect', async () => {
    client.processed.set(payment.eventId, { outcome: 'APPLIED', payload: { ...payment }, orderId: 17 });

    const result = await processPaymentWebhook({ ...payment, paymentRef: 'another-reference' });

    expect(result.outcome).toBe('DUPLICATE_EVENT');
    expect(applyTransition).not.toHaveBeenCalled();
  });

  test('late payment for an expired order transitions to REFUND_PENDING and alerts admin', async () => {
    client = createClient(STATUS.EXPIRED);
    withTransaction.mockImplementation((work) => work(client));

    const result = await processPaymentWebhook(payment);

    expect(result.outcome).toBe('LATE_PAYMENT_REFUND');
    expect(applyTransition).toHaveBeenCalledWith(client, expect.objectContaining({
      toStatus: STATUS.REFUND_PENDING,
      eventType: 'LATE_PAYMENT_RECEIVED',
    }));
    expect(createAlert).toHaveBeenCalledWith(client, expect.objectContaining({ type: 'LATE_PAYMENT' }));
  });

  test('other paid order states are treated as duplicate payment, not transitioned again', async () => {
    client = createClient(STATUS.COMPLETED);
    withTransaction.mockImplementation((work) => work(client));

    const result = await processPaymentWebhook(payment);

    expect(result.outcome).toBe('DUPLICATE_PAYMENT');
    expect(applyTransition).not.toHaveBeenCalled();
    expect(createAlert).toHaveBeenCalledWith(client, expect.objectContaining({ type: 'DUPLICATE_PAYMENT' }));
  });

  test('unknown order is recorded and alerts admin', async () => {
    client.query.mockImplementation(async (sql, params = []) => {
      if (sql.includes('INSERT INTO processed_webhooks')) {
        client.processed.set(params[0], { payload: JSON.parse(params[3]), outcome: 'PROCESSING' });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SELECT * FROM orders WHERE order_no')) return { rows: [] };
      if (sql.includes('SELECT id FROM orders WHERE payment_ref')) return { rows: [] };
      if (sql.includes('SELECT now() + make_interval')) return { rows: [{ expires_at: new Date() }] };
      if (sql.includes('UPDATE processed_webhooks SET outcome = $2')) {
        const event = client.processed.get(params[0]);
        event.outcome = params[1];
        event.orderId = params[2];
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const result = await processPaymentWebhook(payment);

    expect(result.outcome).toBe('UNKNOWN_ORDER');
    expect(client.processed.get(payment.eventId).outcome).toBe('UNKNOWN_ORDER');
    expect(createAlert).toHaveBeenCalledWith(client, expect.objectContaining({ orderId: null }));
  });
});
