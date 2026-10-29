import type { SessionState } from '../shared/quote-types.ts';
import { isLikelyHoliday, shanghaiDateString } from './trading-calendar.ts';

const WEEKEND = new Set(['Sat', 'Sun']);

/**
 * 判定 A 股交易时段（Asia/Shanghai）。
 *
 * 节假日：由腾讯 fqkline 指数成交日历判定（trading-calendar，09:35 后生效）；
 * 日历未加载或窗口内保持周末判定——此时拿不到新数据由陈旧度兜底提示。
 */
export function resolveSessionState(now: Date = new Date()): SessionState {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    hourCycle: 'h23',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';

  if (WEEKEND.has(value('weekday'))) return 'non-trading-day';

  const minutes = Number(value('hour')) * 60 + Number(value('minute'));
  if (!Number.isFinite(minutes)) return 'closed';
  // 节假日（日历推导，09:35 后可判定）。
  if (isLikelyHoliday(minutes, shanghaiDateString(now))) return 'non-trading-day';
  // 09:15 起算 open：包含 09:15–09:25 集合竞价，此时上游已能给出盘前快照。
  if (minutes < 9 * 60 + 15) return 'pre-open';
  if (minutes < 11 * 60 + 30) return 'open';
  if (minutes < 13 * 60) return 'lunch-break';
  if (minutes < 15 * 60) return 'open';
  return 'closed';
}
