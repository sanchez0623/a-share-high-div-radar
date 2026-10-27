import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, FlaskConical, Save } from 'lucide-react';
import type { Stock, StockDetailResponse } from '../../shared/types.ts';
import { DividendBars } from '../components/Charts.tsx';
import { SectionHeading } from '../components/UI.tsx';
import { money, number, percent } from '../format.ts';

interface Props {
  detail: StockDetailResponse;
  stocks: Stock[];
  onSelect: (symbol: string) => void;
  onSave: (threshold: number) => Promise<void>;
  onOpenPlan: () => void;
}

type Scenario = 'conservative' | 'base' | 'optimistic';
const scenarios: { key: Scenario; label: string; factor: number; note: string }[] = [
  { key: 'conservative', label: '谨慎', factor: 0.85, note: '分红下修 15%' },
  { key: 'base', label: '基准', factor: 1, note: '沿用当前预测' },
  { key: 'optimistic', label: '乐观', factor: 1.1, note: '分红增长 10%' },
];

export default function DividendLab({ detail, stocks, onSelect, onSave, onOpenPlan }: Props) {
  const { stock, dividends } = detail;
  const [scenario, setScenario] = useState<Scenario>('base');
  const [threshold, setThreshold] = useState(stock.buyThreshold);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    setThreshold(stock.buyThreshold);
    setScenario('base');
    setSaveError('');
  }, [stock.symbol, stock.buyThreshold]);

  const activeScenario = scenarios.find((item) => item.key === scenario)!;
  const estimatedDividend = stock.forecastDividend * activeScenario.factor;
  const targetPrice = estimatedDividend / (threshold / 100);
  const priceGap = (targetPrice / stock.price - 1) * 100;
  const thresholds = useMemo(() => [threshold - 0.5, threshold, threshold + 0.5, threshold + 1], [threshold]);

  const save = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await onSave(threshold);
    } catch (reason) {
      setSaveError((reason as Error).message || '保存失败，请稍后重试');
    } finally {
      setSaving(false);
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
            <label>分红情景</label>
            <div className="scenario-tabs">
              {scenarios.map((item) => <button key={item.key} className={scenario === item.key ? 'active' : ''} onClick={() => setScenario(item.key)}><strong>{item.label}</strong><span>{item.note}</span></button>)}
            </div>
          </div>
          <div className="control-group">
            <div className="control-label"><label htmlFor="yield-range">要求股息率</label><output>{percent(threshold, 1)}</output></div>
            <input id="yield-range" type="range" min="3" max="10" step="0.1" value={threshold} onChange={(event) => { setThreshold(Number(event.target.value)); setSaveError(''); }} />
            <div className="range-labels"><span>3.0% · 宽松</span><span>10.0% · 严格</span></div>
          </div>
          <div className="assumption-note">预测每股分红 <strong>¥{number(estimatedDividend)}</strong><span>{activeScenario.label}情景 · 非公司指引</span></div>
          <button className="button button-dark full-button" disabled={saving || threshold === stock.buyThreshold} onClick={save}><Save size={16} />{saving ? '正在保存…' : threshold === stock.buyThreshold ? '当前门槛已保存' : '保存为我的研究门槛'}</button>
          {saveError && <p className="form-error" role="alert">{saveError}</p>}
        </div>

        <div className="lab-result">
          <span className="eyebrow light">REVERSE VALUATION</span>
          <p>在这个情景下，你的研究价格是</p>
          <strong className="lab-target-price">{money(targetPrice)}</strong>
          <div className="formula-line"><span>¥{number(estimatedDividend)}</span><i>÷</i><span>{percent(threshold, 1)}</span><i>=</i><b>{money(targetPrice)}</b></div>
          <div className={`price-gap ${priceGap < 0 ? 'negative' : ''}`}>
            <span>较当前价 {stock.price.toFixed(2)} 元</span>
            <strong>{priceGap >= 0 ? '+' : ''}{percent(priceGap, 1)}</strong>
            <small>{priceGap < 0 ? '仍需等待价格回落' : '当前价格已低于研究价'}</small>
          </div>
          <button className="text-link light-link" onClick={onOpenPlan}>用这个门槛生成价格阶梯<ArrowRight size={15} /></button>
        </div>
      </section>

      <section className="panel sensitivity-panel">
        <SectionHeading eyebrow="SENSITIVITY MATRIX" title="一格假设变化，价格答案就不同" aside={<span className="outline-tag">单位：元 / 股</span>} />
        <div className="table-scroll">
          <table className="sensitivity-table">
            <thead><tr><th>分红情景</th>{thresholds.map((value, index) => <th key={value} className={index === 1 ? 'highlight-column' : ''}>股息率 {percent(value, 1)}</th>)}</tr></thead>
            <tbody>{scenarios.map((item) => <tr key={item.key} className={scenario === item.key ? 'active-row' : ''}><td><strong>{item.label}</strong><span>¥{number(stock.forecastDividend * item.factor)} / 股</span></td>{thresholds.map((value, index) => { const price = stock.forecastDividend * item.factor / (value / 100); return <td key={value} className={index === 1 ? 'highlight-column' : ''}><strong>{number(price)}</strong><small className={price < stock.price ? 'down' : 'up'}>{price < stock.price ? '等待' : '已进入'}</small></td>; })}</tr>)}</tbody>
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
