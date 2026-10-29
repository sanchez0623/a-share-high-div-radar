import { normalizeSymbol } from '../../shared/quote-types.ts';
import type { PriceBar } from '../../shared/types.ts';

/**
 * 东方财富 push2his 日线适配（https://push2his.eastmoney.com/api/qt/stock/kline/get）。
 *
 * 实测（2026-10-29，601318，fqt=1 前复权 / klt=101 日线）：
 * `data.klines = ["2026-10-29,52.25,53.20,53.20,51.42,1000092,5262308390.00,1.70", ...]`
 * 每条 CSV：日期,开盘,收盘,最高,最低,成交量(手),成交额(元),涨跌幅(%)
 * 关键特性：最后一根即为当日（盘中为实时值，收盘后为最终值），因此
 * 「补历史」与「固化当日」使用同一个接口；前复权由数据源完成，除息缺口无需自算。
 */

const REQUEST_TIMEOUT_MS = 15_000;
const ENDPOINT = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const REFERER = 'https://quote.eastmoney.com/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
/** f51 日期 f52 开 f53 收 f54 高 f55 低 f56 量(手) f57 额 f59 涨跌幅 */
const FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57,f59';

export interface DailyBarOptions {
  /** 拉取根数；项目指标（布林/ATR/MA20）与 30 根 sparkline 在 140 根内绰绰有余。 */
  limit?: number;
  signal?: AbortSignal;
}

interface KlineResponse {
  data?: {
    code?: string;
    market?: number;
    name?: string;
    klines?: string[];
  } | null;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<KlineResponse> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`东财日线 HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as KlineResponse;
  } catch {
    throw new Error('东财日线返回非 JSON，可能被限流');
  }
}

function parseKline(row: string): PriceBar | null {
  // date, open, close, high, low, volume(手), amount, changePct
  const parts = row.split(',');
  if (parts.length < 7) return null;
  const close = Number(parts[2]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parts[0]) || !Number.isFinite(close) || close <= 0) return null;
  return {
    date: parts[0],
    open: Number(parts[1]),
    close,
    high: Number(parts[3]),
    low: Number(parts[4]),
    volume: Number(parts[5]) * 100, // 手 → 股
  };
}

/** 拉取单只的前复权日线（按日期升序，最后一根为最新交易日）。 */
export async function fetchDailyBars(symbol: string, options: DailyBarOptions = {}): Promise<PriceBar[]> {
  const normalized = normalizeSymbol(symbol);
  const secid = `${normalized.endsWith('.SH') ? 1 : 0}.${normalized.slice(0, 6)}`;
  const url =
    `${ENDPOINT}?secid=${secid}&klt=101&fqt=1&beg=0&end=20500101` +
    `&lmt=${options.limit ?? 140}&fields1=f1,f2,f3,f4,f5,f6&fields2=${FIELDS2}`;
  const payload = await fetchJson(url, options.signal);
  const bars = (payload.data?.klines ?? [])
    .map(parseKline)
    .filter((bar): bar is PriceBar => bar !== null);
  if (bars.length === 0) {
    throw new Error(`东财日线返回为空：${normalized}`);
  }
  return bars;
}

/** 批量拉取多只日线；单只失败不拖垮整批，由调用方根据返回的 errors 决定降级。 */
export async function fetchDailyBarsBatch(
  symbols: string[],
  options: DailyBarOptions = {},
): Promise<{ bars: Map<string, PriceBar[]>; errors: string[] }> {
  const bars = new Map<string, PriceBar[]>();
  const errors: string[] = [];
  // 逐只串行：观察仓规模小（≤50），且日线接口无批量参数；限速靠调用方令牌桶。
  for (const symbol of symbols) {
    try {
      bars.set(symbol, await fetchDailyBars(symbol, options));
    } catch (reason) {
      errors.push(`${symbol}: ${(reason as Error).message}`);
    }
  }
  return { bars, errors };
}
