import { useEffect, useMemo, useState } from 'react';
import { Check, Eye, FlaskConical, Save } from 'lucide-react';
import type {
  AssumptionInput,
  DividendScenario,
  Stock,
  StockDetailResponse,
} from '../../shared/types.ts';
import {
  FORECAST_YEARS,
  SCENARIOS,
  latestDividendGrowth,
  projectedDividendPerShare,
  researchPrice,
  scenarioMeta,
} from '../../shared/assumptions.ts';
import { DividendBars } from '../components/Charts.tsx';
import { SectionHeading } from '../components/UI.tsx';
import { money, number, percent } from '../format.ts';

interface Props {
  detail: StockDetailResponse;
  stocks: Stock[];
  onSelect: (symbol: string) => void;
  onSave: (input: AssumptionInput) => Promise<void>;
  onPreview: (input: AssumptionInput) => Promise<void>;
}

const tierDefinitions = [
  { level: 'L1', name: '初步研究', premium: 0 },
  { level: 'L2', name: '深入复核', premium: 0.5 },
  { level: 'L3', name: '严格核验', premium: 1 },
] as const;

export default function DividendLab({ detail, stocks, onSelect, onSave, onPreview }: Props) {
  const { stock, dividends, assumption, assumptionSaved } = detail;
  const [scenario, setScenario] = useState<DividendScenario>(assumption.scenario);
  const [forecastYear, setForecastYear] = useState(assumption.forecastYear);
  const [threshold, setThreshold] = useState(assumption.requiredYield);
  const [busy, setBusy] = useState<'save' | 'preview' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setScenario(assumption.scenario);
    setForecastYear(assumption.forecastYear);
    setThreshold(assumption.requiredYield);
    setBusy(null);
    setError('');
  }, [
    stock.symbol,
    assumption.scenario,
    assumption.forecastYear,
    assumption.requiredYield,
    assumption.version,
  ]);

  const growth = latestDividendGrowth(dividends);
  const activeScenario = scenarioMeta(scenario);
  const dividendPerShare = useMemo(
    () => projectedDividendPerShare(stock.baseDividend, dividends, forecastYear, scenario),
    [stock.baseDividend, dividends, forecastYear, scenario],
  );
  const targetPrice = researchPrice(dividendPerShare, threshold);
  const priceGap = (targetPrice / stock.price - 1) * 100;
  const thresholds = useMemo(
    () => [threshold - 0.5, threshold, threshold + 0.5, threshold + 1],
    [threshold],
  );

  const isSaved =
    assumptionSaved &&
    assumption.scenario === scenario &&
    assumption.forecastYear === forecastYear &&
    Math.abs(assumption.requiredYield - threshold) < 1e-9;
  const statusLabel = isSaved
    ? `已保存 · v${assumption.version}`
    : assumptionSaved
      ? `临时改动 · 基于 v${assumption.version}`
      : '默认假设 · 未保存';

  const input: AssumptionInput = { forecastYear, scenario, requiredYield: threshold };

  const run = async (action: 'save' | 'preview') => {
    setBusy(action);
    setError('');
    try {
      await (action === 'save' ? onSave(input) : onPreview(input));
    } catch (reason) {
      setError((reason as Error).message || '操作失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page lab-page">
      <header className="page-header split-header">
        <div><span className="eyebrow">DIVIDEND FORECAST LAB</span><h1>分红实验室</h1><p>先写下你要求的回报，再倒推值得研究的价格。</p></div>
        <div className="stock-switcher compact">
          {stocks.map((item) => <button key={item.symbol} className={item.symbol === stock.symbol ? 'active' : ''} onClick={() => onSelect(item.symbol)}>{item.name}</button>)}
        </div>
      </header>

      <section className="lab-workbench">
        <div className="lab-controls">
          <div className="lab-stock-heading"><FlaskConical size={20} /><span>当前实验样本</span><strong>{stock.name}</strong><small>{stock.symbol}</small></div>
          <div className="control-group">
            <div className="control-label"><label htmlFor="forecast-year">预测年度</label><output className="year-output">{forecastYear}<i>年</i></output></div>
            <select id="forecast-year" className="year-select" value={forecastYear} onChange={(event) => { setForecastYear(Number(event.target.value)); setError(''); }}>
              {FORECAST_YEARS.map((year) => <option key={year} value={year}>{year} 年 · 按近一年增速 {percent(growth, 2)} 外推</option>)}
            </select>
          </div>
          <div className="control-group">
            <label>分红情景</label>
            <div className="scenario-tabs">
              {SCENARIOS.map((item) => <button key={item.key} className={scenario === item.key ? 'active' : ''} onClick={() => { setScenario(item.key); setError(''); }}><strong>{item.label}</strong><span>{item.note}</span></button>)}
            </div>
          </div>
          <div className="control-group">
            <div className="control-label"><label htmlFor="yield-range">要求股息率</label><output>{percent(threshold, 1)}</output></div>
            <input id="yield-range" type="range" min="3" max="10" step="0.1" value={threshold} onChange={(event) => { setThreshold(Number(event.target.value)); setError(''); }} />
            <div className="range-labels"><span>3.0% · 宽松</span><span>10.0% · 严格</span></div>
          </div>
          <div className="assumption-note">
            <strong>¥{number(dividendPerShare)}</strong>
            <span>{forecastYear}年 · {activeScenario.label}情景 · 每股分红</span>
            <em className={`assumption-chip ${isSaved ? 'saved' : 'draft'}`}>{statusLabel}</em>
          </div>
          <div className="assumption-actions">
            <button className="button button-dark" disabled={busy !== null || isSaved} onClick={() => run('save')}><Save size={16} />{busy === 'save' ? '正在保存…' : '保存并生成计划'}</button>
            <button className="button button-secondary" disabled={busy !== null} onClick={() => run('preview')}><Eye size={16} />{busy === 'preview' ? '正在生成…' : '仅临时预览'}</button>
          </div>
          {isSaved && <p className="assumption-hint">该假设已保存为 v{assumption.version}，实验室与计划页共用同一套研究价格。</p>}
          {!assumptionSaved && <p className="assumption-hint">尚未保存假设，当前按原始预测与默认门槛计算。</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>

        <div className="lab-result">
          <span className="eyebrow light">REVERSE VALUATION</span>
          <p>在这个情景下，你的研究价格是</p>
          <strong className="lab-target-price">{money(targetPrice)}</strong>
          <div className="formula-line"><span>¥{number(dividendPerShare)}</span><i>÷</i><span>{percent(threshold, 1)}</span><i>=</i><b>{money(targetPrice)}</b></div>
          <div className="lab-tier-strip">
            {tierDefinitions.map((tier) => <div key={tier.level}><span>{tier.level} {tier.name}</span><strong>{money(researchPrice(dividendPerShare, threshold + tier.premium))}</strong></div>)}
          </div>
          <div className={`price-gap ${priceGap < 0 ? 'negative' : ''}`}>
            <span>较当前价 {stock.price.toFixed(2)} 元</span>
            <strong>{priceGap >= 0 ? '+' : ''}{percent(priceGap, 1)}</strong>
            <small>{priceGap < 0 ? '仍需等待价格回落' : '当前价格已低于研究价'}</small>
          </div>
          <p className="lab-tier-note">三档价格与计划页同源，均按本页假设推导。</p>
        </div>
      </section>

      <section className="panel sensitivity-panel">
        <SectionHeading eyebrow="SENSITIVITY MATRIX" title="一格假设变化，价格答案就不同" aside={<span className="outline-tag">单位：元 / 股 · {forecastYear}年</span>} />
        <div className="table-scroll">
          <table className="sensitivity-table">
            <thead><tr><th>分红情景</th>{thresholds.map((value, index) => <th key={value} className={index === 1 ? 'highlight-column' : ''}>股息率 {percent(value, 1)}</th>)}</tr></thead>
            <tbody>{SCENARIOS.map((item) => {
              const dividend = projectedDividendPerShare(stock.baseDividend, dividends, forecastYear, item.key);
              return <tr key={item.key} className={scenario === item.key ? 'active-row' : ''}><td><strong>{item.label}</strong><span>¥{number(dividend)} / 股</span></td>{thresholds.map((value, index) => { const price = researchPrice(dividend, value); return <td key={value} className={index === 1 ? 'highlight-column' : ''}><strong>{number(price)}</strong><small className={price < stock.price ? 'down' : 'up'}>{price < stock.price ? '等待' : '已进入'}</small></td>; })}</tr>;
            })}</tbody>
          </table>
        </div>
      </section>

      <section className="lab-bottom-grid">
        <div className="panel">
          <SectionHeading eyebrow="QUALITY CHECK" title="高股息，先要能持续" />
          <div className="quality-metrics">
            <div><span>演示派息率</span><strong>{percent(stock.payoutRatio, 0)}</strong><div className="quality-track"><i style={{ width: `${Math.min(stock.payoutRatio, 100)}%` }} /></div><small>{stock.payoutRatio > 80 ? '偏高，需核验现金覆盖' : '处于可研究区间'}</small></div>
            <div><span>连续分红</span><strong>{stock.dividendStreak}<i>年</i></strong><small>连续性不等于未来承诺</small></div>
            <div><span>ROE</span><strong>{percent(stock.roe, 1)}</strong><small>需结合杠杆与利润质量</small></div>
          </div>
          <ul className="research-checklist"><li><Check size={15} />分红是否由自由现金流覆盖？</li><li><Check size={15} />派息率提升是否来自一次性收益？</li><li><Check size={15} />行业资本开支是否将挤压未来分红？</li></ul>
        </div>
        <div className="panel">
          <SectionHeading eyebrow="FIVE-YEAR RECORD" title="历史分红轨迹" />
          <DividendBars dividends={dividends} />
        </div>
      </section>
    </div>
  );
}
