import { ArrowDownLeft, ArrowUpRight, Plus, WalletCards } from 'lucide-react';
import type { DashboardResponse, TradeRecord } from '../../shared/types.ts';
import { forecastSourceLabel, statBasisLabel } from '../../shared/assumptions.ts';
import { PortfolioDonut } from '../components/Charts.tsx';
import { SectionHeading } from '../components/UI.tsx';
import { compactMoney, money, number, percent } from '../format.ts';

interface Props {
  data: DashboardResponse;
  onTrade: () => void;
}

function stageLabel(stage: TradeRecord['side']): string {
  return stage === 'buy' ? '买入' : '卖出';
}

export default function PortfolioPage({ data, onTrade }: Props) {
  const { portfolio } = data;
  const monthlyAverage = portfolio.annualDividend / 12;
  const quarters = [0.18, 0.32, 0.2, 0.3];
  const { cashLedger } = portfolio;

  return (
    <div className="page portfolio-page">
      <header className="page-header split-header">
        <div><span className="eyebrow">CASH FLOW LEDGER</span><h1>持仓与资金</h1><p>不只记录市值波动，也记录这家公司每年给你多少现金，以及每笔交易当时的研究假设。</p></div>
        <button className="button button-dark" onClick={onTrade}><Plus size={16} />记录一笔模拟交易</button>
      </header>

      <section className="portfolio-hero">
        <div className="portfolio-total"><span>组合总资产</span><strong>{money(portfolio.totalAssets)}</strong><p>市值 {compactMoney(portfolio.marketValue)} <i /> 现金 {compactMoney(portfolio.cash)}</p></div>
        <div className="portfolio-income"><span>预计未来 12 个月分红</span><strong>{money(portfolio.annualDividend, 0)}</strong><p>月均现金分红约 {money(monthlyAverage, 0)} · 税后 {money(portfolio.annualDividendAfterTax, 0)}</p></div>
        <PortfolioDonut portfolio={portfolio} />
      </section>

      <section className="portfolio-metric-grid">
        <div><span>组合股息率</span><strong>{percent(portfolio.portfolioYield)}</strong><small>预计分红 / 总资产</small></div>
        <div><span>现金仓位</span><strong>{percent(portfolio.cash / portfolio.totalAssets * 100, 1)}</strong><small>保留等待好价格的能力</small></div>
        <div><span>持仓数量</span><strong>{portfolio.positions.length}<i>只</i></strong><small>观察仓 {data.stocks.length} 只</small></div>
        <div><span>可用现金</span><strong>{compactMoney(portfolio.cash)}</strong><small>用于预算约束检验</small></div>
      </section>

      <section className="panel positions-panel">
        <SectionHeading eyebrow="POSITIONS" title="持仓明细" aside={<span className="outline-tag"><WalletCards size={14} />成本法演示账本</span>} />
        {portfolio.positions.length > 0 ? (
          <div className="table-scroll"><table className="positions-table"><thead><tr><th>公司</th><th>持仓 / 成本</th><th>现价 / 市值</th><th>组合权重</th><th>成本股息率</th><th>预计年分红</th><th>假设版本</th></tr></thead><tbody>{portfolio.positions.map((position) => { const pnl = (position.price / position.cost - 1) * 100; return <tr key={position.symbol}><td><strong>{position.name}</strong><span>{position.symbol} · {position.sector}</span></td><td><strong>{number(position.shares, 0)} 股</strong><span>¥{number(position.cost)}</span></td><td><strong>¥{number(position.price)}</strong><span>{money(position.marketValue, 0)}</span></td><td><strong>{percent(position.weight, 1)}</strong><div className="weight-track"><i style={{ width: `${position.weight}%` }} /></div></td><td><strong>{percent(position.yieldOnCost)}</strong><span className={pnl >= 0 ? 'up' : 'down'}>市值 {pnl >= 0 ? '+' : ''}{percent(pnl, 1)}</span></td><td><strong>{money(position.annualDividend, 0)}</strong><span>{position.forecastYear}年 · ¥{number(position.forecastDividend)}/股</span></td><td><strong>{position.assumptionVersion ? `v${position.assumptionVersion}` : '—'}</strong><span>当前 {forecastSourceLabel(position.forecastSource)}</span></td></tr>; })}</tbody></table></div>
        ) : <div className="empty-state"><WalletCards size={28} /><h3>账本里还没有持仓</h3><p>记录一笔模拟交易后，这里会计算成本股息率与现金分红。</p></div>}
        <p className="panel-footnote">预计年分红按当前生效的分红假设重算：分红下修后，雷达股息率、研究价阶梯与本页现金流同步变化。行情 {data.dataMeta.quoteTime} · {data.dataMeta.priceAdjustment === 'forward' ? '前复权' : '不复权'} · PE {statBasisLabel(data.dataMeta.peBasis)} · ROE {statBasisLabel(data.dataMeta.roeBasis)}。</p>
      </section>

      <section className="cashflow-panel">
        <div><span className="eyebrow light">DIVIDEND CALENDAR</span><h2>把收益看成一条现金流</h2><p>以下为按预计年分红拆分的演示节奏，不代表真实除息日。实际现金流需接入公司分红实施公告。</p><div className="cashflow-legend"><span><ArrowDownLeft size={15} />现金流入</span><span><ArrowUpRight size={15} />再投资前先看门槛</span></div></div>
        <div className="quarter-bars">{quarters.map((ratio, index) => <div key={index}><span>Q{index + 1}</span><div className="quarter-track"><i style={{ height: `${ratio / Math.max(...quarters) * 100}%` }} /></div><strong>{money(portfolio.annualDividend * ratio, 0)}</strong><small>演示分配</small></div>)}</div>
      </section>

      <section className="panel cash-stage-panel">
        <SectionHeading eyebrow="CASH STAGES" title="现金分档：只有到账才能加仓" aside={<span className="outline-tag">预计分红不重复计入</span>} />
        <div className="cash-stage-grid">
          <div className="cash-stage received"><span>已到账现金</span><strong>{money(cashLedger.settled, 0)}</strong><small>其中已到账分红 {money(cashLedger.receivedDividend, 0)}</small></div>
          <div className="cash-stage declared"><span>已宣告待收</span><strong>{money(cashLedger.declaredReceivable, 0)}</strong><small>不可用于加仓，到账后并入</small></div>
          <div className="cash-stage projected"><span>预计未宣告</span><strong>{money(cashLedger.projectedDividend, 0)}</strong><small>仅作现金流参考</small></div>
          <div className="cash-stage reserve"><span>最低现金储备</span><strong>{money(cashLedger.minCashReserve, 0)}</strong><small>可投入上限 = 到账 − 储备</small></div>
          <div className="cash-stage investable"><span>可投入现金</span><strong>{money(cashLedger.investable, 0)}</strong><small>加仓预算的真实上限</small></div>
        </div>
        {portfolio.dividendFlows.length > 0 ? (
          <div className="table-scroll"><table className="flow-table"><thead><tr><th>公司</th><th>阶段</th><th>股数</th><th>每股分红</th><th>税前</th><th>预估税</th><th>税后</th><th>除息日</th><th>到账日</th></tr></thead><tbody>{portfolio.dividendFlows.map((flow) => <tr key={`${flow.symbol}-${flow.stage}`}><td><strong>{flow.name}</strong><span>{flow.symbol}</span></td><td><span className={`stage-badge ${flow.stage}`}>{flow.stage === 'received' ? '已到账' : flow.stage === 'declared' ? '已宣告' : '预计'}</span></td><td>{number(flow.shares, 0)} 股</td><td>¥{number(flow.dividendPerShare)}</td><td>{money(flow.grossAmount, 0)}</td><td>−{money(flow.tax, 0)}</td><td><strong>{money(flow.netAmount, 0)}</strong></td><td>{flow.exDate ?? '—'}</td><td>{flow.payDate ?? '—'}</td></tr>)}</tbody></table></div>
        ) : <div className="empty-state compact"><WalletCards size={22} /><h3>暂无分红现金流</h3><p>建仓后按持仓与分红假设生成三段式现金流。</p></div>}
        <p className="panel-footnote">红利税按持股 1 个月至 1 年档 10% 估算；已宣告待收与预计分红均不计入可投入现金，避免重复计算。</p>
      </section>

      <section className="panel trade-ledger-panel">
        <SectionHeading eyebrow="TRADE LEDGER" title="模拟交易账本" aside={<span className="outline-tag">含成交日期 · 费用 · 假设追溯</span>} />
        {portfolio.trades.length > 0 ? (
          <div className="table-scroll"><table className="trade-table"><thead><tr><th>时间</th><th>公司</th><th>方向</th><th>股数</th><th>成交价</th><th>成交金额</th><th>费用</th><th>税</th><th>现金影响</th><th>口径</th><th>计划档位</th><th>假设</th></tr></thead><tbody>{portfolio.trades.map((trade) => <tr key={trade.id}><td>{trade.executedAt}</td><td><strong>{trade.name}</strong><span>{trade.symbol}</span></td><td><span className={`side-badge ${trade.side}`}>{stageLabel(trade.side)}</span></td><td>{number(trade.shares, 0)} 股</td><td>¥{number(trade.price)}</td><td>{money(trade.grossAmount, 0)}</td><td>−{money(trade.fee, 0)}</td><td>{trade.tax > 0 ? `−${money(trade.tax, 0)}` : '—'}</td><td><strong className={trade.netAmount >= 0 ? 'up' : 'down'}>{trade.netAmount >= 0 ? '+' : ''}{money(trade.netAmount, 0)}</strong></td><td>{trade.taxBasis === 'after_tax' ? '税后' : '税前'}</td><td>{trade.planLevel ? <span className="level-chip">{trade.planLevel}</span> : <span className="muted">人工记录</span>}{trade.planTargetPrice ? <small className="muted"> 研究价 ¥{number(trade.planTargetPrice)}</small> : null}</td><td>{trade.assumptionVersion ? `v${trade.assumptionVersion}` : '默认假设'}</td></tr>)}</tbody></table></div>
        ) : <div className="empty-state"><WalletCards size={28} /><h3>账本里还没有成交</h3><p>记录一笔模拟交易后，这里会追溯成交日期、费用与当时的研究假设和计划档位。</p></div>}
        <p className="panel-footnote">交易记录可追溯到成交时生效的假设版本与计划档位（含该档当时的研究价格），用于复盘计划与成交的偏差。</p>
      </section>
    </div>
  );
}
