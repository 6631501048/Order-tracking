jest.mock('../src/services/schedulerService', () => ({ runSchedulerOnce: jest.fn() }));
const config = require('../src/config');
const schedulerService = require('../src/services/schedulerService');
const { startScheduler } = require('../src/scheduler');

describe('scheduler loop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    schedulerService.runSchedulerOnce.mockReset();
    config.schedulerEnabled = true;
  });
  afterEach(() => jest.useRealTimers());

  test('รันครั้งแรกหลังสตาร์ทไม่นาน แล้ววนซ้ำตามช่วงเวลา', async () => {
    schedulerService.runSchedulerOnce.mockResolvedValue({});
    const s = startScheduler({ intervalSeconds: 10, firstDelayMs: 100 });
    await jest.advanceTimersByTimeAsync(100);
    expect(schedulerService.runSchedulerOnce).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(schedulerService.runSchedulerOnce).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(schedulerService.runSchedulerOnce).toHaveBeenCalledTimes(3);
    s.stop();
  });

  test('รอบหนึ่งพัง loop ไม่ตาย รอบถัดไปยังรัน', async () => {
    schedulerService.runSchedulerOnce.mockRejectedValueOnce(new Error('db down')).mockResolvedValue({});
    const s = startScheduler({ intervalSeconds: 5, firstDelayMs: 0 });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(schedulerService.runSchedulerOnce).toHaveBeenCalledTimes(2);
    s.stop();
  });

  test('รอบใหม่ไม่เริ่มซ้อนตอนรอบเก่ายังไม่จบ (ไม่ใช้ setInterval)', async () => {
    let release;
    schedulerService.runSchedulerOnce.mockImplementation(() => new Promise((r) => { release = r; }));
    const s = startScheduler({ intervalSeconds: 1, firstDelayMs: 0 });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(5_000); // รอบแรกยังค้างอยู่ 5 วินาที
    expect(schedulerService.runSchedulerOnce).toHaveBeenCalledTimes(1);
    release({});
    await jest.advanceTimersByTimeAsync(1_000);
    expect(schedulerService.runSchedulerOnce).toHaveBeenCalledTimes(2);
    s.stop();
  });

  test('stop() แล้วไม่รันอีก แม้กำลังรอรอบถัดไป', async () => {
    schedulerService.runSchedulerOnce.mockResolvedValue({});
    const s = startScheduler({ intervalSeconds: 1, firstDelayMs: 0 });
    await jest.advanceTimersByTimeAsync(0);
    s.stop();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(schedulerService.runSchedulerOnce).toHaveBeenCalledTimes(1);
  });

  test('SCHEDULER_ENABLED=false => ไม่รันเลย', async () => {
    config.schedulerEnabled = false;
    startScheduler({ firstDelayMs: 0 });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(schedulerService.runSchedulerOnce).not.toHaveBeenCalled();
  });
});
