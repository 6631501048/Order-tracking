const { logger, runWithContext, setContext, getContext, setLevel, setSink, resetSink } = require('../src/logger');

let lines;
beforeEach(() => {
  lines = [];
  setLevel('debug');
  setSink((l) => lines.push(JSON.parse(l)));
});
afterEach(() => {
  setLevel('silent');
  resetSink();
});

describe('logger', () => {
  test('log เป็น JSON มี time/level/msg และ fields', () => {
    logger.info('hello', { botId: 'b1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'hello', botId: 'b1' });
    expect(new Date(lines[0].time).toString()).not.toBe('Invalid Date');
  });

  test('log ใน context ติด orderNo และ requestId อัตโนมัติ', () => {
    runWithContext({ requestId: 'r1', orderNo: 'ORD-2587965432159-458' }, () => {
      logger.info('claimed');
    });
    expect(lines[0]).toMatchObject({ requestId: 'r1', orderNo: 'ORD-2587965432159-458' });
  });

  test('setContext เติม orderNo กลางคัน และตามไปถึง async ต่อเนื่อง', async () => {
    await runWithContext({ requestId: 'r2' }, async () => {
      logger.info('before');
      setContext({ orderNo: 'ORD-0000000000001-001' });
      await new Promise((r) => setTimeout(r, 5));
      logger.info('after await');
    });
    expect(lines[0].orderNo).toBeUndefined();
    expect(lines[1].orderNo).toBe('ORD-0000000000001-001');
  });

  test('สอง job พร้อมกันไม่ปนกัน (context แยกต่อ job)', async () => {
    const job = (orderNo, delay) =>
      runWithContext({ orderNo }, async () => {
        await new Promise((r) => setTimeout(r, delay));
        logger.info('done');
      });
    await Promise.all([job('ORD-0000000000001-001', 20), job('ORD-0000000000002-002', 1)]);
    const byOrder = Object.fromEntries(lines.map((l) => [l.orderNo, l.msg]));
    expect(Object.keys(byOrder).sort()).toEqual(['ORD-0000000000001-001', 'ORD-0000000000002-002']);
  });

  test('นอก context ไม่มี orderNo; setContext นอก context ไม่ throw', () => {
    expect(() => setContext({ orderNo: 'x' })).not.toThrow();
    logger.info('plain');
    expect(lines[0].orderNo).toBeUndefined();
    expect(getContext()).toEqual({});
  });

  test('งานเบื้องหลังระบุ job + orderNo ใน log ทุกบรรทัด (ตามรอยได้แม้ไม่มี request)', () => {
    runWithContext({ orderNo: 'ORD-0000000000001-001', job: 'reclaim-leases' }, () => logger.info('x'));
    expect(lines[0]).toMatchObject({ orderNo: 'ORD-0000000000001-001', job: 'reclaim-leases' });
  });

  test('Error ใน fields.err ถูกแปลงเป็น object ที่ serialize ได้', () => {
    logger.error('boom', { err: new Error('x') });
    expect(lines[0].err).toMatchObject({ name: 'Error', message: 'x' });
    expect(lines[0].err.stack).toContain('Error: x');
  });

  test('fields ทับ time/level/msg ไม่ได้', () => {
    logger.info('real', { msg: 'fake', level: 'error', time: 'fake' });
    expect(lines[0]).toMatchObject({ msg: 'real', level: 'info' });
    expect(lines[0].time).not.toBe('fake');
  });

  test('กรองตาม level', () => {
    setLevel('warn');
    logger.info('hidden');
    logger.warn('shown');
    expect(lines.map((l) => l.msg)).toEqual(['shown']);
  });

  test('level ที่ไม่รู้จัก => throw', () => {
    expect(() => setLevel('loud')).toThrow();
  });
});
