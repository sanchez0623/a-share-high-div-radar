import type { SessionState } from '../shared/quote-types.ts';

const WEEKEND = new Set(['Sat', 'Sun']);

/**
 * 判定 A 股交易时段（Asia/Shanghai）。
 *
 * 局限：只处理周末，不处理法定节假日——节假日会被误判为 open，
 * 上游拿不到新数据时由陈旧度兜底提示，不影响正确性；P1 接入交易所日历后再补全。
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
  // 09:15 起算 open：包含 09:15–09:25 集合竞价，此时上游已能给出盘前快照。
  if (minutes < 9 * 60 + 15) return 'pre-open';
  if (minutes < 11 * 60 + 30) return 'open';
  if (minutes < 13 * 60) return 'lunch-break';
  if (minutes < 15 * 60) return 'open';
  return 'closed';
}
