import type {
  DividendFlow,
  DividendPayment,
  DividendStage,
  PersistedHolding,
  PersistedPortfolio,
  PlanAllocation,
  PlanTier,
  Portfolio,
  PortfolioPosition,
  ResearchLevel,
  Stock,
  TaxBasis,
  TradeRecord,
  TradeRequest,
  TradeResearchSnapshot,
} from '../shared/types.ts';
import {
  DEFAULT_MAX_SECTOR_WEIGHT,
  DEFAULT_MAX_STOCK_WEIGHT,
  MIN_CASH_RESERVE_RATIO,
  buildPlanAllocation,
} from '../shared/allocation.ts';
import { DIVIDEND_TAX_RATE, MIN_TRADE_PRICE, PRICE_TICK, estimateTradeFees } from '../shared/costs.ts';
import { resolveAssumption } from './assumptions.ts';
import { AS_OF } from './config.ts';
import { TradeError } from './errors.ts';
import { ALL_LEVELS, buildResearchPlan } from './research.ts';
import { round } from './numeric.ts';
import { deriveRiskEvent } from './risk-model.ts';
import { getStockSnapshot } from './snapshot.ts';
import type { DemoState } from './state.ts';

/** 单只持仓的三段分红流水：已到账、已宣告待收、预计未宣告。 */
function buildDividendFlows(
  stock: Stock,
  shares: number,
  forecastDividend: number,
): DividendFlow[] {
  if (shares <= 0) return [];
  const flows: DividendFlow[] = [];

  const push = (
    stage: DividendStage,
    dividendPerShare: number,
    payment: DividendPayment | null,
    note: string,
  ) => {
    if (!(dividendPerShare > 0)) return;
    const grossAmount = round(shares * dividendPerShare);
    const tax = round(grossAmount * DIVIDEND_TAX_RATE);
    flows.push({
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      stage,
      shares,
      dividendPerShare,
      grossAmount,
      tax,
      netAmount: round(grossAmount - tax),
      exDate: payment?.exDate ?? null,
      payDate: payment?.payDate ?? null,
      note,
    });
  };

  if (stock.receivedDividend) {
    push(
      'received',
      stock.receivedDividend.dividendPerShare,
      stock.receivedDividend,
      '已到账现金分红，已包含在可用现金中，不再重复计入',
    );
  }
  if (stock.pendingDividend) {
    push(
      'declared',
      stock.pendingDividend.dividendPerShare,
      stock.pendingDividend,
      '已宣告待收，到账前不计入可用现金',
    );
  }
  const settledPerShare =
    (stock.receivedDividend?.dividendPerShare ?? 0) +
    (stock.pendingDividend?.dividendPerShare ?? 0);
  push(
    'projected',
    round(forecastDividend - settledPerShare),
    null,
    '按当前预测分红扣除已派与已宣告部分估算，尚未宣告',
  );

  return flows;
}

/** 组合账本读取：持仓、现金与分红流水全部由事实状态现算。 */
export function getPortfolio(state: DemoState): Portfolio {
  const positions: PortfolioPosition[] = [];
  const dividendFlows: DividendFlow[] = [];
  let marketValue = 0;
  let annualDividend = 0;

  for (const [symbol, holding] of state.holdings) {
    if (holding.shares === 0) continue;
    const stock = state.stocks.get(symbol)!;
    const assumption = resolveAssumption(state, symbol);
    const positionMarketValue = round(holding.shares * stock.price);
    const positionDividend = round(holding.shares * stock.forecastDividend);
    marketValue += positionMarketValue;
    annualDividend += positionDividend;
    positions.push({
      symbol,
      name: stock.name,
      sector: stock.sector,
      shares: holding.shares,
      cost: holding.cost,
      price: stock.price,
      marketValue: positionMarketValue,
      weight: 0,
      yieldOnCost: holding.cost > 0 ? round((stock.forecastDividend / holding.cost) * 100) : 0,
      annualDividend: positionDividend,
      assumptionVersion: holding.assumptionVersion,
      forecastYear: assumption.forecastYear,
      forecastDividend: stock.forecastDividend,
      forecastSource: assumption.source,
    });
    dividendFlows.push(...buildDividendFlows(stock, holding.shares, stock.forecastDividend));
  }

  marketValue = round(marketValue);
  annualDividend = round(annualDividend);
  const totalAssets = round(state.cash + marketValue);
  for (const position of positions) {
    position.weight = totalAssets > 0 ? round((position.marketValue / totalAssets) * 100) : 0;
  }

  const settled = round(state.cash);
  const minCashReserve = round(settled * MIN_CASH_RESERVE_RATIO);
  const sumStage = (stage: DividendStage) =>
    dividendFlows
      .filter((flow) => flow.stage === stage)
      .reduce((total, flow) => total + flow.netAmount, 0);

  return {
    cash: settled,
    marketValue,
    totalAssets,
    annualDividend,
    annualDividendAfterTax: round(annualDividend * (1 - DIVIDEND_TAX_RATE)),
    portfolioYield: totalAssets > 0 ? round((annualDividend / totalAssets) * 100) : 0,
    positions,
    cashLedger: {
      settled,
      declaredReceivable: round(sumStage('declared')),
      projectedDividend: round(sumStage('projected')),
      receivedDividend: round(sumStage('received')),
      minCashReserve,
      investable: round(settled - minCashReserve),
    },
    dividendFlows,
    trades: [...state.trades],
  };
}

