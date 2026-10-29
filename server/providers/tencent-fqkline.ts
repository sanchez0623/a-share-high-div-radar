import { normalizeSymbol } from '../../shared/quote-types.ts';
import type { PriceBar } from '../../shared/types.ts';

/**
 * 腾讯 fqkline 适配（https://web.ifzq.gtimg.cn/appstock/app/fqkline/get）。
 *
 * 实测（2026-10-29，sh601318，qfq）：
 * - `data.{symbol}.qfqday`（指数等无复权品种为 `day`）：每条 `[日期, 开, 收, 高, 低, 量, (除权信息?)]`
 * - 除权日 bar 的第 7 位是分红 dict：
 *   `{"nd":"2024","fh_sh":"16.2","djr":"2025-06-27","cqr":"2025-06-30","FHcontent":"10派16.2元"}`
 *   （nd=分红年度、fh_sh=每10股派息（10派16.2元 ↔ fh_sh=16.2，每股须再除以10）、
 *   djr=股权登记日、cqr=除权除息日、FHcontent=方案文案）
 * - 因此「交易日历」与「分红史/除息日」共用本接口，均免费无凭证。
 */

const ENDPOINT = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const REFERER = 'https://gu.qq.com/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
/** 单次拉取根数上限（未验证更大值，保守取 320；5 年约 1220 根 = 4 段）。 */
const PAGE_SIZE = 320;

interface FqklineResponse {
  code?: number;
  data?: Record<string, { day?: unknown[][]; qfqday?: unknown[][] }> | null;
}

export interface DividendEvent {
  /** 分红年度（dict.nd，如 "2024"）。 */
  year: string;
  /** 每10股派息（dict.fh_sh，元；如 10派16.2元 → 16.2，每股=16.2/10）。 */
  perShare: number;
  /** 股权登记日（dict.djr）。 */
  recordDate: string;
  /** 除权除息日（dict.cqr）。 */
  exDate: string;
  /** 分红方案文案（dict.FHcontent，如 "10派16.2元"）。 */
  content: string;
}

interface FqklineRow {
  date: string;
  /** 开/收/高/低（元，前复权）与成交量（手）。 */
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  dividend: DividendEvent | null;
}

async function fetchFqkline(symbol: string, start: string, end: string, rows: number, signal?: AbortSignal): Promise<FqklineRow[]> {
  const normalized = normalizeSymbol(symbol);
  const query = `${normalized.slice(-2).toLowerCase()}${normalized.slice(0, 6)}`;
  const url = `${ENDPOINT}?param=${query},day,${start},${end},${rows},qfq`;
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`腾讯 fqkline HTTP ${response.status}`);
  }
  const payload = (await response.json()) as FqklineResponse;
  const node = payload.data?.[query];
  const rows_ = node?.qfqday ?? node?.day ?? [];
  return rows_.map(parseRow).filter((row): row is FqklineRow => row !== null);
}

function parseRow(row: unknown[]): FqklineRow | null {
  const date = String(row[0] ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const open = Number(row[1]);
  const close = Number(row[2]);
  const high = Number(row[3]);
  const low = Number(row[4]);
  const volume = Number(row[5]);
  // 除权日 bar 末位是分红 dict（实测）；字符串形态视为无分红。
  const extra = row.length >= 7 && typeof row[6] === 'object' && row[6] !== null ? (row[6] as Record<string, unknown>) : null;
  const perShare = Number(extra?.fh_sh);
  const exDate = String(extra?.cqr ?? '');
  const dividend =
    extra && exDate && Number.isFinite(perShare) && perShare > 0
      ? {
          year: String(extra.nd ?? ''),
          perShare,
          recordDate: String(extra.djr ?? ''),
          exDate,
          content: String(extra.FHcontent ?? ''),
        }
      : null;
  return {
    date,
    open: Number.isFinite(open) ? open : 0,
    close: Number.isFinite(close) ? close : 0,
    high: Number.isFinite(high) ? high : 0,
    low: Number.isFinite(low) ? low : 0,
    volume: Number.isFinite(volume) ? volume : 0,
    dividend,
  };
}

/**
 * 拉取个股前复权日线（同一免费接口）：东财 push2his 不可用（限流/网络阻断）时的降级源。
 * 与东财日线同为前复权口径；成交量腾讯原始单位为「手」，统一乘 100 折算为「股」。
 */
export async function fetchTencentDailyBars(symbol: string, limit = 140, signal?: AbortSignal): Promise<PriceBar[]> {
  const end = formatDate(new Date());
  const start = formatDate(new Date(Date.now() - 400 * 86_400_000));
  const rows = await fetchFqkline(symbol, start, end, limit, signal);
  return rows
    .filter((row) => row.close > 0)
    .map((row) => ({
      date: row.date,
      open: row.open,
      close: row.close,
      high: row.high,
      low: row.low,
      volume: row.volume * 100, // 手 → 股
    }));
}

/** 拉取指数（默认上证）最近 N 个自然日内的实际成交日集合 → 交易日历。 */
export async function fetchTradingDays(days = 60, signal?: AbortSignal): Promise<Set<string>> {
  const end = new Date();
  const start = new Date(Date.now() - days * 86_400_000);
  const rows = await fetchFqkline('000001.SH', formatDate(start), formatDate(end), days + 10, signal);
  return new Set(rows.map((row) => row.date));
}

/**
 * 拉取个股近 N 年的分红事件（除权日 bar 携带），按除权日去重、升序返回。
 * 免费路线：来源是行情接口捎带的元数据，不消耗任何付费额度。
 */
export async function fetchDividendEvents(symbol: string, years = 5, signal?: AbortSignal): Promise<DividendEvent[]> {
  const now = Date.now();
  const start = formatDate(new Date(now - years * 366 * 86_400_000));
  let cursorEnd = formatDate(new Date(now));
  const events = new Map<string, DividendEvent>();

  // 从最新往回分段拉取，直到覆盖 start 或遇到空段。
  for (let page = 0; page < Math.ceil((years * 366) / PAGE_SIZE) + 1; page += 1) {
    const rows = await fetchFqkline(symbol, start, cursorEnd, PAGE_SIZE, signal);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.dividend && !events.has(row.dividend.exDate)) {
        events.set(row.dividend.exDate, row.dividend);
      }
    }
    const earliest = rows[0].date;
    if (earliest <= start) break;
    cursorEnd = shiftDay(earliest, -1);
  }
  return [...events.values()].sort((a, b) => a.exDate.localeCompare(b.exDate));
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
