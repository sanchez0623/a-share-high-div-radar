import { useEffect, useState } from 'react';
import { ArrowRight, Check, ClipboardList, LockKeyhole, ShieldAlert, ShieldCheck } from 'lucide-react';
import type {
  AssumptionPreviewResponse,
  PlanAllocation,
  Stock,
  StockDetailResponse,
} from '../../shared/types.ts';
import {
  dividendQualityLabel,
  forecastSourceLabel,
  scenarioMeta,
} from '../../shared/assumptions.ts';
import { api } from '../api.ts';
import { LevelBadge, SectionHeading } from '../components/UI.tsx';
import { compactMoney, money, number, percent } from '../format.ts';

interface Props {
  detail: StockDetailResponse;
  stocks: Stock[];
  onSelect: (symbol: string) => void;
  preview: AssumptionPreviewResponse | null;
  onSavePreview: () => Promise<void>;
  onExitPreview: () => void;
  onCreateChecklist: () => void;
}

export default function PlanPage({
  detail,
  stocks,
  onSelect,
  preview,
  onSavePreview,
  onExitPreview,
  onCreateChecklist,
}: Props) {
  const { stock, assumptionSaved } = detail;
  const [budget, setBudget] = useState(detail.allocation.investableCash);
  const [allocation, setAllocation] = useState<PlanAllocation>(detail.allocation);
  const [allocating, setAllocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const draft = preview?.assumption.symbol === stock.symbol ? preview : null;
  const assumption = draft?.assumption ?? detail.assumption;
  const plan = draft?.plan ?? detail.plan;
  const totalReference = plan.reduce((sum, tier) => sum + tier.estimatedAmount, 0);
  const investable = detail.allocation.investableCash;

  // 切换标的或假设变化时，重置预算与分配为服务端默认（真实可投入现金）。
  useEffect(() => {
    setBudget(detail.allocation.investableCash);
    setAllocation(detail.allocation);
    setError('');
  }, [detail]);

  // 预算变化时按新预算重新计算分配（防抖），未超过可投入现金时直接复用默认。
  useEffect(() => {
    if (Math.abs(budget - investable) < 0.5) return;
    const timer = setTimeout(() => {
      setAllocating(true);
      api
        .stockWithBudget(stock.symbol, budget)
        .then((result) => setAllocation(result.allocation))
        .catch((reason: Error) => setError(reason.message))
        .finally(() => setAllocating(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [budget, stock.symbol, investable]);

  const savePreview = async () => {
    setSaving(true);
    setError('');
    try {
      await onSavePreview();
    } catch (reason) {
      setError((reason as Error).message || '保存失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  const chipClass = draft ? 'draft' : assumptionSaved ? 'saved' : 'draft';
  const chipLabel = draft
    ? `临时假设 · 保存后为 v${assumption.version}`
    : assumptionSaved
      ? `已保存假设 v${assumption.version}`
      : '默认假设 · 未保存';

  const maxBudget = Math.max(10000, Math.ceil(investable));
  const step = Math.max(1000, Math.round(maxBudget / 20 / 1000) * 1000);
  const coverage = totalReference > 0 ? Math.min(100, (budget / totalReference) * 100) : 0;

  return (
    <div className="page plan-page">
      <header className="page-header split-header">
        <div><span className="eyebrow">LADDER, NOT IMPULSE</span><h1>分级加仓计划</h1><p>把“越跌越买”，改写成有估值门槛、有风险闸门、有预算约束的研究计划。</p></div>
        <div className="stock-switcher compact">
          {stocks.map((item) => <button key={item.symbol} className={item.symbol === stock.symbol ? 'active' : ''} onClick={() => onSelect(item.symbol)}>{item.name}</button>)}
        </div>
      </header>

      <div className="decision-flow" aria-label="研究决策顺序">
        {['股息估值', '分红质量', '布林超跌', '近期趋势', '事件风险', '资金预算'].map((item, index, list) => <div key={item}><span>0{index + 1}</span><strong>{item}</strong>{index < list.length - 1 && <ArrowRight size={16} />}</div>)}
      </div>

      <section className={`assumption-bar ${draft ? 'draft' : 'saved'}`}>
        <div className="assumption-bar-main">
          <span className={`assumption-chip ${chipClass}`}>{chipLabel}</span>
          <p>
            {assumption.forecastYear} 年 · {scenarioMeta(assumption.scenario).label}情景 · 预测每股分红 <strong>¥{number(assumption.dividendPerShare)}</strong> · 要求股息率 <strong>{percent(assumption.requiredYield, 1)}</strong>
          </p>
          <p className="assumption-trace-line">
            来源 {forecastSourceLabel(assumption.source)} · 报告期 {assumption.reportPeriod} · 公告日期 {assumption.announcementDate ?? '无'}
          </p>
          <p className="assumption-trace-line">假设：{assumption.hypothesis}</p>
        </div>
        {draft ? (
          <div className="assumption-actions">
            <button className="button button-dark" disabled={saving} onClick={savePreview}>{saving ? '正在保存…' : '保存为正式假设'}</button>
            <button className="button button-ghost" onClick={onExitPreview}>退出预览</button>
          </div>
        ) : (
          <span className="assumption-trace">实验室与计划页共用该版本</span>
        )}
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      {(stock.dividendQuality.status === 'fragile' || stock.dividendQuality.oneOff) && (
        <div className="quality-warning" role="status">
          <ShieldAlert size={16} />
          <span>
            分红质量{dividendQualityLabel(stock.dividendQuality.status)}：{stock.dividendQuality.notes.join('；') || '质量检查未通过，研究等级封顶L1。'}
          </span>
        </div>
      )}

      <section className="plan-overview">
        <div className="plan-current">
          <span className="eyebrow light">CURRENT POSITION</span>
          <div><LevelBadge level={stock.level} /><h2>{stock.action}</h2></div>
          <p>{stock.summary}</p>
          <div className="current-price-line"><span>当前价 <strong>¥{number(stock.price)}</strong></span><span>预测股息率 <strong>{percent(stock.dividendYield)}</strong></span><span>%B <strong>{number(stock.percentB * 100, 0)}%</strong></span></div>
        </div>
        <div className="budget-control">
          <label htmlFor="budget-range">本次研究预算</label>
          <strong>{compactMoney(budget)}</strong>
          <input id="budget-range" type="range" min="0" max={maxBudget} step={step} value={budget} onChange={(event) => setBudget(Number(event.target.value))} />
          <div className="range-labels"><span>¥0</span><span>可投入 {compactMoney(investable)}</span></div>
          <p>覆盖完整三档参考计划的 <b>{percent(coverage, 0)}</b> · 默认取组合可投入现金 {compactMoney(investable)}</p>
        </div>
      </section>

      <section className="ladder-section">
        <SectionHeading eyebrow="PRICE LADDER" title={`${stock.name} · 三级研究价格`} aside={<span className="outline-tag">{assumption.forecastYear}年预测分红 ¥{number(assumption.dividendPerShare)} / 股</span>} />
        <div className="ladder-list">
          {plan.map((tier, index) => {
            const allocTier = allocation.tiers[index];
            const refShares = allocTier?.referenceShares ?? tier.shares;
            const allocatedShares = allocTier?.allocatedShares ?? 0;
            const allocPct = refShares > 0 ? Math.min(100, (allocatedShares / refShares) * 100) : 0;
            return (
              <article className={`ladder-row ${tier.unlocked ? 'unlocked' : ''}`} key={tier.level}>
                <div className="ladder-level"><span>LEVEL</span><strong>{tier.level}</strong><small>{tier.unlocked ? '当前已触发' : `第 ${index + 1} 档`}</small></div>
                <div className="ladder-name"><h3>{tier.name}</h3><span>{tier.unlocked ? <><Check size={14} />估值与位置条件已到</> : <><LockKeyhole size={14} />等待条件同时满足</>}</span></div>
                <div className="ladder-price"><span>研究价格</span><strong>{money(tier.targetPrice ?? 0)}</strong><small>收益率 ≥ {percent(tier.yieldThreshold * 100)} · {tier.assumptionVersion > 0 ? `假设 v${tier.assumptionVersion}` : '默认假设'}</small></div>
                <div className="ladder-shares"><span>参考股数</span><strong>{tier.shares}<i>股</i></strong><small>{money(tier.estimatedAmount, 0)}</small></div>
                <div className="ladder-budget">
                  <span>预算内可分配</span>
                  <strong>{allocatedShares} / {refShares} 股</strong>
                  <div className="coverage-track"><i style={{ width: `${allocPct}%` }} /></div>
                  <small>本档 {money(allocTier?.allocatedAmount ?? 0, 0)} · 累计 {money(allocTier?.cumulativeAmount ?? 0, 0)} · 剩余 {money(allocTier?.remainingBudget ?? 0, 0)}</small>
                  {allocTier && allocTier.blockers.length > 0 && <div className="ladder-blockers">{allocTier.blockers.map((reason) => <p key={reason}><ShieldAlert size={13} />{reason}</p>)}</div>}
                </div>
                <div className="ladder-conditions">{tier.conditions.map((condition) => <p key={condition}><ShieldCheck size={14} />{condition}</p>)}</div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="allocation-panel">
        <SectionHeading eyebrow="EXECUTABLE BUDGET" title="资金分配与集中度预览" aside={<span className="outline-tag">{allocating ? '正在按预算重算…' : '累计分配 · 不超预算'}</span>} />
        <div className="allocation-summary">
          <div><span>已到账现金</span><strong>{money(allocation.investableCash + allocation.minCashReserve, 0)}</strong><small>含最低储备</small></div>
          <div><span>可投入现金</span><strong>{money(allocation.investableCash, 0)}</strong><small>已扣最低储备 {money(allocation.minCashReserve, 0)}</small></div>
          <div><span>本次批准预算</span><strong>{money(allocation.approvedBudget, 0)}</strong><small>请求 {money(allocation.requestedBudget, 0)}</small></div>
          <div><span>三档合计分配</span><strong>{money(allocation.totalAllocated, 0)}</strong><small>占预算 {percent(allocation.approvedBudget > 0 ? allocation.totalAllocated / allocation.approvedBudget * 100 : 0, 1)}</small></div>
          <div><span>买入费用</span><strong>{money(allocation.totalFees, 0)}</strong><small>含佣金与过户费</small></div>
          <div><span>未分配剩余</span><strong>{money(allocation.unallocated, 0)}</strong><small>可留作后续档位</small></div>
        </div>
        <div className="weight-preview">
          <div className="weight-item"><span>加仓后个股权重</span><strong>{percent(allocation.stockWeightAfter, 1)}</strong><div className="weight-track"><i style={{ width: `${Math.min(100, allocation.stockWeightAfter)}%` }} /></div><small>上限 {allocation.limits.maxStockWeight}%</small></div>
          <div className="weight-item"><span>加仓后行业权重</span><strong>{percent(allocation.sectorWeightAfter, 1)}</strong><div className="weight-track"><i style={{ width: `${Math.min(100, allocation.sectorWeightAfter)}%` }} /></div><small>上限 {allocation.limits.maxSectorWeight}%</small></div>
          <div className="weight-item"><span>计划总股数</span><strong>{allocation.totalShares}<i>股</i></strong><small>三档累计</small></div>
        </div>
        {allocation.notes.length > 0 && <ul className="allocation-notes">{allocation.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
        <p className="legal-note">预算、最低储备与集中度上限共同约束各档实际可买股数；参考股数 100/200/300 仅为研究口径，不自动成交。</p>
      </section>

      <section className="cooldown-note">
        <div className="cooldown-number">24<span>h</span></div>
        <div><span className="eyebrow">COOLING-OFF PERIOD</span><h3>同一等级，不重复催促。</h3><p>同一标的在同一研究等级触发后进入 24 小时冷却期，只抑制重复提醒，不改变研究等级与动作。只有价格进入更深档位、分红假设变化或人工风险状态改变，才重新评估提醒。</p></div>
        <button className="button button-dark" onClick={onCreateChecklist}><ClipboardList size={16} />生成研究清单</button>
      </section>
      <p className="legal-note">L1 / L2 / L3 是研究等级，不是券商条件单，也不代表必须重复买入。所有操作均需人工确认。</p>
    </div>
  );
}