/** 按已到账现金、最低储备与集中度约束，把研究价格阶梯转成可执行分配。 */
export function buildAllocation(
  state: DemoState,
  symbol: string,
  plan: PlanTier[],
  budget?: number,
): PlanAllocation {
  const stock = state.stocks.get(symbol);
  if (!stock) throw new Error('未知股票代码');
  const portfolio = getPortfolio(state);
  const sectorMarketValue = portfolio.positions
    .filter((position) => position.sector === stock.sector)
    .reduce((total, position) => total + position.marketValue, 0);
  const stockMarketValue =
    portfolio.positions.find((position) => position.symbol === symbol)?.marketValue ?? 0;

  return buildPlanAllocation({
    plan,
    budget: Math.max(0, budget ?? portfolio.cashLedger.investable),
    availableCash: portfolio.cashLedger.settled,
    minCashReserve: portfolio.cashLedger.minCashReserve,
    totalAssets: portfolio.totalAssets,
    stockMarketValue,
    sectorMarketValue,
    sector: stock.sector,
    maxStockWeight: DEFAULT_MAX_STOCK_WEIGHT,
    maxSectorWeight: DEFAULT_MAX_SECTOR_WEIGHT,
  });
}

/** 落盘交易记录的边界校验：只保留字段齐全的记录，避免手改文件污染账本。 */
function isValidTradeRecord(record: unknown): record is TradeRecord {
  if (!record || typeof record !== 'object') return false;
  const r = record as Partial<TradeRecord>;
  if (typeof r.id !== 'string' || !r.id) return false;
  if (typeof r.symbol !== 'string' || !r.symbol) return false;
  if (r.side !== 'buy' && r.side !== 'sell') return false;
  if (typeof r.shares !== 'number' || r.shares <= 0) return false;
  if (typeof r.price !== 'number' || r.price <= 0) return false;
  if (typeof r.executedAt !== 'string') return false;
  if (r.taxBasis !== 'pre_tax' && r.taxBasis !== 'after_tax') return false;
  if (r.planLevel !== null && !ALL_LEVELS.includes(r.planLevel as ResearchLevel)) return false;
  return true;
}

/** 恢复落盘的持仓与交易账本；null 时保留演示初始状态。 */
export function hydratePortfolio(state: DemoState, persisted: PersistedPortfolio | null): void {
  if (!persisted || typeof persisted !== 'object') return;

  /** 观察仓：过滤无效代码，至少保留一只。 */
  if (Array.isArray(persisted.watchlist)) {
    const valid = persisted.watchlist.filter(
      (s) => typeof s === 'string' && state.stocks.has(s),
    );
    state.watchlist =
      valid.length > 0
        ? new Set(valid)
        : new Set(['601318.SH', '600941.SH', '000333.SZ']);
  }

  /** 现金：只接受非负有限数。 */
  if (
    typeof persisted.cash === 'number' &&
    Number.isFinite(persisted.cash) &&
    persisted.cash >= 0
  ) {
    state.cash = round(persisted.cash);
  }

  /** 持仓：按落盘记录覆盖，未出现的股票清零。 */
  if (Array.isArray(persisted.holdings)) {
    const restored = new Map<string, PersistedHolding>();
    for (const h of persisted.holdings) {
      if (!h || typeof h.symbol !== 'string' || !state.stocks.has(h.symbol)) continue;
      const shares =
        typeof h.shares === 'number' && Number.isFinite(h.shares) && h.shares >= 0
          ? h.shares
          : 0;
      const cost =
        typeof h.cost === 'number' && Number.isFinite(h.cost) && h.cost >= 0 ? h.cost : 0;
      restored.set(h.symbol, {
        symbol: h.symbol,
        shares,
        cost: round(cost, 4),
        assumptionVersion:
          typeof h.assumptionVersion === 'number' ? h.assumptionVersion : null,
      });
    }
    for (const symbol of state.stocks.keys()) {
      const h = restored.get(symbol);
      state.holdings.set(symbol, {
        shares: h?.shares ?? 0,
        cost: h?.cost ?? 0,
        assumptionVersion: h?.assumptionVersion ?? null,
      });
    }
  }

  /** 交易账本：只保留通过校验的记录。 */
  if (Array.isArray(persisted.trades)) {
    state.trades = persisted.trades.filter(isValidTradeRecord);
  }
}

