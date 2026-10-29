import { fetchTradingDays } from './providers/tencent-fqkline.ts';

/**
 * 交易日历（来源：腾讯 fqkline 上证指数实际成交日，免费无凭证）。
 *
 * 用法：resolveSessionState 在「日历已加载、今天是工作日、但日历里没有今天」
 * 且已过 09:35 时判定为节假日休市——09:35 前无法区分「节前最后一日」与
 * 「当日尚未产生日线」，保持原有周末判定（短暂窗口的误判由陈旧度提示兜底）。
 */

let knownDays: Set<string> | null = null;
let maxKnownDate = '';
let lastFetchAt = 0;

/** 返回当前日历；未加载返回 null（调用方回退周末判定）。 */
export function getKnownTradingDays(): { days: Set<string>; maxDate: string } | null {
  if (!knownDays) return null;
  return { days: knownDays, maxDate: maxKnownDate };
}

/** 拉取/刷新日历；失败由调用方决定降级（本模块不抛出）。节流：6 小时内不重复拉取。 */
export async function refreshTradingCalendar(signal?: AbortSignal): Promise<boolean> {
  if (knownDays && Date.now() - lastFetchAt < 6 * 3_600_000) return true;
  try {
    const days = await fetchTradingDays(60, signal);
    if (days.size === 0) return false;
    knownDays = days;
    maxKnownDate = [...days].reduce((max, date) => (date > max ? date : max), '');
    lastFetchAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

/** 供调度器高频调用：内部节流（同 refresh），跨日或超时才真正拉取。 */
export function ensureTradingCalendar(): void {
  void refreshTradingCalendar().catch(() => undefined);
}

/** 上海时区今日（YYYY-MM-DD）；供时段判定与调用方复用。 */
export function shanghaiDateString(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 节假日判定：今天是工作日、日历已加载、今天不在日历里且晚于日历最新交易日，
 * 并已过 09:35（给当日首根日线留出生成时间）。仅此窗口才可断定休市。 */
export function isLikelyHoliday(minutes: number, today: string): boolean {
  if (!knownDays || knownDays.has(today) || maxKnownDate >= today) return false;
  return minutes >= 9 * 60 + 35;
}
