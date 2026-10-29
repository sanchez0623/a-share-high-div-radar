import { normalizeSymbol, type QuoteProvider, type RawQuote } from '../../shared/quote-types.ts';

/**
 * 腾讯批量行情适配（https://qt.gtimg.cn）。
 *
 * 字段索引经 2026-10-29 收盘实测核对（docs/live-data-integration.md §3.2-A）：
 * `v_sh601318="1~中国平安~601318~53.20~52.31~52.25~1000092~...~20261029150722~0.89~1.70~53.20~51.42~53.20/1000092/5262308390~1000092~526231~..."`
 * 1=名称 3=现价 4=昨收 5=今开 30=快照时间(YYYYMMDDHHmmss) 32=涨跌幅(已舍入)
 * 33=最高 34=最低 36=成交量(手) 37=成交额(万元)
 */

const REQUEST_TIMEOUT_MS = 8_000;
const ENDPOINT = 'https://qt.gtimg.cn/q=';
const REFERER = 'https://gu.qq.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

/** 腾讯返回 GBK，需按字节解码，否则中文简称乱码（实测踩坑）。 */
async function fetchGbkText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`腾讯行情 HTTP ${response.status}`);
  }
  return new TextDecoder('gbk').decode(await response.arrayBuffer());
}

/** 「20261029150722」→「2026-10-29T15:07:22+08:00」；格式异常时回落为当前时间。 */
function compactTimeToIso(value: string): string {
  if (!/^\d{14}$/.test(value)) return new Date().toISOString();
  return (
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` +
    `T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}+08:00`
  );
}

function toNumber(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseRow(market: string, code: string, payload: string, fetchedAt: string): RawQuote | null {
  const fields = payload.split('~');
  // 完整行约 60 个字段；过短说明格式变更或返回异常。
  if (fields.length < 40) return null;
  const price = toNumber(fields[3]);
  const prevClose = toNumber(fields[4]);
  if (!(price > 0) || !(prevClose > 0)) return null; // 停牌/异常行：交由上层用缓存与其他源兜底
  return {
    symbol: `${code}.${market.toUpperCase()}`,
    name: fields[1] ?? code,
    price,
    prevClose,
    open: toNumber(fields[5]) || null,
    high: toNumber(fields[33]) || null,
    low: toNumber(fields[34]) || null,
    // 腾讯原始单位为「手」，统一乘 100 折算为「股」；与新浪的股级精度差来自手取整。
    volume: toNumber(fields[36]) * 100,
    amount: toNumber(fields[37]) * 10_000,
    // 统一用未舍入值计算涨跌幅，与新浪自算口径一致（展示层再舍入）。
    changePct: (price / prevClose - 1) * 100,
    quoteTime: compactTimeToIso(fields[30] ?? ''),
    fetchedAt,
    source: 'tencent',
    quoteTimeReliable: true,
  };
}

export const tencentProvider: QuoteProvider = {
  id: 'tencent',
  // 仅实测过 3 只/请求；50 为保守上限，扩批前需先压测（见报告 §5.4）。
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
    for (const match of text.matchAll(/v_(sh|sz)(\d{6})="([^"]*)"/g)) {
      const row = parseRow(match[1], match[2], match[3], fetchedAt);
      if (row) quotes.push(row);
    }
    if (quotes.length === 0) {
      throw new Error('腾讯行情返回为空或格式变更');
    }
    return quotes;
  },
};