/** 交易写操作：校验 → 更新现金与持仓 → 冻结成交时的研究快照 → 记入账本。 */
export function executeTrade(state: DemoState, request: TradeRequest): Portfolio {
  if (!request || typeof request.symbol !== 'string' || !state.stocks.has(request.symbol)) {
    throw new TradeError('股票代码无效');
  }
  if (request.side !== 'buy' && request.side !== 'sell') {
    throw new TradeError('交易方向必须为buy或sell');
  }
  if (!Number.isInteger(request.shares) || request.shares <= 0 || request.shares % 100 !== 0) {
    throw new TradeError('交易股数必须为100股的正整数倍');
  }
  /** 价格边界：最小报价单位与步长缺一不可，否则极小价格会把成本摊成零。 */
  if (!Number.isFinite(request.price) || request.price < MIN_TRADE_PRICE) {
    throw new TradeError(`交易价格不得低于${MIN_TRADE_PRICE}元`);
  }
  if (Math.abs(request.price - round(request.price)) > 1e-9) {
    throw new TradeError(`交易价格必须为${PRICE_TICK}元的整数倍`);
  }

  const holding = state.holdings.get(request.symbol)!;
  const stock = state.stocks.get(request.symbol)!;
  const amount = round(request.shares * request.price);
  /** 成交金额按分舍入后为零时，买入会零成本增加持仓，必须拒绝。 */
  if (amount < MIN_TRADE_PRICE) {
    throw new TradeError('成交金额按0.01元舍入后不足最小金额，交易未执行');
  }
  const fees = estimateTradeFees(request.side, amount);

  if (request.side === 'buy') {
    const outflow = round(amount + fees.total);
    if (outflow > state.cash + Number.EPSILON) {
      throw new TradeError('可用现金不足，交易未执行');
    }
    const newShares = holding.shares + request.shares;
    const newCost =
      (holding.shares * holding.cost + request.shares * request.price) / newShares;
    holding.shares = newShares;
    holding.cost = round(newCost, 4);
    holding.assumptionVersion = state.assumptions.get(request.symbol)?.version ?? null;
    state.cash = round(state.cash - outflow);
  } else {
    if (request.shares > holding.shares) {
      throw new TradeError('持仓数量不足，交易未执行');
    }
    holding.shares -= request.shares;
    if (holding.shares === 0) holding.cost = 0;
    state.cash = round(state.cash + amount - fees.total);
  }

  const executedAt =
    typeof request.executedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(request.executedAt)
      ? request.executedAt
      : AS_OF;
  const taxBasis: TaxBasis = request.taxBasis === 'after_tax' ? 'after_tax' : 'pre_tax';
  const planLevel: Exclude<ResearchLevel, 'L0'> | null =
    request.planLevel === 'L1' || request.planLevel === 'L2' || request.planLevel === 'L3'
      ? request.planLevel
      : null;
  const snapshot = getStockSnapshot(state, request.symbol);
  const assumption = resolveAssumption(state, request.symbol);
  const plan = buildResearchPlan(snapshot, assumption);
  const planTargetPrice = planLevel
    ? (plan.find((tier) => tier.level === planLevel)?.targetPrice ?? null)
    : null;
  const riskGate = snapshot.riskGate;
  const researchContext: TradeResearchSnapshot = {
    assumption,
    level: snapshot.level,
    dividendYield: snapshot.dividendYield,
    percentB: snapshot.percentB,
    riskGate: {
      status: riskGate.status,
      verified: riskGate.verified,
      totalCount: riskGate.totalCount,
      openCount: riskGate.openCount,
      highestOpenSeverity: riskGate.highestOpenSeverity,
      allowedLevels: riskGate.allowedLevels,
      summary: riskGate.summary,
    },
    risks: state.risks
      .filter((record) => record.symbol === request.symbol)
      .map((record) => {
        const event = deriveRiskEvent(record);
        return {
          id: record.id,
          title: record.title,
          severity: record.severity,
          status: event.status,
          statusReason: event.statusReason,
          evidenceUrl: record.verification?.evidenceUrl ?? null,
          verifiedBy: record.verification?.verifiedBy ?? null,
        };
      }),
    plan,
  };

  state.trades.unshift({
    id: `trade-${state.trades.length + 1}`,
    symbol: request.symbol,
    name: stock.name,
    side: request.side,
    shares: request.shares,
    price: request.price,
    grossAmount: amount,
    fee: round(fees.total - fees.stampDuty),
    tax: fees.stampDuty,
    netAmount:
      request.side === 'buy' ? round(amount + fees.total) : round(amount - fees.total),
    executedAt,
    taxBasis,
    assumptionVersion: state.assumptions.get(request.symbol)?.version ?? null,
    planLevel,
    planTargetPrice,
    researchContext,
  });

  return getPortfolio(state);
}
