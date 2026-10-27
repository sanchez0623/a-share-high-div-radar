import { ArrowDownLeft, ArrowUpRight, Plus, WalletCards } from 'lucide-react';
import type { DashboardResponse } from '../../shared/types.ts';
import { PortfolioDonut } from '../components/Charts.tsx';
import { SectionHeading } from '../components/UI.tsx';
import { compactMoney, money, number, percent } from '../format.ts';

interface Props {
  data: DashboardResponse;
  onTrade: () => void;
}

export default function PortfolioPage({ data, onTrade }: Props) {
  const { portfolio } = data;
  const monthlyAverage = portfolio.annualDividend / 12;
  const quarters = [0.18, 0.32, 0.2, 0.3];

  return (
    <div className="page portfolio-page">
      <header className="page-header split-header">
        <div><span className="eyebrow">CASH FLOW LEDGER</span><h1>持仓与资金</h1><p>不只记录市值波动，也记录这家公司每年给你多少现金。</p></div>
        <button className="button button-dark" onClick={onTrade}><Plus size={16} />记录一笔模拟交易</button>
      </header>

      <section className="portfolio-hero">
        <div className="portfolio-total"><span>组合总资产</span><strong>{money(portfolio.totalAssets)}</strong><p>市值 {compactMoney(portfolio.marketValue)} <i /> 现金 {compactMoney(portfolio.cash)}</p></div>
        <div className="portfolio-income"><span>预计未来 12 个月分红</span><strong>{money(portfolio.annualDividend, 0)}</strong><p>月均现金分红约 {money(monthlyAverage, 0)}</p></div>
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
          <div className="table-scroll"><table className="positions-table"><thead><tr><th>公司</th><th>持仓 / 成本</th><th>现价 / 市值</th><th>组合权重</th><th>成本股息率</th><th>预计年分红</th></tr></thead><tbody>{portfolio.positions.map((position) => { const pnl = (position.price / position.cost - 1) * 100; return <tr key={position.symbol}><td><strong>{position.name}</strong><span>{position.symbol}</span></td><td><strong>{number(position.shares, 0)} 股</strong><span>¥{number(position.cost)}</span></td><td><strong>¥{number(position.price)}</strong><span>{money(position.marketValue, 0)}</span></td><td><strong>{percent(position.weight, 1)}</strong><div className="weight-track"><i style={{ width: `${position.weight}%` }} /></div></td><td><strong>{percent(position.yieldOnCost)}</strong><span className={pnl >= 0 ? 'up' : 'down'}>市值 {pnl >= 0 ? '+' : ''}{percent(pnl, 1)}</span></td><td><strong>{money(position.annualDividend, 0)}</strong><span>现金回报</span></td></tr>; })}</tbody></table></div>
        ) : <div className="empty-state"><WalletCards size={28} /><h3>账本里还没有持仓</h3><p>记录一笔模拟交易后，这里会计算成本股息率与现金分红。</p></div>}
      </section>

      <section className="cashflow-panel">
        <div><span className="eyebrow light">DIVIDEND CALENDAR</span><h2>把收益看成一条现金流</h2><p>以下为按预计年分红拆分的演示节奏，不代表真实除息日。实际现金流需接入公司分红实施公告。</p><div className="cashflow-legend"><span><ArrowDownLeft size={15} />现金流入</span><span><ArrowUpRight size={15} />再投资前先看门槛</span></div></div>
        <div className="quarter-bars">{quarters.map((ratio, index) => <div key={index}><span>Q{index + 1}</span><div className="quarter-track"><i style={{ height: `${ratio / Math.max(...quarters) * 100}%` }} /></div><strong>{money(portfolio.annualDividend * ratio, 0)}</strong><small>演示分配</small></div>)}</div>
      </section>
    </div>
  );
}
