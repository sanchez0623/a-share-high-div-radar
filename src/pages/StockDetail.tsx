import { ArrowLeft, ArrowRight, CheckCircle2, CircleDashed, ShieldAlert } from 'lucide-react';
import type { StockDetailResponse, Stock } from '../../shared/types.ts';
import { DividendBars, PriceChart } from '../components/Charts.tsx';
import { LevelBadge, SectionHeading, SignalPill } from '../components/UI.tsx';
import { money, number, percent } from '../format.ts';

interface Props {
  detail: StockDetailResponse;
  stocks: Stock[];
  onSelect: (symbol: string) => void;
  onBack: () => void;
  onOpenPlan: () => void;
}

export default function StockDetail({ detail, stocks, onSelect, onBack, onOpenPlan }: Props) {
  const { stock, history, dividends, plan } = detail;
  const nextTier = plan.find((tier) => !tier.unlocked) ?? plan.at(-1)!;

  return (
    <div className="page detail-page">
      <button className="back-link" onClick={onBack}><ArrowLeft size={16} />返回今日雷达</button>
      <div className="stock-switcher" aria-label="切换观察股票">
        {stocks.map((item) => (
          <button key={item.symbol} className={item.symbol === stock.symbol ? 'active' : ''} onClick={() => onSelect(item.symbol)}>{item.name}</button>
        ))}
      </div>

      <section className="detail-hero">
        <div>
          <div className="detail-stock-meta"><LevelBadge level={stock.level} /><span>{stock.symbol}</span><span>{stock.sector}</span></div>
          <h1>{stock.name}</h1>
          <p>{stock.summary}</p>
        </div>
        <div className="detail-yield-block">
          <span>预测股息率 / FORECAST YIELD</span>
          <strong>{percent(stock.dividendYield)}</strong>
          <small>你的研究门槛 {percent(stock.buyThreshold)}</small>
        </div>
      </section>

      <section className="metric-strip">
        <div><span>最近收盘</span><strong>¥{number(stock.price)}</strong><small className={stock.changePct >= 0 ? 'up' : 'down'}>{stock.changePct >= 0 ? '+' : ''}{percent(stock.changePct)}</small></div>
        <div><span>预测每股分红</span><strong>¥{number(stock.forecastDividend)}</strong><small>派息率 {percent(stock.payoutRatio, 0)}</small></div>
        <div><span>布林位置</span><strong>%B {number(stock.percentB * 100, 0)}</strong><small>下轨 ¥{number(stock.bollLower)}</small></div>
        <div><span>ATR 波动</span><strong>¥{number(stock.atr)}</strong><small>MA20 ¥{number(stock.ma20)}</small></div>
        <div><span>估值 / 盈利</span><strong>{number(stock.pe, 1)} PE</strong><small>ROE {percent(stock.roe, 1)}</small></div>
      </section>

      <section className="detail-analysis-grid">
        <div className="panel price-panel">
          <SectionHeading eyebrow="PRICE STRUCTURE / 60D" title="价格结构" aside={<span className="snapshot-label">{stock.updatedAt} 快照</span>} />
          <PriceChart history={history} stock={stock} />
        </div>
        <aside className="panel signal-panel">
          <SectionHeading eyebrow="FIVE GATES" title="五道独立闸门" />
          <div className="signal-list">
            {stock.signals.map((signal, index) => (
              <div className="signal-item" key={signal.key}>
                <span className={`signal-status-icon status-${signal.status}`}>
                  {signal.status === 'pass' ? <CheckCircle2 size={18} /> : <CircleDashed size={18} />}
                </span>
                <div><strong><i>0{index + 1}</i>{signal.label}</strong><p>{signal.description}</p></div>
                <span className="signal-value">{signal.value}</span>
              </div>
            ))}
          </div>
          {!stock.riskVerified && <div className="risk-reminder"><ShieldAlert size={17} /><span>风险未核验，任何量化等级都不能直接转化为委托。</span></div>}
        </aside>
      </section>

      <section className="detail-bottom-grid">
        <div className="panel dividend-history-panel">
          <SectionHeading eyebrow="DIVIDEND TRACK RECORD" title="分红连续性" aside={<span className="outline-tag">连续 {stock.dividendStreak} 年</span>} />
          <DividendBars dividends={dividends} />
          <p className="panel-footnote">历史记录为演示口径；预测分红需结合最新财报、派息政策与现金流人工确认。</p>
        </div>
        <div className="panel next-step-panel">
          <span className="eyebrow light">NEXT RESEARCH LEVEL</span>
          <div className="next-level-title"><LevelBadge level={nextTier.level} /><h2>{nextTier.name}</h2></div>
          <p>不是挂单价，而是重新翻开这家公司研究材料的价格。</p>
          <div className="next-price"><span>研究价格</span><strong>{money(nextTier.targetPrice ?? 0)}</strong></div>
          <div className="next-tier-facts"><span>收益率门槛 <b>{percent(nextTier.yieldThreshold * 100)}</b></span><span>参考股数 <b>{nextTier.shares} 股</b></span></div>
          <button className="button button-accent" onClick={onOpenPlan}>展开完整价格阶梯<ArrowRight size={16} /></button>
        </div>
      </section>
    </div>
  );
}
