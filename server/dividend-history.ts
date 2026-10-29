import type { DividendRecord } from '../shared/types.ts';
import { buildForecastHypothesis, roundTo } from '../shared/assumptions.ts';
import type { DividendEvent } from './providers/tencent-fqkline.ts';
import type { DemoState } from './state.ts';

/**
 * 真实分红历史接入（腾讯 fqkline 除权事件 → 分红年度记录）。
 *
 * 口径约定：
 * - 事件金额 fh_sh 是「每10股派息」（如 10派8.8元 ↔ fh_sh=8.8），聚合时必须除以10；
 * - 年度口径取 nd（分红年度）：年度 Y 的记录 = 该年度中期 + 末期等全部事件之和，
 *   末期通常在 Y+1 年除息，因此「当前日历年」的定义上不可能完结，一律排除；
 * - 除权数据不携带派息率，免费源也无法可靠推算，payoutRatio 如实置 null。
 */

/** 上海时区当前日历年（分红年度完结与否的判定基准）。 */
export function currentDividendYear(now = Date.now()): number {
  return Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(
      new Date(now),
    ),
  );
}

/** 事件对应的完整分红年度；非法年度、未来/当前年度与无效金额返回 null。 */
function completeDividendYear(event: DividendEvent, currentYear: number): number | null {
  const year = Number(event.year);
  if (!Number.isInteger(year) || year <= 1900 || year >= currentYear) return null;
  if (!Number.isFinite(event.perShare) || !(event.perShare > 0)) return null;
  return year;
}

/** 把真实分红事件聚合为完整分红年度记录（升序，取最近 maxYears 个年度）。 */
export function aggregateDividendRecords(
  events: DividendEvent[],
  currentYear: number,
  maxYears = 5,
): DividendRecord[] {
  const totals = new Map<number, number>();
  for (const event of events) {
    const year = completeDividendYear(event, currentYear);
    if (year === null) continue;
    totals.set(year, (totals.get(year) ?? 0) + event.perShare / 10);
  }
  if (totals.size === 0) return [];

  const years = [...totals.keys()].sort((a, b) => a - b);
  const full: DividendRecord[] = years.map((year, index) => {
    const dividend = roundTo(totals.get(year)!, 4);
    const previous = index === 0 ? null : roundTo(totals.get(years[index - 1]!)!, 4);
    const growth = previous === null || previous === 0 ? 0 : roundTo((dividend / previous - 1) * 100, 2);
    return { year, dividend, payoutRatio: null, growth };
  });
  return full.slice(-maxYears);
}

/** 连续分红年数：从最近一个有分红的完整年度起连续回数（受事件窗口限制，非公司全部历史）。 */
export function computeDividendStreak(events: DividendEvent[], currentYear: number): number {
  const years = [
    ...new Set(
      events
        .map((event) => completeDividendYear(event, currentYear))
        .filter((year): year is number => year !== null),
    ),
  ].sort((a, b) => b - a);
  if (years.length === 0) return 0;
  let streak = 1;
  while (years[streak - 1]! - years[streak]! === 1) streak += 1;
  return streak;
}

/**
 * 把真实分红历史写进 state：替换 dividends、重算连续年数并标注口径来源。
 * 返回是否生效（事件不含任何已完结年度时保持原口径不动）。
 * 不触碰 receivedDividend/pendingDividend 与质量评分：涉及权益股本与税务口径，另行单独接入。
 */
export function applyDividendHistory(
  state: DemoState,
  symbol: string,
  events: DividendEvent[],
  syncedAt: string,
  now = Date.now(),
): boolean {
  const currentYear = currentDividendYear(now);
  const records = aggregateDividendRecords(events, currentYear);
  if (records.length === 0) return false;

  state.dividends.set(symbol, records);
  const stock = state.stocks.get(symbol);
  if (!stock) return true;
  stock.dividendStreak = computeDividendStreak(events, currentYear);
  stock.dividendHistorySource = 'tencent-fqkline';
  stock.dividendHistorySyncedAt = syncedAt;
  stock.dividendForecast.hypothesis = buildForecastHypothesis(
    stock.baseDividend,
    records,
    stock.dividendForecast.year,
    stock.dividendForecast.scenario,
  );
  return true;
}
