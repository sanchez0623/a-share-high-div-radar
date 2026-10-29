import type { DataMode } from './types.ts';

/** 行情来源。demo 为内置演示数据；其余来源的对比与实测见 docs/live-data-integration.md。 */
export type QuoteSource = 'tencent' | 'sina' | 'eastmoney' | 'ifind' | 'tushare' | 'demo';

/** A 股交易时段（Asia/Shanghai），由服务端判定后透传，前端不自行推断。 */
export type SessionState = 'pre-open' | 'open' | 'lunch-break' | 'closed' | 'non-trading-day';

/**
 * 单只标的的行情快照（provider 原始输出，未含时段与陈旧度装饰）。
 * 口径约定：volume 统一「股」、amount 统一「元」、changePct 用未舍入值（展示层再舍入）。
 */
export interface RawQuote {
  /** 统一格式：601318.SH / 000333.SZ */
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number;
  amount: number | null;
  changePct: number;
  /**
   * 数据源给出的快照时间（ISO 8601，+08:00）。
   * 实测为「快照生成时间」而非最后成交时间（收盘后仍在前进），仅用于溯源展示；
   * 陈旧判定必须用 staleSeconds，见 docs/live-data-integration.md §3.3 / §5.5。
   */
  quoteTime: string;
  /** 服务端抓取时间（ISO 8601，UTC）。 */
  fetchedAt: string;
  source: QuoteSource;
  /** 该源是否返回行情时间；false 表示 quoteTime 回落为 fetchedAt（如东财批量接口）。 */
  quoteTimeReliable: boolean;
}

/** 供前端展示的行情快照：RawQuote + 服务端补充的时段与陈旧度。 */
export interface Quote extends RawQuote {
  sessionState: SessionState;
  /** 仅盘中判定；收盘/午休由 sessionState 表达，不判 stale。 */
  stale: boolean;
  /** 距最近一次成功抓取的秒数。 */
  staleSeconds: number;
}

/** 主源失败降级记录；QuoteSnapshotResponse.degraded 非空时前端必须展示。 */
export interface QuoteDegraded {
  from: QuoteSource;
  to: QuoteSource;
  reason: string;
}

export interface QuoteSnapshotResponse {
  dataMode: DataMode;
  sessionState: SessionState;
  quotes: Quote[];
  degraded: QuoteDegraded | null;
}

export interface QuoteProvider {
  readonly id: QuoteSource;
  /** 单次请求可承载的标的数上限，服务端据此切批。 */
  readonly maxBatch: number;
  readonly quoteTimeReliable: boolean;
  fetchQuotes(symbols: string[], signal?: AbortSignal): Promise<RawQuote[]>;
}

/**
 * 归一化证券代码为「601318.SH / 000333.SZ」格式。
 * 接受 601318.SH、sh601318、601318 三种写法。
 * 白名单仅覆盖沪深 A 股与 B 股：60 主板 / 68 科创板 / 90 沪 B；00 主板 / 30 创业板 / 20 深 B。
 * 北交所（43/83/87/920）、基金/ETF（5/15/16 开头）等一律拒绝，避免静默误判市场。
 */
export function normalizeSymbol(input: string): string {
  const cleaned = input
    .trim()
    .toUpperCase()
    .replace(/\.(SH|SZ|SS|BJ)$/, '')
    .replace(/^(SH|SZ|SS)/, '');
  if (!/^\d{6}$/.test(cleaned)) {
    throw new Error(`无法识别的证券代码：${input}`);
  }
  if (!/^(60|68|90|00|30|20)/.test(cleaned)) {
    throw new Error(`暂不支持的证券代码段：${input}（仅支持沪深 A 股/B 股）`);
  }
  const suffix = /^[69]/.test(cleaned) ? 'SH' : 'SZ';
  return `${cleaned}.${suffix}`;
}
