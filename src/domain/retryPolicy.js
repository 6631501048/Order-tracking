/**
 * นโยบาย retry (เคส 1 / 4) — ฟังก์ชันล้วน ไม่แตะ DB
 *
 * retryCount = จำนวนครั้งที่ "ลองใหม่ไปแล้ว" (ครั้งแรกที่ทำไม่นับ)
 * maxRetries = 3 => ทำได้ทั้งหมด 4 รอบ (1 ปกติ + retry 3) รอบที่ 4 พลาดอีก => GIVE_UP -> DELAYED
 * หน่วงก่อนลองใหม่ครั้งที่ n = min(base * 2^(n-1), maxDelay)  เช่น base=30 => 30, 60, 120 วินาที
 */
function backoffDelaySeconds(retryNumber, { baseSeconds, maxDelaySeconds }) {
  if (!Number.isInteger(retryNumber) || retryNumber < 1) {
    throw new RangeError(`retryNumber ต้องเป็นจำนวนเต็ม >= 1 (ได้ ${retryNumber})`);
  }
  // 2 ** (n-1) กับ n ใหญ่มากได้ Infinity; min ด้วย maxDelay จึงปลอดภัย
  return Math.min(baseSeconds * 2 ** (retryNumber - 1), maxDelaySeconds);
}

function decideRetry(retryCount, { maxRetries, baseSeconds, maxDelaySeconds }) {
  if (!Number.isInteger(retryCount) || retryCount < 0) {
    throw new RangeError(`retryCount ต้องเป็นจำนวนเต็ม >= 0 (ได้ ${retryCount})`);
  }
  if (retryCount >= maxRetries) return { action: 'GIVE_UP', retryCount };
  const next = retryCount + 1;
  return {
    action: 'RETRY',
    retryCount: next,
    delaySeconds: backoffDelaySeconds(next, { baseSeconds, maxDelaySeconds }),
  };
}

module.exports = { backoffDelaySeconds, decideRetry };
