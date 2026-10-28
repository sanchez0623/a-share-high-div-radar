import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileSearch,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import type {
  DashboardResponse,
  ResearchLevel,
  RiskEvent,
  RiskEventInput,
  RiskSeverity,
  RiskType,
  RiskVerificationInput,
  RiskVerificationStatus,
} from '../../shared/types.ts';
import { SectionHeading } from '../components/UI.tsx';

interface Props {
  data: DashboardResponse;
  onVerify: (id: string, input: RiskVerificationInput) => Promise<void>;
  onAddRisk: (input: RiskEventInput) => Promise<void>;
  onRefreshSource: (id: string) => Promise<void>;
}

const STATUS_LABEL: Record<RiskVerificationStatus, string> = {
  pending: '待核验',
  verified: '核验有效',
  expired: '已过期',
  invalidated: '已作废',
};

const SEVERITY_LABEL: Record<RiskSeverity, string> = {
  high: '高优先级',
  medium: '中优先级',
  low: '低优先级',
};

const LEVELS: ResearchLevel[] = ['L1', 'L2', 'L3'];

function stamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

export default function RiskPage({ data, onVerify, onAddRisk, onRefreshSource }: Props) {
  const [filter, setFilter] = useState<'all' | 'open' | 'verified'>('all');
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const open = data.risks.filter((risk) => risk.status !== 'verified');
  const risks = data.risks.filter((risk) =>
    filter === 'all' ? true : filter === 'open' ? risk.status !== 'verified' : risk.status === 'verified',
  );

  const refreshSource = async (id: string) => {
    setRefreshingId(id);
    try {
      await onRefreshSource(id);
    } finally {
      setRefreshingId(null);
    }
  };

  const verify = async (id: string, input: RiskVerificationInput) => {
    await onVerify(id, input);
    setVerifyingId(null);
  };

  const add = async (input: RiskEventInput) => {
    await onAddRisk(input);
    setAdding(false);
  };

  return (
    <div className="page risk-page">
      <header className="page-header split-header">
        <div>
          <span className="eyebrow">HUMAN-IN-THE-LOOP</span>
          <h1>风险哨兵</h1>
          <p>每条风险都要留下原文、核验记录与有效期；核验会过期，原文更新会作废旧核验。</p>
        </div>
        <div className="risk-counter">
          <strong>{open.length}</strong>
          <span>项风险未关闭 / 共 {data.risks.length} 项</span>
        </div>
      </header>

      <section className="risk-gates">
        <div><FileSearch size={22} /><span>01 / 原文与来源</span><h3>先有原文，才登记风险</h3><p>发布方、原文摘录、发布日期与原文版本一并留痕。</p></div>
        <div><AlertTriangle size={22} /><span>02 / 严重度矩阵</span><h3>高风险阻断全部等级</h3><p>高风险未关闭时 L1–L3 全部暂停，中/低风险仅阻断 L3。</p></div>
        <div><LockKeyhole size={22} /><span>03 / 会过期的核验</span><h3>有效期到了就重来</h3><p>核验有效期按严重度分为高 7 天、中 14 天、低 30 天。</p></div>
        <div><ShieldCheck size={22} /><span>04 / 逐条派生</span><h3>单条核验不等于整体通过</h3><p>股票级状态由全部风险事件派生，任一条未关闭都不算通过。</p></div>
      </section>

      <section className="panel risk-policy-panel">
        <SectionHeading
          eyebrow="PUBLIC RULES"
          title="严重度 × 研究等级阻断矩阵"
          aside={<span className="outline-tag">政策口径公开 · 不可直接改写</span>}
        />
        <div className="risk-policy-grid">
          <table className="risk-policy-table">
            <thead>
              <tr><th>风险状态</th>{LEVELS.map((level) => <th key={level}>{level}</th>)}</tr>
            </thead>
            <tbody>
              {data.riskPolicy.rules.map((rule) => (
                <tr key={rule.condition}>
                  <td>{rule.condition}</td>
                  {LEVELS.map((level) => {
                    const allowed = rule.allowedLevels.includes(level);
                    return (
                      <td key={level} className={allowed ? 'allow' : 'block'}>
                        {allowed ? '放行' : '阻断'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="risk-gate-list">
            <span className="eyebrow">STOCK GATE / 股票级派生状态</span>
            {data.stocks.map((stock) => (
              <div className="risk-gate-row" key={stock.symbol}>
                <strong>{stock.name}</strong>
                <span>{stock.symbol}</span>
                <em
                  className={
                    stock.riskGate.verified
                      ? 'gate-verified'
                      : stock.riskGate.highestOpenSeverity === 'high'
                        ? 'gate-blocked'
                        : 'gate-review'
                  }
                >
                  {stock.riskGate.verified
                    ? '全部有效'
                    : stock.riskGate.highestOpenSeverity === 'high'
                      ? '高风险阻断'
                      : 'L3 阻断'}
                </em>
                <span>未关闭 {stock.riskGate.openCount}/{stock.riskGate.totalCount}</span>
                <span>允许 {stock.riskGate.allowedLevels.join(' / ') || '无'}</span>
              </div>
            ))}
          </div>
        </div>
        <p className="risk-policy-note">
          {data.riskPolicy.note} 有效期：高 {data.riskPolicy.validityDays.high} 天 / 中{' '}
          {data.riskPolicy.validityDays.medium} 天 / 低 {data.riskPolicy.validityDays.low} 天。
        </p>
      </section>

      <section className="risk-events-section">
        <SectionHeading
          eyebrow="VERIFICATION QUEUE"
          title="人工核验队列"
          aside={
            <div className="section-actions">
              <div className="filter-tabs">
                {([['all', '全部'], ['open', '未关闭'], ['verified', '核验有效']] as const).map(([key, label]) => (
                  <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>
                ))}
              </div>
              <button className="button button-secondary" onClick={() => setAdding((value) => !value)}>
                <Plus size={15} />登记风险事项
              </button>
            </div>
          }
        />

        {adding && <AddRiskForm stocks={data.stocks} asOf={data.asOf} onSubmit={add} onCancel={() => setAdding(false)} />}

        <div className="risk-event-list">
          {risks.map((risk) => (
            <article className={`risk-event severity-${risk.severity} status-${risk.status}`} key={risk.id}>
              <div className="risk-event-date">
                <strong>{risk.date.slice(8)}</strong>
                <span>{risk.date.slice(0, 7)}</span>
              </div>
              <div className="risk-event-main">
                <div className="risk-event-tags">
                  <span>{risk.type}</span>
                  <span>{risk.symbol}</span>
                  <span className={`severity-label ${risk.severity}`}>{SEVERITY_LABEL[risk.severity]}</span>
                  <span className={`risk-status ${risk.status}`}>{STATUS_LABEL[risk.status]}</span>
                  <span>原文 v{risk.source.revision}</span>
                </div>
                <h3>{risk.title}</h3>
                <p>{risk.summary}</p>
                <div className="risk-source">
                  <div><span>来源</span><p>{risk.source.publisher} · {risk.source.publishedAt}</p></div>
                  <div>
                    <span>原文</span>
                    <p>
                      {risk.source.url ? (
                        <a href={risk.source.url} target="_blank" rel="noreferrer">
                          <ExternalLink size={12} />{risk.source.url}
                        </a>
                      ) : (
                        risk.source.excerpt
                      )}
                    </p>
                  </div>
                </div>
                {risk.verification && (
                  <div className={`risk-verification ${risk.status}`}>
                    <div>
                      <strong>{risk.verification.verifiedBy}</strong>
                      <span>{stamp(risk.verification.verifiedAt)}</span>
                      <em>
                        基于原文 v{risk.verification.revision} · 有效期至{' '}
                        {risk.verification.expiresAt.slice(0, 10)}
                        {risk.daysRemaining !== null ? ` · 剩 ${risk.daysRemaining} 天` : ''}
                      </em>
                    </div>
                    <p>{risk.verification.note}</p>
                    {risk.verification.evidenceUrl && (
                      <p className="risk-evidence">
                        证据：
                        {risk.verification.evidenceUrl.startsWith('http') ? (
                          <a href={risk.verification.evidenceUrl} target="_blank" rel="noreferrer">
                            {risk.verification.evidenceUrl}
                          </a>
                        ) : (
                          risk.verification.evidenceUrl
                        )}
                      </p>
                    )}
                  </div>
                )}
                <p className={`risk-status-reason ${risk.status}`}>
                  {risk.status === 'verified' ? <CheckCircle2 size={13} /> : risk.status === 'expired' ? <Clock3 size={13} /> : <ShieldAlert size={13} />}
                  {risk.statusReason}
                </p>
              </div>
              <div className="risk-event-action">
                <button className="button button-secondary" onClick={() => setVerifyingId(risk.id)}>
                  {risk.status === 'verified' ? '重新核验' : '记录核验'}
                </button>
                <button
                  className="button button-ghost"
                  disabled={refreshingId === risk.id}
                  onClick={() => refreshSource(risk.id)}
                >
                  <RefreshCw size={14} />{refreshingId === risk.id ? '更新中…' : '原文已更新'}
                </button>
              </div>
              {verifyingId === risk.id && (
                <VerifyForm
                  risk={risk}
                  onSubmit={(input) => verify(risk.id, input)}
                  onCancel={() => setVerifyingId(null)}
                />
              )}
            </article>
          ))}
          {risks.length === 0 && <p className="risk-empty">当前筛选下没有风险事项。</p>}
        </div>
      </section>

      <section className="truth-panel">
        <div><span className="eyebrow light">DATA TRUTHFULNESS</span><h2>没有原文，<br />就没有“已核验”。</h2></div>
        <div className="truth-rules">
          <p><span>01</span>实时源不可用，则停止输出趋势，不以模拟价格替代。</p>
          <p><span>02</span>资讯未接入时，风险状态保持“待核验”，并明确标注为演示原文。</p>
          <p><span>03</span>每次核验都记录核验人、时间、备注、证据与有效期，过期自动失效。</p>
          <p><span>04</span>当前版本为演示研究环境，不连接交易柜台。</p>
        </div>
      </section>
    </div>
  );
}

function VerifyForm({
  risk,
  onSubmit,
  onCancel,
}: {
  risk: RiskEvent;
  onSubmit: (input: RiskVerificationInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState('');
  const [verifiedBy, setVerifiedBy] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    if (note.trim().length < 4) {
      setError('核验备注至少4个字，用于说明核对结论');
      return;
    }
    if (evidence.trim().length < 4) {
      setError('核验必须填写证据链接或内部记录编号');
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        note: note.trim(),
        evidenceUrl: evidence.trim(),
        verifiedBy: verifiedBy.trim() || undefined,
      });
    } catch (reason) {
      setError((reason as Error).message || '核验提交失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="risk-verify-form">
      <div className="verify-form-head">
        <strong>记录核验：{risk.title}</strong>
        <span>
          原文 v{risk.source.revision} · {SEVERITY_LABEL[risk.severity]} · 有效期{' '}
          {risk.severity === 'high' ? '7' : risk.severity === 'medium' ? '14' : '30'} 天
        </span>
      </div>
      <label className="field">
        <span>核验备注（必填，说明核对结论）</span>
        <textarea value={note} rows={2} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="例如：已核对分红方案原文，派息率与现金流覆盖无异常。" />
      </label>
      <div className="verify-form-row">
        <label className="field">
          <span>证据链接 / 内部记录编号（必填，L3 放行据此追溯）</span>
          <input value={evidence} maxLength={500} onChange={(event) => setEvidence(event.target.value)} placeholder="https://… 或 内部纪要-20261028" />
        </label>
        <label className="field">
          <span>核验人</span>
          <input value={verifiedBy} maxLength={40} onChange={(event) => setVerifiedBy(event.target.value)} placeholder="默认：研究台用户" />
        </label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="verify-form-actions">
        <button className="button button-ghost" onClick={onCancel}>取消</button>
        <button className="button button-dark" disabled={busy} onClick={submit}>{busy ? '正在记录…' : '提交核验记录'}</button>
      </div>
    </div>
  );
}

function AddRiskForm({
  stocks,
  asOf,
  onSubmit,
  onCancel,
}: {
  stocks: DashboardResponse['stocks'];
  asOf: string;
  onSubmit: (input: RiskEventInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [symbol, setSymbol] = useState(stocks[0]?.symbol ?? '');
  const [title, setTitle] = useState('');
  const [type, setType] = useState<RiskType>('公告');
  const [severity, setSeverity] = useState<RiskSeverity>('medium');
  const [summary, setSummary] = useState('');
  const [publisher, setPublisher] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [url, setUrl] = useState('');
  const [publishedAt, setPublishedAt] = useState(asOf);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    if (!symbol || !title.trim() || !summary.trim() || !publisher.trim() || !excerpt.trim()) {
      setError('股票、标题、摘要、发布方与原文摘录均为必填项');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)) {
      setError('原文发布日期必须为YYYY-MM-DD格式');
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        symbol,
        title: title.trim(),
        type,
        severity,
        summary: summary.trim(),
        source: {
          publisher: publisher.trim(),
          excerpt: excerpt.trim(),
          publishedAt,
          url: url.trim() || undefined,
        },
      });
    } catch (reason) {
      setError((reason as Error).message || '风险登记失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="risk-add-form">
      <div className="verify-form-head">
        <strong>登记风险事项</strong>
        <span>新增高风险会使该股票既有核验全部失效</span>
      </div>
      <div className="risk-add-grid">
        <label className="field"><span>股票</span><select value={symbol} onChange={(event) => setSymbol(event.target.value)}>{stocks.map((stock) => <option key={stock.symbol} value={stock.symbol}>{stock.name} {stock.symbol}</option>)}</select></label>
        <label className="field"><span>类型</span><select value={type} onChange={(event) => setType(event.target.value as RiskType)}>{(['公告', '财务', '行业', '数据'] as const).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label className="field"><span>严重度</span><select value={severity} onChange={(event) => setSeverity(event.target.value as RiskSeverity)}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
        <label className="field"><span>原文发布日期</span><input value={publishedAt} onChange={(event) => setPublishedAt(event.target.value)} placeholder="2026-10-28" /></label>
      </div>
      <label className="field"><span>风险标题</span><input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="例如：监管处罚公告" /></label>
      <label className="field"><span>风险摘要</span><textarea value={summary} rows={2} maxLength={500} onChange={(event) => setSummary(event.target.value)} placeholder="用一句话说明风险事实与影响范围。" /></label>
      <div className="verify-form-row">
        <label className="field"><span>发布方</span><input value={publisher} maxLength={80} onChange={(event) => setPublisher(event.target.value)} placeholder="例如：上交所公告" /></label>
        <label className="field"><span>原文链接（可选）</span><input value={url} maxLength={500} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></label>
      </div>
      <label className="field"><span>原文摘录（必填）</span><textarea value={excerpt} rows={2} maxLength={500} onChange={(event) => setExcerpt(event.target.value)} placeholder="粘贴原文关键段落，无法跳转时以此核对。" /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="verify-form-actions">
        <button className="button button-ghost" onClick={onCancel}>取消</button>
        <button className="button button-dark" disabled={busy} onClick={submit}>{busy ? '正在登记…' : '登记风险'}</button>
      </div>
    </div>
  );
}
