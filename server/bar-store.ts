import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawQuote } from '../shared/quote-types.ts';
import type { PriceBar } from '../shared/types.ts';

/**
 * 日线持久化（server/.data/bars/{SYMBOL}.json）。
 *
 * 设计约束（见 docs/live-data-integration.md §7）：
 * - 盘中快照不落库；只有日线（技术指标与前复权的唯一基础）持久化。
 * - 原子写与 assumption-store 同一模式：临时文件 + rename。
 * - 「实时价进入派生链」走 applyQuoteToHistory：覆盖当日 bar（数据源 kline 已含今日），
 *   前复权以最新价为锚，覆盖当日不会破坏历史序列；除息整段重算由 kline 源完成。
 */

interface BarsFile {
  version: number;
  symbol: string;
  bars: PriceBar[];
}

/** 读取全部已落盘日线；文件缺失或损坏的标的直接跳过（由调用方回退演示数据）。 */
export function loadAllBars(symbols: string[]): Map<string, PriceBar[]> {
  const result = new Map<string, PriceBar[]>();
  for (const symbol of symbols) {
    try {
      const filePath = barsPath(symbol);
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as BarsFile;
      if (parsed.symbol === symbol && Array.isArray(parsed.bars) && parsed.bars.length > 0) {
        result.set(symbol, parsed.bars);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`读取日线文件失败（${symbol}），将重新拉取：${(error as Error).message}`);
      }
    }
  }
  return result;
}

export function saveBars(symbol: string, bars: PriceBar[]): void {
  const filePath = barsPath(symbol);
  mkdirSync(dirname(filePath), { recursive: true });
  const payload: BarsFile = { version: 1, symbol, bars };
  // 唯一临时名（pid + 时间戳）：避免 tsx 重启并发窗口下 rename 竞态 ENOENT。
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(temporaryPath, filePath);
}

function barsPath(symbol: string): string {
  // 与其他 store 一致：基于模块位置定位 server/.data/bars/，不依赖进程 cwd。
  return fileURLToPath(new URL(`./.data/bars/${symbol}.json`, import.meta.url));
}

/** quote 的快照时间按上海时区取交易日（YYYY-MM-DD）。 */
export function quoteTradingDate(quote: RawQuote): string {
  const date = new Date(quote.quoteTime);
  if (Number.isNaN(date.getTime())) return '';
  // 数据源快照时间固定为 +08:00 或 UTC；统一转上海时区取日期。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * 把实时快照应用到日线序列（纯函数）：
 * - 当日 bar 已存在（kline 盘中即含今日）→ 覆盖 close，high/low 取区间并集，volume 以快照为准；
 * - 当日 bar 缺失（如收盘后 quote 晚于最近一次 kline）→ 追加；此时要求序列连续由调用方保证；
 * - quote 日期早于最后一根（停牌日残留快照等）→ 原样返回，不回写旧数据。
 * 返回同一引用表示无需更新。
 */
export function applyQuoteToHistory(bars: PriceBar[], quote: RawQuote): PriceBar[] {
  const date = quoteTradingDate(quote);
  if (!date || !(quote.price > 0) || bars.length === 0) return bars;

  const last = bars[bars.length - 1];
  if (last.date > date) return bars; // 快照早于已有日线：忽略
  if (last.date === date) {
    if (last.close === quote.price && last.high >= (quote.high ?? 0) && last.volume === quote.volume) {
      return bars; // 已是同一数据，避免无意义复制
    }
    const updated: PriceBar = {
      ...last,
      close: quote.price,
      high: Math.max(last.high, quote.high ?? quote.price),
      low: Math.min(last.low, quote.low ?? quote.price),
      volume: quote.volume > 0 ? quote.volume : last.volume,
    };
    return [...bars.slice(0, -1), updated];
  }
  // 追加新交易日：前一根必须就是上一交易日（连续性由 kline 同步保证）。
  return [
    ...bars,
    {
      date,
      open: quote.open ?? quote.price,
      close: quote.price,
      high: quote.high ?? quote.price,
      low: quote.low ?? quote.price,
      volume: quote.volume,
    },
  ];
}
