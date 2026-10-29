import { normalizeSymbol, type QuoteProvider, type RawQuote } from '../../shared/quote-types.ts';

/**
 * 东方财富 push2 批量行情适配（https://push2.eastmoney.com/api/qt/ulist.np/get）。
 *
 * 实测响应（docs/live-data-integration.md §3.2-C）：
 * `{"rc":0,"data":{"total":3,"diff":[{"f2":53.2,"f3":1.7,"f5":1000092,"f12":"601318",...}]}}`
 * f2=现价(元) f3=涨跌幅(已舍入) f5=成交量(手) f6=成交额(元)
 * f12=代码 f14=名称 f15=最高 f16=最低 f17=今开 f18=昨收
 * fltt=2 表示数值已按小数返回（否则 f2 为分为单位的整数）。
 *
 * 注意：该接口不返回行情时间，quoteTime 只能回落为抓取时间，
 * 因此 quoteTimeReliable=false，陈旧判定完全依赖服务端抓取时间。
 */

const REQUEST_TIMEOUT_MS = 8_000;
const ENDPOINT = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
const REFERER = 'https://quote.eastmoney.com/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
/** f2 现价 f5 成交量(手) f6 成交额 f12 代码 f14 名称 f15 最高 f16 最低 f17 今开 f18 昨收 */
const FIELDS = 'f2,f5,f6,f12,f14,f15,f16,f17,f18';

interface EastmoneyRow {
  f2?: number | string;
  f5?: number | string;
  f6?: number | string;
  f12?: number | string;
  f14?: number | string;
  f15?: number | string;
  f16?: number | string;
  f17?: number | string;
  f18?: number | string;
}

interface EastmoneyResponse {
  data?: { diff?: EastmoneyRow[] | Record<string, EastmoneyRow> } | null;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<EastmoneyResponse> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`东财行情 HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as EastmoneyResponse;
  } catch {
    throw new Error('东财行情返回非 JSON，可能被限流');
  }
}

/** 东财对停牌/无效字段会返回「-」字符串，统一折算为 0 再走 optional 处理。 */
function toNumber(value: number | string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseRow(row: EastmoneyRow, fetchedAt: string): RawQuote | null {
  const code = String(row.f12 ?? '');
  if (!/^\d{6}$/.test(code)) return null;
  const price = toNumber(row.f2);
  const prevClose = toNumber(row.f18);
  if (!(price > 0) || !(prevClose > 0)) return null; // 停牌/异常行：交由上层兜底
  return {
    symbol: `${code}.${/^[69]/.test(code) ? 'SH' : 'SZ'}`,
    name: String(row.f14 ?? code),
    price,
    prevClose,
    open: toNumber(row.f17) || null,
    high: toNumber(row.f15) || null,
    low: toNumber(row.f16) || null,
    // 东财原始单位为「手」，统一乘 100 折算为「股」。
    volume: toNumber(row.f5) * 100,
    amount: toNumber(row.f6) || null,
    changePct: (price / prevClose - 1) * 100,
    quoteTime: fetchedAt,
    fetchedAt,
    source: 'eastmoney',
    quoteTimeReliable: false,
  };
}

export const eastmoneyProvider: QuoteProvider = {
  id: 'eastmoney',
  // 仅实测过 3 只/请求；50 为保守上限，扩批前需先压测。
  maxBatch: 50,
  quoteTimeReliable: false,
  async fetchQuotes(symbols, signal) {
    if (symbols.length === 0) return [];
    // normalizeSymbol 已保证 CODE.SUFFIX 格式：601318.SH → 1.601318（1=沪 0=深）
    const secids = symbols
      .map(normalizeSymbol)
      .map((symbol) => `${symbol.endsWith('.SH') ? 1 : 0}.${symbol.slice(0, 6)}`)
      .join(',');
    const url = `${ENDPOINT}?fltt=2&secids=${secids}&fields=${FIELDS}`;
    const payload = await fetchJson(url, signal);

    const fetchedAt = new Date().toISOString();
    const diff = payload.data?.diff;
    // 部分端点在单只/特殊场景会把 diff 返回成对象，做一次兼容。
    const rows = Array.isArray(diff) ? diff : Object.values(diff ?? {});
    const quotes = rows
      .map((row) => parseRow(row, fetchedAt))
      .filter((row): row is RawQuote => row !== null);
    if (quotes.length === 0) {
      throw new Error('东财行情返回为空或格式变更');
    }
    return quotes;
  },
};
