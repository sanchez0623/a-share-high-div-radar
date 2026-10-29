import { normalizeSymbol, type QuoteProvider, type RawQuote } from '../../shared/quote-types.ts';

/**
 * 新浪批量行情适配（https://hq.sinajs.cn）。
 *
 * 字段顺序经 2026-10-29 收盘实测核对（docs/live-data-integration.md §3.2-B）：
 * `var hq_str_sh601318="中国平安,52.250,52.310,53.200,53.200,51.420,...,100009242,5262308390.000,...,2026-10-29,15:07:24,00,..."``
 * 0=名称 1=今开 2=昨收 3=现价 4=最高 5=最低 8=成交量(股) 9=成交额(元) 30=日期 31=时间
 */

const REQUEST_TIMEOUT_MS = 8_000;
const ENDPOINT = 'https://hq.sinajs.cn/list=';
const REFERER = 'https://finance.sina.com.cn';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

/** 新浪返回 GBK；且必须带 Referer——实测缺失直接 403（见报告 §10 反爬项）。 */
async function fetchGbkText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`新浪行情 HTTP ${response.status}`);
  }
  return new TextDecoder('gbk').decode(await response.arrayBuffer());
}

function toNumber(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 新浪的日期/时间是两个独立字段；任一缺失时回落为抓取时间。 */
function dateTimeToIso(date: string, time: string, fetchedAt: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}:\d{2}$/.test(time)) {
    return fetchedAt;
  }
  return `${date}T${time}+08:00`;
}

function parseRow(market: string, code: string, payload: string, fetchedAt: string): RawQuote | null {
  const fields = payload.split(',');
  if (fields.length < 32) return null;
  const price = toNumber(fields[3]);
  const prevClose = toNumber(fields[2]);
  if (!(price > 0) || !(prevClose > 0)) return null; // 停牌/异常行：交由上层兜底
  return {
    symbol: `${code}.${market.toUpperCase()}`,
    name: fields[0] ?? code,
    price,
    prevClose,
    open: toNumber(fields[1]) || null,
    high: toNumber(fields[4]) || null,
    low: toNumber(fields[5]) || null,
    // 新浪成交量单位已是「股」，直接使用。
    volume: toNumber(fields[8]),
    amount: toNumber(fields[9]) || null,
    changePct: (price / prevClose - 1) * 100,
    quoteTime: dateTimeToIso(fields[30] ?? '', fields[31] ?? '', fetchedAt),
    fetchedAt,
    source: 'sina',
    quoteTimeReliable: true,
  };
}

export const sinaProvider: QuoteProvider = {
  id: 'sina',
  // 仅实测过 3 只/请求；50 为保守上限，扩批前需先压测。
  maxBatch: 50,
  quoteTimeReliable: true,
  async fetchQuotes(symbols, signal) {
    if (symbols.length === 0) return [];
    const normalized = symbols.map(normalizeSymbol);
    // normalizeSymbol 已保证 CODE.SUFFIX 格式：601318.SH → sh601318
    const query = normalized
      .map((symbol) => `${symbol.slice(-2).toLowerCase()}${symbol.slice(0, 6)}`)
      .join(',');
    const text = await fetchGbkText(ENDPOINT + query, signal);

    const fetchedAt = new Date().toISOString();
    const quotes: RawQuote[] = [];
    for (const match of text.matchAll(/hq_str_(sh|sz)(\d{6})="([^"]*)"/g)) {
      // 无效代码返回空字符串 payload，直接跳过。
      if (!match[3]) continue;
      const row = parseRow(match[1], match[2], match[3], fetchedAt);
      if (row) quotes.push(row);
    }
    if (quotes.length === 0) {
      throw new Error('新浪行情返回为空或格式变更');
    }
    return quotes;
  },
};
