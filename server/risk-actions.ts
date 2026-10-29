import type {
  RiskEvent,
  RiskEventInput,
  RiskEventRecord,
  RiskSourcePatch,
  RiskVerificationInput,
} from '../shared/types.ts';
import { RiskError, RiskPersistenceError } from './errors.ts';
import {
  RISK_POLICY,
  deriveRiskEvent,
  normalizeRiskRecord,
  parseRiskEventInput,
  requireIsoDate,
  requireText,
} from './risk-model.ts';
import type { DemoState } from './state.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 记录一次人工核验：备注与证据必填，有效期由公开政策决定。 */
export function verifyRisk(
  state: DemoState,
  id: string,
  input: RiskVerificationInput,
  now = Date.now(),
): RiskEvent {
  const risk = state.risks.find((item) => item.id === id);
  if (!risk) throw new RiskError('风险事项不存在');
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RiskError('核验请求必须为JSON对象');
  }

  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length < 4) throw new RiskError('核验备注至少4个字，用于说明核对结论');
  if (note.length > 500) throw new RiskError('核验备注不能超过500字');

  const evidenceUrl = typeof input.evidenceUrl === 'string' ? input.evidenceUrl.trim() : '';
  if (evidenceUrl.length > 500) throw new RiskError('证据链接或内部记录编号不能超过500字');
  /** 任何严重度的核验都必须留下证据，否则 L3 放行无法追溯到具体材料。 */
  if (evidenceUrl.length < 4) {
    throw new RiskError('核验必须填写证据链接或内部记录编号');
  }

  const verifiedBy =
    typeof input.verifiedBy === 'string' && input.verifiedBy.trim()
      ? input.verifiedBy.trim().slice(0, 40)
      : '研究台用户';
  const validityDays = RISK_POLICY.validityDays[risk.severity];

  risk.verification = {
    verifiedAt: new Date(now).toISOString(),
    verifiedBy,
    note,
    evidenceUrl,
    revision: risk.source.revision,
    severity: risk.severity,
    expiresAt: new Date(now + validityDays * DAY_MS).toISOString(),
  };
  risk.invalidatedAt = null;
  risk.invalidatedReason = null;

  return deriveRiskEvent(risk, now);
}

/** 新增风险事项；新增高风险时，该股票此前的核验全部失效，必须重新核验。 */
export function addRiskEvent(
  state: DemoState,
  input: RiskEventInput,
  now = Date.now(),
): RiskEvent {
  const parsed = parseRiskEventInput(state, input);
  const record: RiskEventRecord = {
    id: nextRiskId(state, parsed.symbol),
    symbol: parsed.symbol,
    title: parsed.title,
    type: parsed.type,
    severity: parsed.severity,
    date: parsed.source.publishedAt,
    summary: parsed.summary,
    source: {
      publisher: parsed.source.publisher,
      url: parsed.source.url ?? null,
      excerpt: parsed.source.excerpt,
      publishedAt: parsed.source.publishedAt,
      revision: 1,
    },
    verification: null,
    invalidatedAt: null,
    invalidatedReason: null,
  };
  state.risks.push(record);

  if (record.severity === 'high') {
    invalidateSymbolVerifications(
      state,
      record.symbol,
      '新增高风险事项，原有核验需重新完成',
      now,
    );
  }

  return deriveRiskEvent(record, now);
}

/** 原文更新：版本号递增，仅使本条风险的核验失效，其他风险不受影响。 */
export function updateRiskSource(
  state: DemoState,
  id: string,
  patch: RiskSourcePatch,
  now = Date.now(),
): RiskEvent {
  const risk = state.risks.find((item) => item.id === id);
  if (!risk) throw new RiskError('风险事项不存在');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new RiskError('原文更新必须为JSON对象');
  }

  const next = { ...risk.source };
  if (patch.publisher !== undefined) {
    next.publisher = requireText(patch.publisher, '发布方', 80);
  }
  if (patch.url !== undefined) {
    if (patch.url === null) next.url = null;
    else next.url = requireText(patch.url, '原文链接', 500);
  }
  if (patch.excerpt !== undefined) {
    next.excerpt = requireText(patch.excerpt, '原文摘录', 500);
  }
  if (patch.publishedAt !== undefined) {
    next.publishedAt = requireIsoDate(patch.publishedAt, '原文发布日期');
  }
  next.revision = risk.source.revision + 1;
  risk.source = next;

  if (risk.verification) {
    risk.invalidatedAt = new Date(now).toISOString();
    risk.invalidatedReason = `原文更新至 v${next.revision}，原核验失效`;
  }

  return deriveRiskEvent(risk, now);
}

/**
 * 服务启动时恢复风险原文与核验记录。
 * `null` 表示文件尚未创建，只有这种情况可以保留演示种子；空数组是真实的空状态。
 * 文件存在时，任何一条记录校验失败都视为数据损坏并拒绝启动：
 * 静默丢弃高风险记录会直接放行研究等级，并会在下一次写盘时永久覆盖原文件。
 */
export function hydrateRisks(state: DemoState, records: unknown[] | null): void {
  if (records === null) return;

  const restored: RiskEventRecord[] = [];
  records.forEach((record, index) => {
    const normalized = normalizeRiskRecord(record, state);
    if (!normalized) {
      const id =
        record && typeof record === 'object' && typeof (record as { id?: unknown }).id === 'string'
          ? `（id=${(record as { id: string }).id}）`
          : '';
      throw new RiskPersistenceError(
        `风险记录第 ${index + 1} 条校验失败${id}：字段缺失、所属股票未知或类型非法，拒绝启动`,
      );
    }
    restored.push(normalized);
  });
  state.risks = restored;
}

function invalidateSymbolVerifications(
  state: DemoState,
  symbol: string,
  reason: string,
  now: number,
): void {
  const at = new Date(now).toISOString();
  for (const item of state.risks) {
    if (item.symbol !== symbol || !item.verification) continue;
    item.invalidatedAt = at;
    item.invalidatedReason = reason;
  }
}

function nextRiskId(state: DemoState, symbol: string): string {
  const base = `risk-${symbol}`;
  if (!state.risks.some((item) => item.id === base)) return base;
  let index = 2;
  while (state.risks.some((item) => item.id === `${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}
