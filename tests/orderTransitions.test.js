const { applyTransition } = require('../src/services/orderTransitions');
const { InvalidTransitionError, STATUS } = require('../src/domain/orderStatus');

function createClient(order) {
  const calls = [];
  const client = {
    calls,
    query: jest.fn(async (sql, values) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT * FROM orders')) return { rows: order ? [{ ...order }] : [] };
      if (sql.startsWith('UPDATE orders')) {
        const updated = {
          ...order,
          status: values[0],
          version: order.version + 1,
        };
        for (let i = 1; i < values.length - 1; i += 1) {
          const column = sql.match(new RegExp(`([a-z_]+) = \\$${i + 1}`))[1];
          updated[column] = values[i];
        }
        return { rows: [updated] };
      }
      if (sql.startsWith('INSERT INTO order_events')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
  return client;
}

const queuedOrder = {
  id: 41,
  order_no: 'ORD-1234567890123-456',
  status: STATUS.QUEUED,
  version: 3,
};

describe('applyTransition', () => {
  test('locks the order, validates transition, increments version, updates fields and writes one event', async () => {
    const client = createClient(queuedOrder);
    const leaseExpiresAt = new Date('2026-10-08T15:00:00.000Z');

    const result = await applyTransition(client, {
      orderId: queuedOrder.id,
      toStatus: STATUS.IN_PROGRESS,
      eventType: 'BOT_CLAIMED',
      actor: 'bot:worker-1',
      metadata: { attemptNo: 1 },
      updates: { locked_by: 'worker-1', lease_expires_at: leaseExpiresAt },
    });

    expect(client.calls.map(({ sql }) => sql.split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'SELECT *',
      'UPDATE orders',
      'INSERT INTO',
    ]);
    expect(client.calls[0].sql).toContain('FOR UPDATE');
    expect(client.calls[1].sql).toContain('version = version + 1');
    expect(client.calls[1].values).toEqual([STATUS.IN_PROGRESS, 'worker-1', leaseExpiresAt, queuedOrder.id]);
    expect(client.calls[2].values).toEqual([
      queuedOrder.id,
      STATUS.QUEUED,
      STATUS.IN_PROGRESS,
      'BOT_CLAIMED',
      null,
      'bot:worker-1',
      JSON.stringify({ attemptNo: 1 }),
    ]);
    expect(result).toMatchObject({
      status: STATUS.IN_PROGRESS,
      version: 4,
      locked_by: 'worker-1',
      lease_expires_at: leaseExpiresAt,
    });
  });

  test('rejects an invalid transition before writing an update or event', async () => {
    const client = createClient(queuedOrder);

    await expect(applyTransition(client, {
      orderId: queuedOrder.id,
      toStatus: STATUS.COMPLETED,
      eventType: 'BOT_COMPLETED',
      actor: 'bot:worker-1',
    })).rejects.toBeInstanceOf(InvalidTransitionError);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.calls[0].sql).toContain('FOR UPDATE');
  });

  test('rejects unapproved update columns without issuing SQL for the update', async () => {
    const client = createClient(queuedOrder);

    await expect(applyTransition(client, {
      orderId: queuedOrder.id,
      toStatus: STATUS.IN_PROGRESS,
      eventType: 'BOT_CLAIMED',
      actor: 'bot:worker-1',
      updates: { status: STATUS.COMPLETED },
    })).rejects.toThrow('Unsupported order update column: status');

    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('reports a missing order instead of recording a transition event', async () => {
    const client = createClient(null);

    await expect(applyTransition(client, {
      orderId: 404,
      toStatus: STATUS.IN_PROGRESS,
      eventType: 'BOT_CLAIMED',
      actor: 'bot:worker-1',
    })).rejects.toThrow('Order 404 disappeared during transition');

    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
