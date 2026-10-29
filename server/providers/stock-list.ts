/**
 * 股票名册。
 *
 * 沪市：上交所官方接口（下方 fetchSseDirectory）——含上市日期/证监会行业/退市标记。
 * 深市：深交所官方接口（XLSX 与 JSON 变体）在本机网络均不可达（2026-10-29 实测 TLS 连接超时；
 * 东财 clist 端点同样被连接层屏蔽 UND_ERR_SOCKET），故深市改用新浪全市场分页列表
 * （fetchSinaDirectory，免费可达，沪深京全部 A 股，含名称/PE/PB/市值，无上市日期）。
 * 动态添加股票时的单只校验优先走腾讯行情（名称/现价/PE/PB），上市日期沪市查本名册、深市按需查理杏仁 company 接口。
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

/** 新浪 hs_a 条目字段（实测）：symbol=sz000333 形态，含 per(PE)/pb/mktcap(总市值万)/nmc(流通市值万)。 */
export interface SinaDirectoryEntry {
  symbol: string;
  name: string;
  pe: number | null;
  pb: number | null;
  /** 总市值（万元）。 */
  marketCapWan: number | null;
}

/**
 * 新浪全市场列表（沪深京全部 A 股，约 5400+ 只）：按页拉取直到空页。
 * 每页间隔 300ms 防限流；单次调用约 1-2 分钟，调用方必须缓存结果。
 * 注意：列表含北交所（bj 前缀），接入时需按本项目代码白名单过滤。
 */
export async function fetchSinaDirectory(options: { maxPages?: number; signal?: AbortSignal } = {}): Promise<Map<string, SinaDirectoryEntry>> {
  const result = new Map<string, SinaDirectoryEntry>();
  const maxPages = options.maxPages ?? 120;
  for (let page = 1; page <= maxPages; page += 1) {
    const url =
      `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData` +
      `?page=${page}&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page`;
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://finance.sina.com.cn/' },
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`新浪名册 HTTP ${response.status}（page=${page}）`);
    }
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const symbol = String(row.symbol ?? '');
      if (!/^(sh|sz|bj)\d{6}$/.test(symbol)) continue;
      const pe = Number(row.per);
      const pb = Number(row.pb);
      const mktcap = Number(row.mktcap);
      result.set(symbol, {
        symbol,
        name: String(row.name ?? symbol),
        pe: Number.isFinite(pe) && pe > 0 ? pe : null,
        pb: Number.isFinite(pb) && pb > 0 ? pb : null,
        marketCapWan: Number.isFinite(mktcap) && mktcap > 0 ? mktcap : null,
      });
    }
    // 300ms 页间隔：新浪该接口无公开限流文档，保守防封。
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (result.size === 0) {
    throw new Error('新浪名册返回为空或格式变更');
  }
  return result;
}
