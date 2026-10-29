import { normalizeSymbol } from '../../shared/quote-types.ts';

/**
 * 东财批量行业分类（push2 ulist，字段 f100 = 东财行业）。
 * 与实时行情同一端点，仅追加一个 field；每批 200 只。
 * （ashare-limit-lens eastmoney-industry-providers.js 已验证同源用法。）
 */

const REQUEST_TIMEOUT_MS = 10_000;
const ENDPOINT = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
const REFERER = 'https://quote.eastmoney.com/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

interface IndustryResponse {
  data?: { diff?: Array<Record<string, unknown>> } | null;
}

/** 批量拉取行业；返回 symbol → 行业名（f100 缺失/为空的标的不会出现在结果里）。 */
export async function fetchIndustries(symbols: string[], signal?: AbortSignal): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (symbols.length === 0) return result;

  for (let offset = 0; offset < symbols.length; offset += 200) {
    const batch = symbols.slice(offset, offset + 200);
    const secids = batch
      .map(normalizeSymbol)
      .map((symbol) => `${symbol.endsWith('.SH') ? 1 : 0}.${symbol.slice(0, 6)}`)
      .join(',');
    const url = `${ENDPOINT}?fltt=2&secids=${secids}&fields=f12,f100`;
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`东财行业 HTTP ${response.status}`);
    }
    const payload = (await response.json()) as IndustryResponse;
    for (const row of payload.data?.diff ?? []) {
      const code = String(row.f12 ?? '');
      const industry = String(row.f100 ?? '').trim();
      if (/^\d{6}$/.test(code) && industry && industry !== '-') {
        result.set(`${code}.${/^[69]/.test(code) ? 'SH' : 'SZ'}`, industry);
      }
    }
  }
  if (result.size === 0) {
    throw new Error('东财行业返回为空或格式变更');
  }
  return result;
}
