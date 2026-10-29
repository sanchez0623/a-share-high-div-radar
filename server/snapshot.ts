import type { Stock } from '../shared/types.ts';
import { analyzeStock } from './research.ts';
import { deriveRiskGate } from './risk-model.ts';
import type { DemoState } from './state.ts';

/**
 * 研究快照：只依据当前价格、分红假设、持仓与全部风险事件重新计算研究结论。
 * 纯计算，不读写提醒冷却状态，因此任意次数的 GET 都返回同一结论。
 */
export function getStockSnapshot(state: DemoState, symbol: string, now = Date.now()): Stock {
  const current = state.stocks.get(symbol);
  const history = state.histories.get(symbol);
  if (!current || !history) throw new Error('未知股票代码');
  const holding = state.holdings.get(symbol) ?? { shares: 0, cost: 0, assumptionVersion: null };
  return analyzeStock({
    stock: current,
    history,
    availableCash: state.cash,
    riskGate: deriveRiskGate(state.risks, symbol, now),
    holding,
  });
}
