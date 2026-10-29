import type { Portfolio, Stock } from '../shared/types.ts';
import { getPortfolio } from './portfolio.ts';
import { dispatchReminder, type ReminderDecision } from './reminder.ts';
import { getStockSnapshot } from './snapshot.ts';
import type { DemoState } from './state.ts';

export interface ResearchChangeResult {
  /** 变更后重新计算的纯计算快照。 */
  stock: Stock;
  /** 本次变更触发的提醒判定（冷却状态只在 dispatchReminder 内部写入）。 */
  reminder: ReminderDecision;
}

/**
 * 状态变更后的唯一联动入口：重算快照 → 评估并写入提醒冷却。
 * 读取路径（任何 GET）永远不调用这里，因此读取既不改缓存也不产生冷却写入。
 */
export function commitResearchChange(
  state: DemoState,
  symbol: string,
  now = Date.now(),
): ResearchChangeResult {
  const stock = getStockSnapshot(state, symbol, now);
  const reminder = dispatchReminder(state, stock, now);
  return { stock, reminder };
}

/**
 * 交易候选范围：观察仓 + 全部现有持仓。
 * 移出观察仓不等于清仓，持仓仍必须出现在交易弹窗里才能卖出。
 */
export function collectPortfolioSymbols(state: DemoState): string[] {
  const symbols = new Set(state.watchlist);
  for (const [symbol, holding] of state.holdings) {
    if (holding.shares > 0) symbols.add(symbol);
  }
  return Array.from(symbols);
}

export interface PortfolioChangeResult {
  /** 变更后重新计算的组合账本。 */
  portfolio: Portfolio;
  /** 交易候选范围内全部股票的派生快照。 */
  stocks: Stock[];
}

/**
 * 现金或持仓变化后的唯一联动入口。
 * 现金参与资金信号与评分、持仓参与成本与仓位，两者任一变化后都必须重算；
 * 派生结论不落缓存，这里一次性重算并交由调用方直接返回，避免下游拿到变更前的评分。
 */
export function commitPortfolioChange(
  state: DemoState,
  now = Date.now(),
): PortfolioChangeResult {
  return {
    portfolio: getPortfolio(state),
    stocks: collectPortfolioSymbols(state).map((symbol) => getStockSnapshot(state, symbol, now)),
  };
}
