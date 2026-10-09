jest.mock('../src/db', () => ({
  withTransaction: jest.fn(),
}));
jest.mock('../src/services/orderTransitions', () => ({
  applyTransition: jest.fn(),
}));
jest.mock('../src/services/recoveryService', () => ({
  updateUidAndRetry: jest.fn(),
  adminRequeue: jest.fn(),
}));

const { withTransaction } = require('../src/db');
const { applyTransition } = require('../src/services/orderTransitions');
const { STATUS } = require('../src/domain/orderStatus');
const { updateUidAndRetry } = require('../src/services/adminService');

describe('admin UID correction', () => {
  let client;
  let status;

  beforeEach(() => {
    status = STATUS.FAILED;
    client = {
      query: jest.fn(async () => ({ rows: [{ id: 3, status }] })),
    };
    withTransaction.mockImplementation((work) => work(client));
    applyTransition.mockImplementation(async (_client, transition) => ({
      id: 3,
      order_no: 'ORD-1234567890123-456',
      status: transition.toStatus,
      game_uid: transition.updates.game_uid,
      version: 8,
    }));
  });

  afterEach(() => jest.clearAllMocks());

  test.each([STATUS.FAILED, STATUS.DELAYED])('corrects UID and requeues an order in %s', async (fromStatus) => {
    status = fromStatus;
    const result = await updateUidAndRetry('ORD-1234567890123-456', 'corrected-uid');

    expect(result).toEqual({
      orderNo: 'ORD-1234567890123-456',
      status: STATUS.QUEUED,
      gameUid: 'corrected-uid',
    });
    expect(applyTransition).toHaveBeenCalledWith(client, expect.objectContaining({
      orderId: 3,
      toStatus: STATUS.QUEUED,
      eventType: 'ADMIN_UID_CORRECTED_AND_REQUEUED',
      actor: 'admin',
      updates: expect.objectContaining({
        game_uid: 'corrected-uid',
        retry_count: 0,
        next_retry_at: null,
      }),
    }));
  });

  test('validates UID on the customer correction route and protects admin routes', async () => {
    const { createApp } = require('../src/app');
    const request = require('supertest');
    const config = require('../src/config');
    const recovery = require('../src/services/recoveryService');
    const originalToken = config.adminToken;
    config.adminToken = 'test-admin-token';
    try {
      const app = createApp();
      const orderNo = 'ORD-1234567890123-456';
      const denied = await request(app).post(`/admin/orders/${orderNo}/requeue`).send({});
      expect(denied.status).toBe(401);
      const invalid = await request(app).patch(`/orders/${orderNo}/uid`).send({ gameUid: 'invalid uid!' });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
      recovery.updateUidAndRetry.mockResolvedValue({ orderNo, gameUid: 'correct-uid', status: 'QUEUED' });
      const valid = await request(app).patch(`/orders/${orderNo}/uid`).send({ gameUid: 'correct-uid' });
      expect(valid.status).toBe(200);
      expect(recovery.updateUidAndRetry).toHaveBeenCalledWith(orderNo, 'correct-uid');
    } finally {
      config.adminToken = originalToken;
    }
  });

  test('refuses retries from states other than FAILED or DELAYED', async () => {
    status = STATUS.QUEUED;
    await expect(updateUidAndRetry('ORD-1234567890123-456', 'corrected-uid'))
      .rejects.toMatchObject({ code: 'ORDER_NOT_RETRYABLE' });
    expect(applyTransition).not.toHaveBeenCalled();
  });
});
