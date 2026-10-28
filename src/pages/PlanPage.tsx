import { useState } from 'react';
import { ArrowRight, Check, ClipboardList, LockKeyhole, ShieldCheck } from 'lucide-react';
import type {
  AssumptionPreviewResponse,
  Stock,
  StockDetailResponse,
} from '../../shared/types.ts';
import { scenarioMeta } from '../../shared/assumptions.ts';
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
  const [budget, setBudget] = useState(50000);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const draft = preview?.assumption.symbol === stock.symbol ? preview : null;
  const assumption = draft?.assumption ?? detail.assumption;
  const plan = draft?.plan ?? detail.plan;
  const totalReference = plan.reduce((sum, tier) => sum + tier.estimatedAmount, 0);

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

  return (
    <div className="page plan-page">
      <header className="page-header split-header">
        <div><span className="eyebrow">LADDER, NOT IMPULSE</span><h1>分级加仓计划</h1><p>把“越跌越买”，改写成有估值门槛、有风险闸门的研究计划。</p></div>
        <div className="stock-switcher compact">
          {stocks.map((item) => <button key={item.symbol} className={item.symbol === stock.symbol ? 'active' : ''} onClick={() => onSelect(item.symbol)}>{item.name}</button>)}
        </div>
      </header>

      <div className="decision-flow" aria-label="研究决策顺序">
        {['股息估值', '布林超跌', '近期趋势', '事件风险', '资金预算'].map((item, index) => <div key={item}><span>0{index + 1}</span><strong>{item}</strong>{index < 4 && <ArrowRight size={16} />}</div>)}
      </div>

      <section className={`assumption-bar ${draft ? 'draft' : 'saved'}`}>
        <div className="assumption-bar-main">
          <span className={`assumption-chip ${chipClass}`}>{chipLabel}</span>
          <p>
            {assumption.forecastYear} 年 · {scenarioMeta(assumption.scenario).label}情景 · 预测每股分红 <strong>¥{number(assumption.dividendPerShare)}</strong> · 要求股息率 <strong>{percent(assumption.requiredYield, 1)}</strong>
          </p>
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
          <input id="budget-range" type="range" min="10000" max="100000" step="5000" value={budget} onChange={(event) => setBudget(Number(event.target.value))} />
          <div className="range-labels"><span>¥10,000</span><span>¥100,000</span></div>
          <p>覆盖完整三档参考计划的 <b>{percent(Math.min(100, budget / totalReference * 100), 0)}</b></p>
        </div>
      </section>

      <section className="ladder-section">
        <SectionHeading eyebrow="PRICE LADDER" title={`${stock.name} · 三级研究价格`} aside={<span className="outline-tag">{assumption.forecastYear}年预测分红 ¥{number(assumption.dividendPerShare)} / 股</span>} />
        <div className="ladder-list">
          {plan.map((tier, index) => {
            const affordableShares = Math.floor(budget / (tier.targetPrice ?? 1) / 100) * 100;
            return (
              <article className={`ladder-row ${tier.unlocked ? 'unlocked' : ''}`} key={tier.level}>
                <div className="ladder-level"><span>LEVEL</span><strong>{tier.level}</strong><small>{tier.unlocked ? '当前已触发' : `第 ${index + 1} 档`}</small></div>
                <div className="ladder-name"><h3>{tier.name}</h3><span>{tier.unlocked ? <><Check size={14} />估值与位置条件已到</> : <><LockKeyhole size={14} />等待条件同时满足</>}</span></div>
                <div className="ladder-price"><span>研究价格</span><strong>{money(tier.targetPrice ?? 0)}</strong><small>收益率 ≥ {percent(tier.yieldThreshold * 100)} · {tier.assumptionVersion > 0 ? `假设 v${tier.assumptionVersion}` : '默认假设'}</small></div>
                <div className="ladder-shares"><span>参考股数</span><strong>{tier.shares}<i>股</i></strong><small>{money(tier.estimatedAmount, 0)}</small></div>
                <div className="ladder-budget"><span>预算可覆盖</span><strong>{Math.min(affordableShares, tier.shares)} / {tier.shares} 股</strong><div className="coverage-track"><i style={{ width: `${Math.min(100, affordableShares / tier.shares * 100)}%` }} /></div></div>
                <div className="ladder-conditions">{tier.conditions.map((condition) => <p key={condition}><ShieldCheck size={14} />{condition}</p>)}</div>
              </article>
            );
          })}
        </div>
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
