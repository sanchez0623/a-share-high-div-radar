import type {
  ResearchLevel,
  RiskEvent,
  RiskEventInput,
  RiskEventRecord,
  RiskGate,
  RiskGateStatus,
  RiskPolicy,
  RiskSeverity,
  RiskType,
  RiskVerification,
  RiskVerificationStatus,
} from '../shared/types.ts';
import { RiskError } from './errors.ts';
import { ALL_LEVELS } from './research.ts';
import type { DemoState } from './state.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const RISK_SEVERITIES: readonly RiskSeverity[] = ['high', 'medium', 'low'];
const RISK_TYPES: readonly RiskType[] = ['公告', '财务', '行业', '数据'];
/** 严重度排序：数字越小越严重。 */
const SEVERITY_RANK: Record<RiskSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * 风险政策：核验有效期与“严重度 × L1–L3”阻断矩阵的唯一公开口径。
 * 高风险未关闭时全部等级阻断；仅中/低风险未关闭时阻断 L3；全部有效核验才解锁 L3。
 */
export const RISK_POLICY: RiskPolicy = {
  validityDays: { high: 7, medium: 14, low: 30 },
  rules: [
    {
      condition: '全部风险事件在有效期内完成核验',
      allowedLevels: [...ALL_LEVELS],
    },
    {
      condition: '仅中/低风险未关闭（无高风险未关闭）',
      allowedLevels: ['L1', 'L2'],
    },
    {
      condition: '存在未关闭的高风险事项',
      allowedLevels: [],
    },
  ],
  note: '风险闸门只下调研究等级上限，不产生任何自动交易；每次核验必须留下备注与证据，核验有效期按严重度分别为高7天、中14天、低30天。',
};

/**
 * 派生单条风险的核验状态。
 * 原文版本不一致、被后续事件作废或超过有效期，都不算通过。
 */
export function deriveRiskEvent(record: RiskEventRecord, now = Date.now()): RiskEvent {
  const verification = record.verification;
  let status: RiskVerificationStatus = 'pending';
  let statusReason = '尚未完成人工核验，原文与来源仍需人工确认';

  if (verification) {
    const verifiedAt = Date.parse(verification.verifiedAt);
    const invalidatedAt = record.invalidatedAt ? Date.parse(record.invalidatedAt) : null;
    const expiresAt = Date.parse(verification.expiresAt);
    if (invalidatedAt !== null && Number.isFinite(verifiedAt) && invalidatedAt >= verifiedAt) {
      status = 'invalidated';
      statusReason = record.invalidatedReason ?? '核验已被后续事件作废，需重新核验';
    } else if (verification.revision !== record.source.revision) {
      status = 'invalidated';
      statusReason = `原文已更新至 v${record.source.revision}，原核验基于 v${verification.revision}`;
    } else if (!verification.evidenceUrl || verification.evidenceUrl.trim().length < 4) {
      /** 旧记录或手改文件可能缺少证据；没有证据的核验一律不算通过。 */
      status = 'invalidated';
      statusReason = '核验缺少可追溯证据，需重新完成核验';
    } else if (!Number.isFinite(expiresAt) || now > expiresAt) {
      status = 'expired';
      statusReason = `核验有效期至 ${verification.expiresAt.slice(0, 10)}，已过期`;
    } else {
      status = 'verified';
      statusReason = `核验有效至 ${verification.expiresAt.slice(0, 10)}`;
    }
  }

  const daysRemaining =
    verification && status === 'verified'
      ? Math.max(0, Math.ceil((Date.parse(verification.expiresAt) - now) / DAY_MS))
      : null;

  return { ...record, status, statusReason, daysRemaining };
}

/** 纯函数：股票级风险闸门由该股票全部风险事件派生，任何单条核验都不能代表整体完成。 */
export function deriveRiskGate(
  records: RiskEventRecord[],
  symbol: string,
  now = Date.now(),
): RiskGate {
  const items = records.filter((record) => record.symbol === symbol).map((record) =>
    deriveRiskEvent(record, now),
  );
  const open = items.filter((item) => item.status !== 'verified');
  const highestOpenSeverity = open.reduce<RiskSeverity | null>(
    (worst, item) =>
      worst === null || SEVERITY_RANK[item.severity] < SEVERITY_RANK[worst]
        ? item.severity
        : worst,
    null,
  );
  const allowedLevels: ResearchLevel[] =
    highestOpenSeverity === 'high' ? [] : open.length > 0 ? ['L1', 'L2'] : [...ALL_LEVELS];
  const blockedLevels = ALL_LEVELS.filter((level) => !allowedLevels.includes(level));

  /** 股票级状态只在这里派生一次，接口与页面都直接使用，不再各自推断。 */
  const status: RiskGateStatus =
    items.length === 0
      ? 'clear'
      : open.length === 0
        ? 'verified'
        : highestOpenSeverity === 'high'
          ? 'blocked'
          : 'review';

  const count = (target: RiskVerificationStatus) =>
    items.filter((item) => item.status === target).length;

  const summary =
    items.length === 0
      ? '未登记风险事项，风险闸门不额外阻断'
      : open.length === 0
        ? `${items.length}项风险均在有效期内完成核验，L1–L3按量化条件放行`
        : highestOpenSeverity === 'high'
          ? `${open.length}/${items.length}项风险未关闭且含高风险：L1–L3全部阻断`
          : `${open.length}/${items.length}项风险未关闭（无高风险）：L1/L2可研究，L3阻断`;

  return {
    status,
    verified: items.length > 0 && open.length === 0,
    totalCount: items.length,
    openCount: open.length,
    pendingCount: count('pending'),
    expiredCount: count('expired'),
    invalidatedCount: count('invalidated'),
    highestOpenSeverity,
    allowedLevels,
    blockedLevels,
    signature: items
      .map(
        (item) =>
          `${item.id}:${item.status}:r${item.source.revision}:${item.verification?.expiresAt ?? '-'}`,
      )
      .sort()
      .join('|'),
    summary,
  };
}

