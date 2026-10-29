import { useMemo, useState } from 'react';
import {
  ArrowDownUp,
  ArrowRight,
  Database,
  FlaskConical,
  ListFilter,
  RotateCcw,
  Settings2,
} from 'lucide-react';
import type { DashboardResponse } from '../../shared/types.ts';
import { forecastSourceLabel, statBasisLabel } from '../../shared/assumptions.ts';
import { compactMoney, money, number, percent } from '../format.ts';
import { OpportunityMap, ScoreRing, Sparkline } from '../components/Charts.tsx';
import { QuoteStatusBadge } from '../components/QuoteBadge.tsx';
import { LevelBadge, SectionHeading, SignalPill } from '../components/UI.tsx';
import type { LiveQuotesResult } from '../hooks/useLiveQuotes.ts';

interface Props {
  data: DashboardResponse;
  onSelect: (symbol: string) => void;
  onManage: () => void;
  liveQuotes: LiveQuotesResult;
}

export default function Dashboard({ data, onSelect, onManage, liveQuotes }: Props) {
  const [sortMode, setSortMode] = useState<'watchlist' | 'score' | 'yield'>('watchlist');
  const stocks = useMemo(() => {
    const result = [...data.stocks];
    if (sortMode === 'score') result.sort((a, b) => b.score - a.score);
    if (sortMode === 'yield') result.sort((a, b) => b.dividendYield - a.dividendYield);
    return result;
  }, [data.stocks, sortMode]);
  const queue = [...data.stocks].sort((a, b) => b.score - a.score);
  const openRisks = data.risks.filter((risk) => risk.status !== 'verified').length;

  return (
    <div className="page dashboard-page">
      <section className="dashboard-hero">
        <div className="hero-copy">
          <div className="hero-kicker"><span>DAILY RESEARCH</span><i />第 043 期</div>
          <h1>好价格，<br /><em>正在浮现。</em></h1>
          <p>把股息率当作标尺，把情绪留给别人。<br />今天只研究那些正在靠近你规则的公司。</p>
          <div className="hero-footnote">
            <span className="live-dot" />已扫描 {data.stocks.length} 只观察标的
            <span>·</span>{openRisks} 项风险未关闭
          </div>
        </div>
        <div className="hero-income">
          <span className="eyebrow light">FUTURE CASH FLOW</span>
          <p>预测年度分红</p>
          <strong>{money(data.portfolio.annualDividend, 0)}</strong>
          <div className="income-bottom">
            <span>未来 12 个月到账 <b>{money(data.portfolio.nextTwelveMonthDividendAfterTax, 0)}</b></span>
            <span>组合股息率 <b>{percent(data.portfolio.portfolioYield)}</b></span>
            <span>总资产 {compactMoney(data.portfolio.totalAssets)}</span>
          </div>
          <div className="income-stamp">息<br />壤</div>
        </div>
      </section>

      <div className="data-ribbon">
        <div><FlaskConical size={16} /><strong>演示研究环境</strong><span>{data.dataNotice}</span></div>
        <QuoteStatusBadge snapshot={liveQuotes.snapshot} error={liveQuotes.error} />
        <div><Database size={15} />行情 {data.dataMeta.quoteTime}<span className="ribbon-divider" />{data.dataMeta.priceAdjustment === 'forward' ? '前复权' : '不复权'}口径 · PE {statBasisLabel(data.dataMeta.peBasis)} · ROE {statBasisLabel(data.dataMeta.roeBasis)}</div>
      </div>

      <section className="dashboard-analysis-grid">
        <div className="panel map-panel">
          <SectionHeading
            eyebrow="VALUATION × POSITION"
            title="机会坐标"
            aside={<span className="section-index">01 / 03</span>}
          />
          <p className="section-description">横轴看收益率，纵轴看价格位置。右下方，才值得多停留一会儿。</p>
          <OpportunityMap stocks={data.stocks} onSelect={onSelect} />
        </div>

        <aside className="panel research-queue">
          <SectionHeading eyebrow="NEXT ACTION" title="今日研究顺序" aside={<ListFilter size={18} />} />
          <p className="section-description">关注分不是买入建议，只决定先读哪一份材料。</p>
          <div className="queue-list">
            {queue.map((stock, index) => (
              <button key={stock.symbol} className="queue-item" onClick={() => onSelect(stock.symbol)}>
                <span className="queue-number">0{index + 1}</span>
                <span className="queue-main">
                  <strong>{stock.name}</strong>
                  <small>{stock.action}</small>
                </span>
                <span className="queue-score">{stock.score}<small>/100</small></span>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
          <div className="queue-note">
            <span>研究纪律</span>
            <p>估值通过 ≠ 可以买入。五项判断必须独立呈现，风险项由人确认。</p>
          </div>
        </aside>
      </section>

      <section className="watchlist-section">
        <SectionHeading
          eyebrow="WATCHLIST / TODAY"
          title="观察仓 · 今日机会雷达"
          aside={
            <div className="section-actions">
              {sortMode !== 'watchlist' && (
                <button className="button button-ghost" onClick={() => setSortMode('watchlist')}><RotateCcw size={15} />恢复顺序</button>
              )}
              <button className="button button-secondary" onClick={() => setSortMode(sortMode === 'score' ? 'yield' : 'score')}>
                <ArrowDownUp size={15} />{sortMode === 'yield' ? '按股息率排序' : sortMode === 'score' ? '切换股息率' : '按机会分排序'}
              </button>
              <button className="button button-dark" onClick={onManage}><Settings2 size={15} />管理观察仓</button>
            </div>
          }
        />

        <div className="stock-list">
          {stocks.map((stock, index) => (
            <button className="stock-row" key={stock.symbol} onClick={() => onSelect(stock.symbol)} style={{ '--row-index': index } as React.CSSProperties}>
              <div className="stock-identity">
                <div className="stock-order">{String(index + 1).padStart(2, '0')}</div>
                <div>
                  <div className="stock-name-line"><h3>{stock.name}</h3><LevelBadge level={stock.level} /></div>
                  <p>{stock.symbol} · {stock.sector}<span>{stock.holdingShares > 0 ? `持仓 ${number(stock.holdingShares, 0)} 股` : '空仓观察'}</span></p>
                </div>
              </div>
              <div className="stock-quote">
                <span>最近收盘</span>
                <strong>¥{number(stock.price)}</strong>
                <small className={stock.changePct >= 0 ? 'up' : 'down'}>{stock.changePct >= 0 ? '+' : ''}{percent(stock.changePct)}</small>
              </div>
              <div className="stock-yield">
                <span>预测股息率</span>
                <strong>{percent(stock.dividendYield)}</strong>
                <small>门槛 {percent(stock.buyThreshold, 1)} · {forecastSourceLabel(stock.dividendForecast.source)}</small>
              </div>
              <div className="stock-chart"><Sparkline values={stock.sparkline} positive={stock.changePct >= 0} /><span>%B {number(stock.percentB * 100, 0)}</span></div>
              <div className="stock-signals">
                <div>{stock.signals.slice(0, 3).map((signal) => <SignalPill key={signal.key} status={signal.status}>{signal.label}</SignalPill>)}</div>
                <p>{stock.summary}</p>
              </div>
              <div className="stock-decision">
                <ScoreRing score={stock.score} />
                <span>{stock.action}<ArrowRight size={15} /></span>
              </div>
            </button>
          ))}
        </div>
      </section>

      <footer className="research-footer">
        <span>息壤研究原则 001</span>
        <p>不预测明天的涨跌，只准备价格到来时的动作。</p>
        <span>人工决策 · 不自动委托</span>
      </footer>
    </div>
  );
}
