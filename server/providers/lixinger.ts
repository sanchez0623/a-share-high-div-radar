import { normalizeSymbol } from '../../shared/quote-types.ts';

/**
 * 理杏仁开放平台适配（https://open.lixinger.com/api/cn，POST + JSON，token 鉴权）。
 *
 * 定位：**备用数据源**——免费额度有限，不接主链路；供低频校准与人工查询。
 * 已实测字段（2026-10-29，token 由环境变量 LIXINGER_TOKEN 提供）：
 * - POST /company/fundamental/non_financial {token, stockCodes:["601318"], metricsList, date}
 *   → [{"date","dyr":0.0513,"pb":0.9224,"pe_ttm":9.7733,"stockCode":"601318"}]
 *   （pe_ttm 与腾讯 f39 一致；dyr 为近12月股息率小数）
 * - POST /company/dividend {token, stockCode:"601318", metricsList:["dividendYield","exRightDate"]}
 *   （实测返回空数组，疑似需要日期范围参数，接入时再验证）
 * 限流：官方 1000 次/分、36 次/秒；本模块保守串行 + 1.1s 最小间隔。
 */

const BASE = 'https://open.lixinger.com/api/cn';
const REQUEST_TIMEOUT_MS = 15_000;
/** 串行闸门 + 最小间隔（免费额度保护）。 */
let chain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

export interface LixingerFundamental {
  date: string;
  peTtm: number | null;
  pb: number | null;
  /** 近 12 个月股息率（小数，如 0.0513 = 5.13%）。 */
  dividendYield: number | null;
}

interface LixingerResponse<T> {
  code?: number;
  msg?: string;
  data?: T | null;
}

function token(): string {
  const value = process.env.LIXINGER_TOKEN?.trim();
  if (!value) {
    throw new Error('未配置 LIXINGER_TOKEN（.env），理杏仁备用源不可用');
  }
  return value;
}

async function post<T>(path: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  // 串行 + 最小间隔：把上一个请求的完成时间对齐到至少 1.1s 之后。
  const previous = chain;
  let release: () => void;
  chain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const wait = Math.max(0, lastRequestAt + 1_100 - Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  try {
    const response = await fetch(`${BASE}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`理杏仁 HTTP ${response.status}`);
    }
    const result = (await response.json()) as LixingerResponse<T>;
    if (result.code !== 1) {
      throw new Error(`理杏仁返回异常：code=${result.code} ${result.msg ?? ''}`);
    }
    return result.data as T;
  } finally {
    lastRequestAt = Date.now();
    release!();
  }
}

function pureCode(symbol: string): string {
  return normalizeSymbol(symbol).slice(0, 6);
}

/** 最新估值快照（PE TTM / PB / 近12月股息率）；无数据返回 null。 */
export async function fetchFundamental(symbol: string, signal?: AbortSignal): Promise<LixingerFundamental | null> {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const rows = await post<Array<{ date?: string; pe_ttm?: number; pb?: number; dyr?: number }>>(
    'company/fundamental/non_financial',
    { token: token(), stockCodes: [pureCode(symbol)], metricsList: ['pe_ttm', 'pb', 'dyr'], date },
    signal,
  );
  const row = rows?.at(-1);
  if (!row) return null;
  return {
    date: (row.date ?? date).slice(0, 10),
    peTtm: typeof row.pe_ttm === 'number' ? row.pe_ttm : null,
    pb: typeof row.pb === 'number' ? row.pb : null,
    dividendYield: typeof row.dyr === 'number' ? row.dyr : null,
  };
}

/** 分红/除权日历史（备用；实测需带日期范围参数，接入前先验证）。 */
export async function fetchDividendYieldHistory(
  symbol: string,
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
): Promise<Array<{ date: string; dividendYield: number | null; exRightDate: string | null }>> {
  const rows = await post<Array<Record<string, unknown>>>(
    'company/dividend',
    {
      token: token(),
      stockCode: pureCode(symbol),
      startDate,
      endDate,
      metricsList: ['dividendYield', 'exRightDate'],
    },
    signal,
  );
  return (rows ?? []).map((row) => ({
    date: String(row.date ?? '').slice(0, 10),
    dividendYield: typeof row.dividendYield === 'number' ? row.dividendYield : null,
    exRightDate: row.exRightDate ? String(row.exRightDate) : null,
  }));
}