/** 对外返回的风险列表：每次都按当前时间重新派生状态。 */
export function getRiskEvents(state: DemoState, now = Date.now()): RiskEvent[] {
  return state.risks.map((record) => deriveRiskEvent(record, now));
}

function isRiskSeverity(value: unknown): value is RiskSeverity {
  return typeof value === 'string' && (RISK_SEVERITIES as readonly string[]).includes(value);
}

function isRiskType(value: unknown): value is RiskType {
  return typeof value === 'string' && (RISK_TYPES as readonly string[]).includes(value);
}

export function requireIsoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RiskError(`${field}必须为YYYY-MM-DD格式`);
  }
  return value;
}

export function requireText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new RiskError(`${field}不能为空`);
  if (text.length > maxLength) throw new RiskError(`${field}不能超过${maxLength}字`);
  return text;
}

/** 新增风险的规范化入参：原文摘录必填，没有原文就不登记风险。 */
export interface ParsedRiskEventInput {
  symbol: string;
  title: string;
  type: RiskType;
  severity: RiskSeverity;
  summary: string;
  source: { publisher: string; url: string | null; excerpt: string; publishedAt: string };
}

export function parseRiskEventInput(state: DemoState, body: unknown): ParsedRiskEventInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RiskError('请求体必须为JSON对象');
  }
  const input = body as Partial<RiskEventInput>;
  const symbol = typeof input.symbol === 'string' ? input.symbol.trim().toUpperCase() : '';
  if (!state.stocks.has(symbol)) throw new RiskError('股票代码无效');
  if (!isRiskType(input.type)) throw new RiskError('风险类型必须为公告、财务、行业或数据');
  if (!isRiskSeverity(input.severity)) throw new RiskError('风险严重度必须为high、medium或low');

  const rawSource = input.source;
  if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) {
    throw new RiskError('风险来源不能为空');
  }
  const url =
    typeof rawSource.url === 'string' && rawSource.url.trim()
      ? rawSource.url.trim().slice(0, 500)
      : undefined;

  return {
    symbol,
    title: requireText(input.title, '风险标题', 120),
    type: input.type,
    severity: input.severity,
    summary: requireText(input.summary, '风险摘要', 500),
    source: {
      publisher: requireText(rawSource.publisher, '发布方', 80),
      url: url ?? null,
      excerpt: requireText(rawSource.excerpt, '原文摘录', 500),
      publishedAt: requireIsoDate(rawSource.publishedAt, '原文发布日期'),
    },
  };
}

/** 恢复落盘记录时做边界校验，避免手改文件污染研究结论。 */
export function normalizeRiskRecord(
  record: unknown,
  state: DemoState,
): RiskEventRecord | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const raw = record as Partial<RiskEventRecord>;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.symbol !== 'string' || !state.stocks.has(raw.symbol)) return null;
  if (!isRiskType(raw.type) || !isRiskSeverity(raw.severity)) return null;
  if (!raw.source || typeof raw.source !== 'object') return null;

  const source = raw.source;
  if (typeof source.publisher !== 'string' || !source.publisher) return null;
  if (typeof source.excerpt !== 'string' || !source.excerpt) return null;
  if (typeof source.publishedAt !== 'string') return null;
  if (!Number.isInteger(source.revision) || source.revision < 1) return null;

  let verification: RiskVerification | null = null;
  if (raw.verification) {
    const item = raw.verification;
    if (
      typeof item.verifiedAt !== 'string' ||
      typeof item.verifiedBy !== 'string' ||
      typeof item.note !== 'string' ||
      typeof item.expiresAt !== 'string' ||
      !isRiskSeverity(item.severity) ||
      !Number.isInteger(item.revision)
    ) {
      return null;
    }
    verification = {
      verifiedAt: item.verifiedAt,
      verifiedBy: item.verifiedBy,
      note: item.note,
      evidenceUrl: typeof item.evidenceUrl === 'string' ? item.evidenceUrl : null,
      revision: item.revision,
      severity: item.severity,
      expiresAt: item.expiresAt,
    };
  }

  return {
    id: raw.id,
    symbol: raw.symbol,
    title: typeof raw.title === 'string' ? raw.title : '',
    type: raw.type,
    severity: raw.severity,
    date: typeof raw.date === 'string' ? raw.date : source.publishedAt,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    source: {
      publisher: source.publisher,
      url: typeof source.url === 'string' ? source.url : null,
      excerpt: source.excerpt,
      publishedAt: source.publishedAt,
      revision: source.revision,
    },
    verification,
    invalidatedAt: typeof raw.invalidatedAt === 'string' ? raw.invalidatedAt : null,
    invalidatedReason: typeof raw.invalidatedReason === 'string' ? raw.invalidatedReason : null,
  };
}
