const config = require('./config');
const { logger } = require('./logger');
const schedulerService = require('./services/schedulerService');

/**
 * วนรันงานเบื้องหลังเป็นรอบ ๆ ด้วย setTimeout ต่อเนื่อง (ไม่ใช้ setInterval)
 * เพื่อไม่ให้รอบใหม่เริ่มซ้อนตอนรอบเก่ายังไม่จบ; error ในรอบหนึ่งไม่ทำให้ loop ตาย
 */
function startScheduler({ intervalSeconds = config.schedulerIntervalSeconds, firstDelayMs = 1000 } = {}) {
  if (!config.schedulerEnabled) {
    logger.info('scheduler disabled (SCHEDULER_ENABLED=false)');
    return { stop() {} };
  }
  let stopped = false;
  let timer = null;

  const schedule = (ms) => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    if (timer.unref) timer.unref();
  };
  async function tick() {
    try {
      await schedulerService.runSchedulerOnce();
    } catch (err) {
      logger.error('scheduler run crashed', { err });
    } finally {
      schedule(intervalSeconds * 1000);
    }
  }

  schedule(firstDelayMs); // รันเร็ว ๆ หลังสตาร์ท เก็บงานค้างจากตอน app ดับ
  logger.info('scheduler started', { intervalSeconds });
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

module.exports = { startScheduler };
