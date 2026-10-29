/**
 * 股票名册（上交所官方接口，免费）。
 *
 * 实测（2026-10-29）：`result` 共 2520 条，字段 A_STOCK_CODE / SEC_NAME_CN /
 * COMPANY_ABBR / LIST_DATE(YYYYMMDD) / CSRC_CODE_DESC(证监会行业) / DELIST_DATE。
 * 需要带 Referer: https://www.sse.com.cn/，否则 403。
 *
 * 深市名册为 XLSX（需引入 SheetJS），当前用「腾讯行情名称 + 本名册」组合已可
 * 覆盖动态添加股票的名称/存在性校验；深市上市日期留待接入 SheetJS 或新浪分页备源。
 */

const REQUEST_TIMEOUT_MS = 20_000;
const ENDPOINT = 'https://query.sse.com.cn/sseQuery/commonQuery.do';
const REFERER = 'https://www.sse.com.cn/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

export interface StockDirectoryEntry {
  code: string;
  name: string;
  /** 上市日期（YYYY-MM-DD）；未知为 null。 */
  listDate: string | null;
  /** 证监会行业（如「金融业」）；缺失为 null。 */
  csrcIndustry: string | null;
  /** 已退市（DELIST_DATE 非占位符）。 */
  delisted: boolean;
}

interface SseDirectoryResponse {
  result?: Array<Record<string, string>> | null;
}

/** 拉取上交所 A 股名册（全量约 2500 只，响应 ~1.2MB，调用方应自行缓存）。 */
export async function fetchSseDirectory(signal?: AbortSignal): Promise<Map<string, StockDirectoryEntry>> {
  const url =
    `${ENDPOINT}?sqlId=COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L&pageHelp.pageSize=10000&pageHelp.pageNo=1`;
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`上交所名册 HTTP ${response.status}`);
  }
  const payload = (await response.json()) as SseDirectoryResponse;
  const result = new Map<string, StockDirectoryEntry>();
  for (const row of payload.result ?? []) {
    const code = String(row.A_STOCK_CODE ?? '').trim();
    if (!/^\d{6}$/.test(code)) continue;
    const listDate = /^\d{8}$/.test(String(row.LIST_DATE ?? ''))
      ? `${row.LIST_DATE.slice(0, 4)}-${row.LIST_DATE.slice(4, 6)}-${row.LIST_DATE.slice(6, 8)}`
      : null;
    const delistRaw = String(row.DELIST_DATE ?? '-').trim();
    result.set(code, {
      code,
      name: String(row.COMPANY_ABBR || row.SEC_NAME_CN || code),
      listDate,
      csrcIndustry: row.CSRC_CODE_DESC && row.CSRC_CODE_DESC !== '-' ? row.CSRC_CODE_DESC : null,
      delisted: /^\d{8}$/.test(delistRaw),
    });
  }
  if (result.size === 0) {
    throw new Error('上交所名册返回为空或格式变更');
  }
  return result;
}
