import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlanTier, PriceBar, ResearchLevel } from '../shared/types.ts';
import { adjustForExDividend, projectedDividendPerShare, researchPrice } from '../shared/assumptions.ts';
import { buildPlanAllocation } from '../shared/allocation.ts';
import { isIsoCalendarDate } from '../shared/date.ts';
import {
  hydrateAssumptions,
  previewAssumption,
  resolveAssumption,
  saveAssumption,
} from './assumptions.ts';
import { createDemoState } from './demo-data.ts';
import { aggregateDividendRecords, applyDividendHistory, computeDividendStreak } from './dividend-history.ts';
import type { DividendEvent } from './providers/tencent-fqkline.ts';
import { buildDividendQuality, type DividendQualityInput } from './dividend-quality.ts';
import { TradeError } from './errors.ts';
import { calculateIndicators } from './indicators.ts';
import { buildAllocation, executeTrade, getPortfolio, hydratePortfolio } from './portfolio.ts';
import { dispatchReminder } from './reminder.ts';
import { buildResearchPlan, deriveResearchLevel, SIGNAL_WEIGHTS, analyzeStock } from './research.ts';
import { round } from './numeric.ts';
import { RISK_POLICY, deriveRiskEvent, deriveRiskGate } from './risk-model.ts';
import { addRiskEvent, updateRiskSource, verifyRisk } from './risk-actions.ts';
import { deploymentAuthError, parsePublicDeployment } from './security.ts';
import { getStockSnapshot } from './snapshot.ts';
import { commitPortfolioChange } from './state-change.ts';
import { reviewTrades } from './trade-review.ts';

const ALLOW_ALL = { allowedLevels: ['L1', 'L2', 'L3'] as ResearchLevel[] };
const ALLOW_L1_L2 = { allowedLevels: ['L1', 'L2'] as ResearchLevel[] };

function fixtureHistory(): PriceBar[] {
  return Array.from({ length: 20 }, (_, index) => {
    const close = index < 10 ? 10 : 12;
    return {
      date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000,
    };
  });
}

test('布林20日与ATR14使用确定口径计算，指标保留未舍入值', () => {
  const result = calculateIndicators(fixtureHistory());
  assert.equal(result.ma20, 11);
  assert.equal(result.bollMiddle, 11);
  assert.equal(result.bollUpper, 13);
  assert.equal(result.bollLower, 9);
  assert.equal(result.percentB, 0.75);
  /** ATR 不做内部舍入：真实波幅合计 29，除以 14。 */
  assert.equal(result.atr, 29 / 14);
});

test('门槛附近的股息率按未舍入值分级，展示值才四舍五入', () => {
  const state = createDemoState();
  const stock = state.stocks.get('601318.SH')!;
  const history = state.histories.get('601318.SH')!.map((bar) => ({ ...bar }));
  /** 近20日横盘且最后一日略低，%B 低于 L1 的 0.2 技术门槛。 */
  for (let index = history.length - 20; index < history.length; index += 1) {
    const close = index === history.length - 1 ? 49.9 : 50;
    history[index] = { ...history[index], open: close, high: close, low: close, close };
  }
  const riskGate = deriveRiskGate(state.risks, '601318.SH');
  const analyze = (forecastDividend: number) =>
    analyzeStock({
      stock: { ...stock, forecastDividend, buyThreshold: 5.5 },
      history,
      availableCash: state.cash,
      riskGate,
      holding: { shares: 0, cost: 0 },
    });

  /** 原始股息率 2.7425 / 49.9 ≈ 5.496%，展示四舍五入为 5.50%，实际未达 5.5% 门槛。 */
  const below = analyze(2.7425);
  assert.equal(below.dividendYield, 5.5);
  assert.equal(below.level, 'L0');
  assert.equal(below.signals.find((signal) => signal.key === 'valuation')!.status, 'watch');
  assert.equal(below.action, '等待更深价格');

  /** 原始股息率 2.745 / 49.9 ≈ 5.501%，展示同样是 5.50%，但内部值已达标。 */
  const above = analyze(2.745);
  assert.equal(above.dividendYield, 5.5);
  assert.equal(above.level, 'L1');
  assert.equal(above.signals.find((signal) => signal.key === 'valuation')!.status, 'pass');
});

test('评分按SignalKey绑定权重，权重合计100且不依赖信号数组下标', () => {
  assert.equal(
    Object.values(SIGNAL_WEIGHTS).reduce((total, weight) => total + weight, 0),
    100,
  );
  const stock = getStockSnapshot(createDemoState(), '601318.SH');
  assert.equal(
    new Set(stock.signals.map((signal) => signal.key)).size,
    Object.keys(SIGNAL_WEIGHTS).length,
  );
  const factors = { pass: 1, watch: 0.6, neutral: 0.3, block: 0 };
  const expected = Object.entries(SIGNAL_WEIGHTS).reduce((total, [key, weight]) => {
    const signal = stock.signals.find((item) => item.key === key)!;
    return total + weight * factors[signal.status];
  }, 0);
  assert.equal(stock.score, round(expected));
});

test('研究价严格由预测股息除以各档收益率门槛推导', () => {
  const state = createDemoState();
  const stock = state.stocks.get('601318.SH')!;
  const assumption = resolveAssumption(state, '601318.SH');
  const plan = buildResearchPlan({ ...stock, level: 'L3', riskGate: ALLOW_ALL }, assumption);
  const premiums = [0, 0.5, 1];
  const shares = [100, 200, 300];

  plan.forEach((tier, index) => {
    const expectedThreshold = (assumption.requiredYield + premiums[index]) / 100;
    const expectedPrice = researchPrice(assumption.dividendPerShare, assumption.requiredYield + premiums[index]);
    assert.equal(tier.yieldThreshold, expectedThreshold);
    assert.equal(tier.targetPrice, expectedPrice);
    assert.equal(tier.shares, shares[index]);
    assert.equal(tier.assumptionVersion, assumption.version);
  });
});

test('保存假设生成版本并同步股票研究口径，价格与实验室公式一致', () => {
  const state = createDemoState();
  const first = saveAssumption(state, '601318.SH', {
    forecastYear: 2027,
    scenario: 'conservative',
    requiredYield: 6.5,
  });
  assert.equal(first.version, 1);
  assert.equal(first.savedAt !== null, true);
  assert.equal(first.dividendPerShare, 2.57);

  const stock = state.stocks.get('601318.SH')!;
  assert.equal(stock.buyThreshold, 6.5);
  assert.equal(stock.forecastDividend, first.dividendPerShare);
  assert.equal(stock.assumptionVersion, 1);
  assert.equal(stock.baseDividend, 2.85);

  const plan = buildResearchPlan(stock, resolveAssumption(state, '601318.SH'));
  assert.deepEqual(
    plan.map((tier) => tier.targetPrice),
    [6.5, 7, 7.5].map((yieldPercent) => researchPrice(first.dividendPerShare, yieldPercent)),
  );

  const second = saveAssumption(state, '601318.SH', {
    forecastYear: 2026,
    scenario: 'base',
    requiredYield: 5.5,
  });
  assert.equal(second.version, 2);
  assert.equal(second.dividendPerShare, 2.85);
});

test('临时预览不写入状态也不递增版本', () => {
  const state = createDemoState();
  const preview = previewAssumption(state, '600941.SH', {
    forecastYear: 2026,
    scenario: 'optimistic',
    requiredYield: 6,
  });
  assert.equal(preview.assumption.savedAt, null);
  assert.equal(preview.assumption.version, 1);
  assert.equal(state.assumptions.has('600941.SH'), false);

  const stock = state.stocks.get('600941.SH')!;
  assert.equal(stock.forecastDividend, 4.65);
  assert.equal(stock.assumptionVersion, 0);
  assert.equal(resolveAssumption(state, '600941.SH').version, 0);
});

test('临时预览在隔离副本中重算等级与计划，不混用旧假设', () => {
  const state = createDemoState();
  const preview = previewAssumption(state, '600941.SH', {
    forecastYear: 2026,
    scenario: 'conservative',
    requiredYield: 6,
  });

  /** 快照口径必须是预览假设，而不是缓存里的旧预测与旧门槛。 */
  assert.equal(preview.stock.forecastDividend, preview.assumption.dividendPerShare);
  assert.equal(preview.stock.buyThreshold, preview.assumption.requiredYield);
  assert.equal(preview.stock.assumptionVersion, preview.assumption.version);
  assert.equal(
    preview.stock.dividendYield,
    round((preview.assumption.dividendPerShare / preview.stock.price) * 100),
  );
  assert.equal(preview.stock.level, deriveResearchLevel(preview.stock));

  /** 质量检查随预览分红重算：分红下修后现金流覆盖必须同步变化。 */
  const cached = state.stocks.get('600941.SH')!;
  assert.notEqual(
    preview.stock.dividendQuality.freeCashFlowCoverage,
    cached.dividendQuality.freeCashFlowCoverage,
  );

  /** 档位解锁与预览等级一致，不再沿用缓存里的旧等级。 */
  const rank: Record<ResearchLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };
  for (const tier of preview.plan) {
    assert.equal(
      tier.unlocked,
      rank[preview.stock.level] >= rank[tier.level] &&
        preview.stock.riskGate.allowedLevels.includes(tier.level),
    );
  }

  /** 资金分配按预览价格阶梯计算，股数与费用也随预览价格更新。 */
  const allocation = buildAllocation(state, preview.stock, preview.plan);
  assert.deepEqual(
    allocation.tiers.map((tier) => tier.targetPrice),
    preview.plan.map((tier) => tier.targetPrice),
  );
});

test('重启后按磁盘记录恢复假设版本与研究口径', () => {
  const state = createDemoState();
  const saved = saveAssumption(state, '601088.SH', {
    forecastYear: 2028,
    scenario: 'base',
    requiredYield: 7,
  });

  const restored = createDemoState();
  hydrateAssumptions(restored, [saved]);
  const assumption = resolveAssumption(restored, '601088.SH');
  const stock = restored.stocks.get('601088.SH')!;
  assert.equal(assumption.version, saved.version);
  assert.equal(assumption.forecastYear, 2028);
  assert.equal(stock.assumptionVersion, saved.version);
  assert.equal(stock.buyThreshold, 7);
  assert.equal(stock.forecastDividend, saved.dividendPerShare);

  /** 落盘公告日期被改成伪日期时按缺失处理，不把 2026-02-31 展示出去。 */
  const tampered = createDemoState();
  hydrateAssumptions(tampered, [{ ...saved, announcementDate: '2026-02-31' }]);
  assert.equal(resolveAssumption(tampered, '601088.SH').announcementDate, null);
});

test('中/低风险未关闭时封顶L2，高风险未关闭时全部阻断', () => {
  const state = createDemoState();
  const stock = {
    ...state.stocks.get('601318.SH')!,
    price: 50,
    forecastDividend: 10,
    buyThreshold: 5,
    percentB: 0,
  };
  assert.equal(deriveResearchLevel({ ...stock, riskGate: ALLOW_L1_L2 }), 'L2');
  assert.equal(deriveResearchLevel({ ...stock, riskGate: ALLOW_ALL }), 'L3');
  assert.equal(deriveResearchLevel({ ...stock, riskGate: { allowedLevels: [] } }), 'L0');
});

test('交易拒绝非整百股、现金不足和持仓不足且失败不改状态', () => {
  const state = createDemoState();
  assert.throws(
    () => executeTrade(state, { symbol: '600941.SH', side: 'buy', shares: 50, price: 100 }),
    TradeError,
  );
  assert.throws(
    () => executeTrade(state, { symbol: '600941.SH', side: 'buy', shares: 100, price: 600 }),
    /可用现金不足/,
  );
  assert.equal(state.cash, 50_000);
  assert.equal(state.holdings.get('600941.SH')!.shares, 0);

  const portfolio = executeTrade(state, {
    symbol: '600941.SH',
    side: 'buy',
    shares: 100,
    price: 100,
  });
  /** 佣金5元 + 过户费0.1元，现金按含费金额扣减。 */
  assert.equal(portfolio.cash, 39_994.9);
  assert.equal(portfolio.trades.length, 1);
  assert.equal(portfolio.trades[0].netAmount, 10_005.1);
  assert.equal(state.holdings.get('600941.SH')!.shares, 100);
  assert.throws(
    () => executeTrade(state, { symbol: '600941.SH', side: 'sell', shares: 200, price: 100 }),
    /持仓数量不足/,
  );
  assert.equal(state.cash, 39_994.9);
  assert.equal(state.holdings.get('600941.SH')!.shares, 100);
});

test('交易校验最小价格、价格步长与舍入后成交金额，失败不改账本', () => {
  const state = createDemoState();
  /** 低于最小报价单位、非0.01整数倍以及非有限数都必须拒绝。 */
  for (const price of [0.001, 0.005, 10.005, 20.999, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => executeTrade(state, { symbol: '601318.SH', side: 'sell', shares: 100, price }),
      TradeError,
    );
  }
  assert.equal(state.cash, 50_000);
  assert.equal(state.holdings.get('601318.SH')!.shares, 2_000);
  assert.equal(state.trades.length, 0);
});

test('卖出净回款不足以覆盖费用时拒绝成交，现金与持仓不变', () => {
  const state = createDemoState();
  /** 100股 × 0.01元 = 1元成交金额，佣金最低5元，净回款为负。 */
  assert.throws(
    () => executeTrade(state, { symbol: '601318.SH', side: 'sell', shares: 100, price: 0.01 }),
    /卖出净回款不为正/,
  );
  /** 成交金额恰好等于最低佣金时净回款为零，同样不能白送持仓。 */
  assert.throws(
    () => executeTrade(state, { symbol: '601318.SH', side: 'sell', shares: 500, price: 0.01 }),
    /卖出净回款不为正/,
  );
  assert.equal(state.cash, 50_000);
  assert.equal(state.holdings.get('601318.SH')!.shares, 2_000);
  assert.equal(state.trades.length, 0);
});

test('现金或持仓变化后统一重算派生快照，资金信号与评分同步', () => {
  const state = createDemoState();
  /** 现金降到L1参考金额的一半以下，资金信号应先降级。 */
  state.cash = 1_000;
  const before = commitPortfolioChange(state).stocks.find(
    (stock) => stock.symbol === '601318.SH',
  )!;
  assert.equal(before.signals.find((signal) => signal.key === 'budget')!.status, 'neutral');

  executeTrade(state, { symbol: '601318.SH', side: 'sell', shares: 100, price: 48.6 });
  const after = commitPortfolioChange(state);
  const refreshed = after.stocks.find((stock) => stock.symbol === '601318.SH')!;
  assert.equal(refreshed.signals.find((signal) => signal.key === 'budget')!.status, 'pass');
  assert.equal(refreshed.holdingShares, 1_900);
  assert.ok(refreshed.score > before.score, '现金回补后评分必须按新账本重算');
  assert.equal(after.portfolio.cash, state.cash);
});

test('分配累计扣减同一笔预算，三档合计不超预算且含费不超剩余', () => {
  const plan: PlanTier[] = [
    { level: 'L1', name: '初步研究', targetPrice: 100, shares: 100, yieldThreshold: 0.06, estimatedAmount: 10_000, conditions: [], unlocked: true, assumptionVersion: 1 },
    { level: 'L2', name: '深入复核', targetPrice: 95, shares: 200, yieldThreshold: 0.065, estimatedAmount: 19_000, conditions: [], unlocked: true, assumptionVersion: 1 },
    { level: 'L3', name: '严格核验', targetPrice: 90, shares: 300, yieldThreshold: 0.07, estimatedAmount: 27_000, conditions: [], unlocked: true, assumptionVersion: 1 },
  ];
  const result = buildPlanAllocation({
    plan,
    budget: 50_000,
    availableCash: 60_000,
    minCashReserve: 10_000,
    totalAssets: 100_000,
    stockMarketValue: 0,
    sectorMarketValue: 0,
    sector: '银行',
    maxStockWeight: 30,
    maxSectorWeight: 50,
  });
  assert.equal(result.investableCash, 50_000);
  assert.equal(result.approvedBudget, 50_000);
  assert.ok(result.totalAllocated <= result.approvedBudget, '三档合计不得超预算');
  assert.ok(result.unallocated >= 0, '未分配剩余不得为负');
  /** 每档金额含买入费用，且累计不超过批准预算。 */
  result.tiers.forEach((tier, index) => {
    assert.ok(tier.allocatedAmount <= tier.remainingBudget + (index === 0 ? result.approvedBudget : 0));
    assert.ok(tier.cumulativeAmount <= result.approvedBudget);
  });
  assert.ok(result.totalShares >= 0);
});

test('分配按累计顺序扣减：后续档只使用前一档剩余，且参考股数仅为上限', () => {
  const plan: PlanTier[] = [
    { level: 'L1', name: '初步研究', targetPrice: 100, shares: 100, yieldThreshold: 0.06, estimatedAmount: 10_000, conditions: [], unlocked: true, assumptionVersion: 1 },
    { level: 'L2', name: '深入复核', targetPrice: 95, shares: 200, yieldThreshold: 0.065, estimatedAmount: 19_000, conditions: [], unlocked: true, assumptionVersion: 1 },
    { level: 'L3', name: '严格核验', targetPrice: 90, shares: 300, yieldThreshold: 0.07, estimatedAmount: 27_000, conditions: [], unlocked: true, assumptionVersion: 1 },
  ];
  const result = buildPlanAllocation({
    plan,
    budget: 20_000,
    availableCash: 60_000,
    minCashReserve: 10_000,
    totalAssets: 100_000,
    stockMarketValue: 0,
    sectorMarketValue: 0,
    sector: '银行',
    maxStockWeight: 100,
    maxSectorWeight: 100,
  });
  /** 预算仅 2 万，L1 参考 100 股 × 100 元 = 1 万（含费 >1万，需按含费反推）；累计不超 2 万。 */
  assert.ok(result.totalAllocated <= 20_000, '累计金额不超预算');
  /** L2 起只能使用前一档之后的剩余预算。 */
  const l1 = result.tiers[0];
  const l2 = result.tiers[1];
  assert.ok(l2.cumulativeAmount <= 20_000);
  assert.ok(l2.remainingBudget <= l1.remainingBudget, '后档剩余预算不超过前档');
  /** 无权重约束时，L3 可能因预算不足被截断，blockers 给出原因。 */
  assert.ok(result.tiers.some((tier) => tier.blockers.length > 0) || result.tiers[result.tiers.length - 1].allocatedShares === result.tiers[result.tiers.length - 1].referenceShares);
});

test('分配纳入个股与行业集中度：超限时 blockers 给出明确原因且不再买入', () => {
  const plan: PlanTier[] = [
    { level: 'L1', name: '初步研究', targetPrice: 100, shares: 100, yieldThreshold: 0.06, estimatedAmount: 10_000, conditions: [], unlocked: true, assumptionVersion: 1 },
  ];
  /** 行业市值已占 60% > 50% 上限，行业应被阻断。 */
  const sectorResult = buildPlanAllocation({
    plan,
    budget: 50_000,
    availableCash: 60_000,
    minCashReserve: 10_000,
    totalAssets: 100_000,
    stockMarketValue: 10_000,
    sectorMarketValue: 60_000,
    sector: '银行',
    maxStockWeight: 30,
    maxSectorWeight: 50,
  });
  assert.equal(sectorResult.tiers[0].allocatedShares, 0);
  assert.ok(sectorResult.tiers[0].blockers.some((b) => b.includes('行业') && b.includes('50%')));
  /** 个股市值已占 35% > 30% 上限，个股应被阻断。 */
  const stockResult = buildPlanAllocation({
    plan,
    budget: 50_000,
    availableCash: 60_000,
    minCashReserve: 10_000,
    totalAssets: 100_000,
    stockMarketValue: 35_000,
    sectorMarketValue: 35_000,
    sector: '银行',
    maxStockWeight: 30,
    maxSectorWeight: 50,
  });
  assert.equal(stockResult.tiers[0].allocatedShares, 0);
  assert.ok(stockResult.tiers[0].blockers.some((b) => b.includes('个股') && b.includes('30%')));
});

test('分配只使用已到账现金：预计分红与已宣告待收不计入可投入', () => {
  const plan: PlanTier[] = [
    { level: 'L1', name: '初步研究', targetPrice: 100, shares: 100, yieldThreshold: 0.06, estimatedAmount: 10_000, conditions: [], unlocked: true, assumptionVersion: 1 },
  ];
  /** 已到账 5 万，储备 1 万 → 可投入 4 万；预计分红 2 万不得放大可投入。 */
  const result = buildPlanAllocation({
    plan,
    budget: 60_000,
    availableCash: 50_000,
    minCashReserve: 10_000,
    totalAssets: 100_000,
    stockMarketValue: 0,
    sectorMarketValue: 0,
    sector: '银行',
    maxStockWeight: 100,
    maxSectorWeight: 100,
  });
  assert.equal(result.investableCash, 40_000);
  assert.equal(result.approvedBudget, 40_000);
  assert.ok(result.totalAllocated <= 40_000);
  assert.ok(result.notes.some((n) => n.includes('可投入现金')));
});

test('全部档位锁定时不分配任何资金：totalShares 为 0 且给出具体阻断原因', () => {
  const plan: PlanTier[] = [
    { level: 'L1', name: '初步研究', targetPrice: 100, shares: 100, yieldThreshold: 0.06, estimatedAmount: 10_000, conditions: [], unlocked: false, assumptionVersion: 1 },
    { level: 'L2', name: '深入复核', targetPrice: 95, shares: 200, yieldThreshold: 0.065, estimatedAmount: 19_000, conditions: [], unlocked: false, assumptionVersion: 1 },
    { level: 'L3', name: '严格核验', targetPrice: 90, shares: 300, yieldThreshold: 0.07, estimatedAmount: 27_000, conditions: [], unlocked: false, assumptionVersion: 1 },
  ];
  const result = buildPlanAllocation({
    plan,
    budget: 50_000,
    availableCash: 60_000,
    minCashReserve: 10_000,
    totalAssets: 100_000,
    stockMarketValue: 0,
    sectorMarketValue: 0,
    sector: '银行',
    maxStockWeight: 30,
    maxSectorWeight: 50,
    lockReasons: { L1: '风险闸门阻断L1：高风险未关闭', L2: '分红质量脆弱，封顶L1', L3: '研究条件未达到L3' },
  });

  /** 页面显示“全部阻断”时，资金计划必须同为 0，不能给出可执行买入。 */
  assert.equal(result.totalShares, 0);
  assert.equal(result.totalAllocated, 0);
  assert.equal(result.totalFees, 0);
  assert.equal(result.unallocated, result.approvedBudget, '锁定档位不得占用预算');
  result.tiers.forEach((tier) => {
    assert.equal(tier.allocatedShares, 0);
    assert.equal(tier.allocatedAmount, 0);
    assert.ok(tier.blockers.length > 0, '锁定档位必须给出阻断原因');
  });
  assert.deepEqual(
    result.tiers.map((tier) => tier.blockers[0]),
    ['风险闸门阻断L1：高风险未关闭', '分红质量脆弱，封顶L1', '研究条件未达到L3'],
  );
});

test('部分档位锁定时只对解锁档位分配，锁定档不消耗预算', () => {
  const plan: PlanTier[] = [
    { level: 'L1', name: '初步研究', targetPrice: 100, shares: 100, yieldThreshold: 0.06, estimatedAmount: 10_000, conditions: [], unlocked: true, assumptionVersion: 1 },
    { level: 'L2', name: '深入复核', targetPrice: 95, shares: 200, yieldThreshold: 0.065, estimatedAmount: 19_000, conditions: [], unlocked: false, assumptionVersion: 1 },
  ];
  const result = buildPlanAllocation({
    plan,
    budget: 50_000,
    availableCash: 60_000,
    minCashReserve: 10_000,
    totalAssets: 100_000,
    stockMarketValue: 0,
    sectorMarketValue: 0,
    sector: '银行',
    maxStockWeight: 100,
    maxSectorWeight: 100,
  });

  assert.equal(result.tiers[0].allocatedShares, 100);
  assert.equal(result.tiers[1].allocatedShares, 0);
  assert.equal(result.tiers[1].allocatedAmount, 0);
  assert.ok(result.tiers[1].blockers.length > 0, '未提供细分原因时仍有兜底说明');
  assert.equal(result.totalShares, 100);
});

test('服务端分配按真实快照返回风险、质量与研究条件 blocker，锁定档一律 0 股', () => {
  const state = createDemoState();

  /** 风险优先：高风险未关闭时全部档位锁定，blocker 指明风险闸门。 */
  const blockedStock = getStockSnapshot(state, '601088.SH');
  assert.equal(blockedStock.riskGate.highestOpenSeverity, 'high');
  const blockedAllocation = buildAllocation(
    state,
    blockedStock,
    buildResearchPlan(blockedStock, resolveAssumption(state, '601088.SH')),
  );
  assert.equal(blockedAllocation.totalShares, 0);
  blockedAllocation.tiers.forEach((tier) => {
    assert.equal(tier.allocatedShares, 0);
    assert.ok(
      tier.blockers.some((reason) => reason.includes('风险闸门阻断')),
      '高风险阻断必须说明风险原因',
    );
  });

  /** 质量封顶：该股预测分红含一次性特别分红，风险清零后仍封顶 L1。 */
  state.risks = state.risks.filter((risk) => risk.symbol !== '601088.SH');
  const qualityStock = getStockSnapshot(state, '601088.SH');
  assert.equal(qualityStock.riskGate.status, 'clear');
  assert.equal(qualityStock.dividendQuality.oneOff, true);
  const qualityAllocation = buildAllocation(
    state,
    qualityStock,
    buildResearchPlan(qualityStock, resolveAssumption(state, '601088.SH')),
  );
  ['L2', 'L3'].forEach((level) => {
    const tier = qualityAllocation.tiers.find((item) => item.level === level)!;
    assert.equal(tier.allocatedShares, 0);
    assert.ok(
      tier.blockers.some((reason) => reason.includes('分红质量') && reason.includes('封顶L1')),
      '质量不达标必须说明质量原因',
    );
  });

  /** 研究条件未达：风险全部核验通过且等级为 L0 时，仍不分配任何资金。 */
  const researchStock = getStockSnapshot(state, '601398.SH');
  assert.equal(researchStock.riskGate.status, 'verified');
  assert.equal(researchStock.level, 'L0');
  const researchAllocation = buildAllocation(
    state,
    researchStock,
    buildResearchPlan(researchStock, resolveAssumption(state, '601398.SH')),
  );
  assert.equal(researchAllocation.totalShares, 0);
  assert.equal(researchAllocation.totalAllocated, 0);
  researchAllocation.tiers.forEach((tier) => {
    assert.ok(
      tier.blockers.some((reason) => reason.includes('研究条件未达到')),
      '研究条件未满足必须说明原因',
    );
  });
});

test('质量口径与预测年度一致才算对应年度结论，否则标注基期质量参考', () => {
  const input: DividendQualityInput = {
    sector: '家用电器',
    payoutRatio: 62,
    operatingCashFlowPerShare: 7.2,
    freeCashFlowPerShare: 5.1,
    profitVolatility: 12,
    debtRatio: 62.3,
    oneOff: false,
    dataYear: 2026,
  };

  /** 口径年度与预测年度一致：按对应年度结论呈现。 */
  const matching = buildDividendQuality(input, 4, 2026);
  assert.equal(matching.basis, 'matching');
  assert.equal(matching.dataYear, 2026);
  assert.ok(!matching.notes.some((note) => note.includes('基期质量参考')));
  assert.equal(matching.checks.find((check) => check.key === 'payout')!.value, '62%（2026年报）');

  /** 预测年度后移：口径仍取自基期，必须显式标注并说明缺失组成。 */
  const base = buildDividendQuality(input, 4, 2027);
  assert.equal(base.basis, 'base');
  assert.match(base.notes[0], /基期质量参考/);
  assert.match(base.notes[0], /2026年基期数据/);
  assert.match(base.notes[0], /2027年尚缺对应 EPS、现金流与一次性分红组成/);
  assert.match(base.notes[0], /不能直接视为2027年度质量结论/);

  /** 未标注年度归属的口径同样不能冒充对应年度结论。 */
  const unknown = buildDividendQuality(
    {
      sector: '家用电器',
      payoutRatio: 62,
      operatingCashFlowPerShare: 7.2,
      freeCashFlowPerShare: 5.1,
      profitVolatility: 12,
      debtRatio: 62.3,
      oneOff: false,
    },
    4,
    2026,
  );
  assert.equal(unknown.basis, 'base');
  assert.equal(unknown.dataYear, null);
  assert.match(unknown.notes[0], /基期质量参考/);
});

test('跨年度预测的质量结论降级为基期质量参考并随口径标注', () => {
  const state = createDemoState();

  /** 基准预测年度与质量口径一致：按对应年度口径呈现，无基期标注。 */
  const baseStock = state.stocks.get('601318.SH')!;
  assert.equal(baseStock.dividendQuality.basis, 'matching');
  assert.equal(baseStock.dividendQuality.dataYear, 2026);
  assert.ok(!baseStock.dividendQuality.notes.some((note) => note.includes('基期质量参考')));

  /** 预测年度改为 2028：覆盖率虽按新预测重算，结论必须标注为基期质量参考。 */
  const preview = previewAssumption(state, '601318.SH', {
    forecastYear: 2028,
    scenario: 'base',
    requiredYield: 5.5,
  });
  const quality = preview.stock.dividendQuality;
  assert.equal(quality.basis, 'base');
  assert.equal(quality.dataYear, 2026);
  assert.match(quality.notes[0], /基期质量参考/);
  assert.match(quality.notes[0], /2028年尚缺对应 EPS、现金流与一次性分红组成/);
  assert.match(quality.checks.find((check) => check.key === 'payout')!.value, /2026年报/);

  /** 口径标注不改变既有封顶规则：等级仍由同一规则派生。 */
  assert.equal(preview.stock.level, deriveResearchLevel(preview.stock));
});

test('初始观察仓研究结论符合演示设定，快照读取不写入冷却', () => {
  const state = createDemoState();
  assert.equal(state.histories.get('601318.SH')!.length, 90);
  assert.equal(state.stocks.get('601318.SH')!.level, 'L1');
  assert.equal(state.stocks.get('600941.SH')!.level, 'L0');
  assert.equal(state.stocks.get('000333.SZ')!.level, 'L0');

  const cached = structuredClone(state.stocks.get('601318.SH')!);
  const first = getStockSnapshot(state, '601318.SH');
  const second = getStockSnapshot(state, '601318.SH');
  assert.equal(first.level, 'L1');
  assert.equal(first.action, '进入人工复核');
  assert.deepEqual(second, first);
  /** 读取路径既不改研究口径缓存，也不写入提醒冷却。 */
  assert.deepEqual(state.stocks.get('601318.SH'), cached);
  assert.equal(state.lastNotices.size, 0);
});

test('冷却只抑制重复提醒，假设或风险变化时重新评估', () => {
  const state = createDemoState();
  const stock = getStockSnapshot(state, '601318.SH');

  assert.equal(dispatchReminder(state, stock, 1_000).notify, true);
  assert.equal(dispatchReminder(state, stock, 2_000).notify, false);
  assert.equal(stock.level, 'L1');
  assert.equal(stock.action, '进入人工复核');

  saveAssumption(state, '601318.SH', {
    forecastYear: 2026,
    scenario: 'base',
    requiredYield: 5.5,
  });
  const afterAssumption = getStockSnapshot(state, '601318.SH');
  assert.equal(afterAssumption.assumptionVersion, 1);
  assert.equal(dispatchReminder(state, afterAssumption, 3_000).notify, true);

  verifyRisk(
    state,
    'risk-601318.SH',
    { note: '已核对平安公告原文与现金流覆盖', evidenceUrl: 'https://example.com/pingan/notice' },
    3_500,
  );
  const afterRisk = getStockSnapshot(state, '601318.SH', 3_500);
  assert.equal(afterRisk.riskGate.verified, true);
  assert.equal(afterRisk.riskGate.status, 'verified');
  assert.equal(dispatchReminder(state, afterRisk, 4_000).notify, true);
  assert.equal(afterRisk.action, '进入人工复核');

  const l0State = createDemoState();
  const l0Stock = getStockSnapshot(l0State, '600941.SH');
  assert.equal(dispatchReminder(l0State, l0Stock, 1_000).notify, false);
  assert.equal(l0State.lastNotices.size, 0);
});

test('除息缺口经前复权抹平，不会被当作额外超跌', () => {
  const raw: PriceBar[] = Array.from({ length: 20 }, (_, index) => {
    const close = index < 10 ? 10 : index === 10 ? 9.5 : 9.6;
    return {
      date: `2026-08-${String(index + 1).padStart(2, '0')}`,
      open: close,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 1_000_000,
    };
  });
  const adjusted = adjustForExDividend(raw, [{ exDate: raw[10].date, dividendPerShare: 0.5 }]);

  assert.equal(raw[10].close - raw[9].close, -0.5);
  assert.equal(adjusted[9].close, 9.5);
  assert.equal(adjusted[10].close, 9.5);
  assert.ok(
    calculateIndicators(adjusted).percentB > calculateIndicators(raw).percentB,
    '复权后 %B 不应被除息缺口压低',
  );
});

test('演示行情标注行情时间与前复权口径，除息日不留额外跌幅', () => {
  const state = createDemoState();
  const stock = state.stocks.get('601088.SH')!;
  assert.equal(stock.marketData.priceAdjustment, 'forward');
  assert.equal(stock.marketData.indicatorAdjustment, 'forward');
  assert.equal(stock.marketData.lastExDate, '2026-08-21');
  assert.match(stock.marketData.quoteTime, /^2026-10-23/);

  const history = state.histories.get('601088.SH')!;
  const index = history.findIndex((bar) => bar.date >= stock.marketData.lastExDate!);
  assert.ok(index > 0);
  const changePct = (history[index].close / history[index - 1].close - 1) * 100;
  assert.ok(Math.abs(changePct) < 2, `除息日涨跌幅应被抹平，实际 ${changePct}`);
});

test('每份预测都能追溯来源、报告期与假设说明', () => {
  const state = createDemoState();
  const defaultAssumption = resolveAssumption(state, '601318.SH');
  assert.equal(defaultAssumption.source, 'guidance');
  assert.ok(defaultAssumption.sourceDetail.length > 0);
  assert.equal(defaultAssumption.reportPeriod, '2025年报');
  assert.equal(defaultAssumption.announcementDate, '2026-03-21');
  assert.match(defaultAssumption.hypothesis, /2026/);

  const stock = state.stocks.get('601318.SH')!;
  assert.equal(stock.dividendForecast.source, defaultAssumption.source);
  assert.equal(stock.dividendForecast.dividendPerShare, stock.forecastDividend);
  assert.equal(stock.valuationBasis.pe, 'ttm');
  assert.equal(stock.valuationBasis.roe, 'annual');

  const saved = saveAssumption(state, '601318.SH', {
    forecastYear: 2027,
    scenario: 'conservative',
    requiredYield: 6,
  });
  assert.equal(saved.source, 'assumption');
  assert.match(saved.sourceDetail, /公司指引/);
  assert.match(saved.hypothesis, /2027/);
  assert.equal(
    state.stocks.get('601318.SH')!.dividendForecast.dividendPerShare,
    saved.dividendPerShare,
  );
});

test('一次性高分红或质量不达标时研究等级封顶L1', () => {
  const state = createDemoState();
  const base = {
    ...state.stocks.get('601318.SH')!,
    price: 50,
    forecastDividend: 10,
    buyThreshold: 5,
    percentB: 0,
    riskGate: ALLOW_ALL,
  };

  assert.equal(deriveResearchLevel(base), 'L3');
  assert.equal(deriveResearchLevel({ ...base, dividendQuality: { status: 'fragile', oneOff: false } }), 'L1');
  assert.equal(deriveResearchLevel({ ...base, dividendQuality: { status: 'sustainable', oneOff: true } }), 'L1');
});

test('分红下修同步影响雷达、计划与组合预测', () => {
  const state = createDemoState();
  const beforeStock = getStockSnapshot(state, '601318.SH');
  const beforePortfolio = getPortfolio(state);
  const beforePlan = buildResearchPlan(beforeStock, resolveAssumption(state, '601318.SH'));

  saveAssumption(state, '601318.SH', {
    forecastYear: 2026,
    scenario: 'conservative',
    requiredYield: 5.5,
  });

  const afterStock = getStockSnapshot(state, '601318.SH');
  const afterPortfolio = getPortfolio(state);
  const afterPlan = buildResearchPlan(afterStock, resolveAssumption(state, '601318.SH'));

  assert.ok(afterStock.forecastDividend < beforeStock.forecastDividend);
  assert.ok(afterStock.dividendYield < beforeStock.dividendYield);
  assert.ok(afterPortfolio.annualDividend < beforePortfolio.annualDividend);
  assert.ok((afterPlan[0].targetPrice ?? 0) < (beforePlan[0].targetPrice ?? 0));

  const position = afterPortfolio.positions.find((item) => item.symbol === '601318.SH')!;
  assert.equal(position.forecastDividend, afterStock.forecastDividend);
  assert.equal(position.forecastSource, 'assumption');
  assert.equal(position.forecastYear, 2026);
});

test('历史分红按除息日权益股数追溯：除息后买入不享有，卖出不改写', () => {
  const state = createDemoState();
  /** 平安初始持仓 2000 股；已到账除息日 2026-09-10，已宣告待收除息日 2026-10-15。 */
  const flowsOf = () =>
    getPortfolio(state).dividendFlows.filter((flow) => flow.symbol === '601318.SH');

  /** 演示行情日 2026-10-23 晚于两个除息日：买入不得追溯历史分红。 */
  executeTrade(state, { symbol: '601318.SH', side: 'buy', shares: 500, price: 48.6 });
  let received = flowsOf().find((flow) => flow.stage === 'received')!;
  let declared = flowsOf().find((flow) => flow.stage === 'declared')!;
  assert.equal(received.shares, 2000);
  assert.equal(declared.shares, 2000);
  assert.equal(received.year, 2026);
  assert.equal(declared.year, 2026);

  /** 除息后的卖出只影响当前持仓，不改写历史应收金额。 */
  executeTrade(state, { symbol: '601318.SH', side: 'sell', shares: 500, price: 48.6 });
  received = flowsOf().find((flow) => flow.stage === 'received')!;
  declared = flowsOf().find((flow) => flow.stage === 'declared')!;
  assert.equal(received.shares, 2000);
  assert.equal(declared.shares, 2000);

  /** 除息日之前成交的买入计入登记在册的权益股数。 */
  executeTrade(state, {
    symbol: '601318.SH',
    side: 'buy',
    shares: 300,
    price: 48.6,
    executedAt: '2026-09-01',
  });
  received = flowsOf().find((flow) => flow.stage === 'received')!;
  declared = flowsOf().find((flow) => flow.stage === 'declared')!;
  assert.equal(received.shares, 2300);
  assert.equal(declared.shares, 2300);
});

test('预测年度只扣除同年度已派与待派，跨年不重复抵扣同一笔分红', () => {
  const state = createDemoState();
  /** 演示行情日买入移动（2026-10-23 晚于其除息日 2026-09-18）：不追溯已到账分红。 */
  executeTrade(state, { symbol: '600941.SH', side: 'buy', shares: 200, price: 104.8 });

  /** 默认预测年度 2026：已到账 4.20 归属 2026，预计 = 4.65 − 4.20 = 0.45。 */
  const defaultFlows = getPortfolio(state).dividendFlows.filter(
    (flow) => flow.symbol === '600941.SH',
  );
  assert.equal(defaultFlows.find((flow) => flow.stage === 'received'), undefined);
  const defaultProjected = defaultFlows.find((flow) => flow.stage === 'projected')!;
  assert.equal(defaultProjected.year, 2026);
  assert.equal(defaultProjected.shares, 200);
  assert.equal(defaultProjected.dividendPerShare, 0.45);

  /** 预测年度改为 2027：2026 年的已到账分红不得跨年抵扣，预计等于完整 2027 预测。 */
  saveAssumption(state, '600941.SH', {
    forecastYear: 2027,
    scenario: 'base',
    requiredYield: 6,
  });
  const stock = state.stocks.get('600941.SH')!;
  const flows = getPortfolio(state).dividendFlows.filter((flow) => flow.symbol === '600941.SH');
  const projected = flows.find((flow) => flow.stage === 'projected')!;
  assert.equal(projected.year, 2027);
  assert.equal(projected.dividendPerShare, stock.forecastDividend);
  assert.ok(projected.dividendPerShare > defaultProjected.dividendPerShare);
});

test('未来 12 个月到账与预测年度分红分离：已到账不计入未来口径', () => {
  const state = createDemoState();
  const portfolio = getPortfolio(state);
  const flows = portfolio.dividendFlows.filter((flow) => flow.symbol === '601318.SH');

  /** 平安预测 2.85 = 同年度已派 1.90 + 待派 0.70 + 未宣告 0.25：三段流水齐备，投影段不再静默省略。 */
  const received = flows.find((flow) => flow.stage === 'received')!;
  const declared = flows.find((flow) => flow.stage === 'declared')!;
  const projected = flows.find((flow) => flow.stage === 'projected')!;
  assert.equal(received.dividendPerShare, 1.9);
  assert.equal(declared.dividendPerShare, 0.7);
  assert.equal(projected.dividendPerShare, 0.25);

  /** 未来 12 个月只含已宣告待收与归属 2026 的预计；已到账是过去的现金流，不进入未来口径。 */
  assert.equal(
    portfolio.nextTwelveMonthDividendAfterTax,
    round(declared.netAmount + projected.netAmount),
  );
  assert.ok(declared.netAmount < received.netAmount);
  assert.ok(portfolio.annualDividendAfterTax > portfolio.nextTwelveMonthDividendAfterTax);
});

test('单条核验只关闭自身，不会把同股票其他风险视为完成', () => {
  const now = Date.parse('2026-10-25T02:00:00.000Z');
  const state = createDemoState(now);

  const first = verifyRisk(
    state,
    'risk-601318.SH',
    { note: '已核对平安公告原文与派息口径', evidenceUrl: 'https://example.com/pingan/notice' },
    now,
  );
  assert.equal(first.status, 'verified');
  assert.equal(first.verification?.verifiedBy, '研究台用户');

  const added = addRiskEvent(
    state,
    {
      symbol: '601318.SH',
      title: '演示：新增中风险事项',
      type: '财务',
      severity: 'medium',
      summary: '演示：用于验证单条核验不会覆盖其他风险。',
      source: {
        publisher: '演示公告库',
        excerpt: '演示原文摘录：新增财务类风险事项。',
        publishedAt: '2026-10-25',
      },
    },
    now,
  );
  assert.equal(added.status, 'pending');

  const gate = deriveRiskGate(state.risks, '601318.SH', now);
  assert.equal(gate.totalCount, 2);
  assert.equal(gate.openCount, 1);
  assert.equal(gate.verified, false);
  assert.deepEqual(gate.allowedLevels, ['L1', 'L2']);
  assert.equal(deriveRiskEvent(state.risks[0], now).status, 'verified');
});

test('新增高风险使该股票全部旧核验失效并阻断L1–L3', () => {
  const now = Date.parse('2026-10-25T02:00:00.000Z');
  const state = createDemoState(now);
  verifyRisk(
    state,
    'risk-601318.SH',
    { note: '已核对平安公告原文与派息口径', evidenceUrl: 'https://example.com/pingan/notice' },
    now,
  );
  assert.equal(deriveRiskGate(state.risks, '601318.SH', now).verified, true);
  /** 另一只股票的核验不应被同步作废。 */
  verifyRisk(
    state,
    'risk-600941.SH',
    { note: '已核对移动公告原文与派息口径', evidenceUrl: 'https://example.com/mobile/notice' },
    now,
  );

  const added = addRiskEvent(
    state,
    {
      symbol: '601318.SH',
      title: '演示：新增监管处罚公告',
      type: '公告',
      severity: 'high',
      summary: '演示：新增高风险事项后，原核验必须重新完成。',
      source: {
        publisher: '演示公告库',
        excerpt: '演示原文摘录：新增监管处罚类高风险事项。',
        publishedAt: '2026-10-25',
      },
    },
    now,
  );
  assert.equal(added.status, 'pending');

  const original = deriveRiskEvent(state.risks[0], now);
  assert.equal(original.status, 'invalidated');
  assert.match(original.statusReason, /高风险/);

  const otherStock = state.risks.find((item) => item.symbol === '600941.SH')!;
  assert.equal(deriveRiskEvent(otherStock, now).status, 'verified');
  assert.equal(deriveRiskGate(state.risks, '600941.SH', now).verified, true);

  const gate = deriveRiskGate(state.risks, '601318.SH', now);
  assert.equal(gate.openCount, 2);
  assert.equal(gate.highestOpenSeverity, 'high');
  assert.deepEqual(gate.allowedLevels, []);
  assert.deepEqual(gate.blockedLevels, ['L1', 'L2', 'L3']);
});

test('任何核验都必须留下证据，L3放行时每条风险都能追溯到证据', () => {
  const state = createDemoState();
  assert.throws(
    () => verifyRisk(state, 'risk-601088.SH', { note: '已核对公告原文' }),
    /证据/,
  );
  assert.throws(
    () => verifyRisk(state, 'risk-601318.SH', { note: '已核对平安公告原文' }),
    /证据/,
    '中/低风险同样必须留证据，否则 L3 无法追溯',
  );

  const verified = verifyRisk(state, 'risk-601088.SH', {
    note: '已核对公告原文与一次性特别分红说明',
    evidenceUrl: 'https://example.com/notice/1',
    verifiedBy: '研究员A',
  });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.verification?.evidenceUrl, 'https://example.com/notice/1');
  assert.equal(verified.verification?.verifiedBy, '研究员A');
  assert.equal(verified.verification?.revision, verified.source.revision);
  assert.equal(verified.verification?.severity, 'high');
  assert.equal(
    Math.round(
      (Date.parse(verified.verification!.expiresAt) - Date.now()) / 86_400_000,
    ),
    RISK_POLICY.validityDays.high,
  );

  const gate = deriveRiskGate(state.risks, '601088.SH');
  assert.deepEqual(gate.allowedLevels, ['L1', 'L2', 'L3']);
  /** L3 放行时，全部风险事件都能回溯到核验人、时间、备注与证据。 */
  const events = state.risks.filter((item) => item.symbol === '601088.SH');
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(event.verification?.revision, event.source.revision);
    assert.ok((event.verification?.note.length ?? 0) >= 4);
    assert.ok((event.verification?.evidenceUrl?.length ?? 0) >= 4);
    assert.ok(event.verification?.verifiedBy);
    assert.ok(event.verification?.verifiedAt);
    assert.ok(event.verification?.expiresAt);
  }
});

test('缺少证据的核验不算通过，L3保持阻断', () => {
  const now = Date.parse('2026-10-25T02:00:00.000Z');
  const state = createDemoState(now);
  const record = state.risks.find((item) => item.symbol === '601318.SH')!;
  /** 模拟旧版本或手改文件里“只有备注、没有证据”的核验记录。 */
  record.verification = {
    verifiedAt: new Date(now).toISOString(),
    verifiedBy: '历史记录',
    note: '旧版本只留了备注，没有证据',
    evidenceUrl: null,
    revision: record.source.revision,
    severity: record.severity,
    expiresAt: new Date(
      now + RISK_POLICY.validityDays[record.severity] * 86_400_000,
    ).toISOString(),
  };

  const event = deriveRiskEvent(record, now);
  assert.equal(event.status, 'invalidated');
  assert.match(event.statusReason, /证据/);

  const gate = deriveRiskGate(state.risks, '601318.SH', now);
  assert.equal(gate.verified, false);
  assert.equal(gate.invalidatedCount, 1);
  assert.deepEqual(gate.allowedLevels, ['L1', 'L2']);
});

test('核验有效期到期后自动失效，只保留L1/L2', () => {
  const verifiedAt = Date.parse('2026-10-20T00:00:00.000Z');
  const state = createDemoState(verifiedAt);
  verifyRisk(
    state,
    'risk-601318.SH',
    { note: '已核对平安公告原文与派息口径', evidenceUrl: 'https://example.com/pingan/notice' },
    verifiedAt,
  );

  const valid = deriveRiskGate(state.risks, '601318.SH', verifiedAt + 1_000);
  assert.equal(valid.verified, true);
  assert.equal(valid.pendingCount, 0);

  const expiry = verifiedAt + RISK_POLICY.validityDays.medium * 86_400_000;
  const expired = deriveRiskGate(state.risks, '601318.SH', expiry + 1_000);
  assert.equal(expired.verified, false);
  assert.equal(expired.expiredCount, 1);
  assert.deepEqual(expired.allowedLevels, ['L1', 'L2']);
  const event = deriveRiskEvent(state.risks[0], expiry + 1_000);
  assert.equal(event.status, 'expired');
  assert.match(event.statusReason, /已过期/);
});

test('原文更新只作废本条核验，其他风险保持有效', () => {
  const now = Date.parse('2026-10-25T02:00:00.000Z');
  const state = createDemoState(now);
  verifyRisk(
    state,
    'risk-601318.SH',
    { note: '已核对平安公告原文与派息口径', evidenceUrl: 'https://example.com/pingan/notice' },
    now,
  );

  const added = addRiskEvent(
    state,
    {
      symbol: '601318.SH',
      title: '演示：新增财务类事项',
      type: '财务',
      severity: 'medium',
      summary: '演示：原文更新只应影响本条风险。',
      source: {
        publisher: '演示公告库',
        excerpt: '演示原文摘录：财务类事项。',
        publishedAt: '2026-10-25',
      },
    },
    now,
  );
  verifyRisk(
    state,
    added.id,
    { note: '已核对新增事项原文', evidenceUrl: 'https://example.com/finance/notice' },
    now,
  );
  assert.equal(deriveRiskGate(state.risks, '601318.SH', now).verified, true);

  const updated = updateRiskSource(
    state,
    'risk-601318.SH',
    { excerpt: '更新后的原文摘录：派息方案补充说明。' },
    now + 1_000,
  );
  assert.equal(updated.source.revision, 2);
  assert.equal(updated.status, 'invalidated');
  assert.match(updated.statusReason, /原文更新/);

  const gate = deriveRiskGate(state.risks, '601318.SH', now + 1_000);
  assert.equal(gate.invalidatedCount, 1);
  assert.equal(gate.openCount, 1);
  assert.deepEqual(gate.allowedLevels, ['L1', 'L2']);

  const other = state.risks.find((item) => item.id === added.id)!;
  assert.equal(deriveRiskEvent(other, now + 1_000).status, 'verified');
});

test('股票级风险状态只由风险事件派生，未登记时不伪造待核验也不阻断', () => {
  const now = Date.parse('2026-10-20T00:00:00.000Z');
  const state = createDemoState(now);
  const symbol = '601318.SH';
  state.risks = state.risks.filter((item) => item.symbol !== symbol);

  /** 未登记风险：状态为 clear，放行全部等级，页面不得再显示“L3 阻断”。 */
  const clear = deriveRiskGate(state.risks, symbol, now);
  assert.equal(clear.status, 'clear');
  assert.equal(clear.openCount, 0);
  assert.equal(clear.verified, false);
  assert.deepEqual(clear.allowedLevels, ['L1', 'L2', 'L3']);

  /** 登记中风险：状态降为 review，且等级随股票级状态一起收窄。 */
  const added = addRiskEvent(
    state,
    {
      symbol,
      title: '演示：中风险事项',
      type: '财务',
      severity: 'medium',
      summary: '演示：中风险未核验时只阻断L3。',
      source: {
        publisher: '演示公告库',
        excerpt: '演示原文摘录：中风险事项。',
        publishedAt: '2026-10-20',
      },
    },
    now,
  );
  const review = deriveRiskGate(state.risks, symbol, now);
  assert.equal(review.status, 'review');
  assert.deepEqual(review.allowedLevels, ['L1', 'L2']);
  assert.equal(getStockSnapshot(state, symbol, now).riskGate.status, 'review');

  /** 完成核验：状态、等级与研究分级同源更新，不存在“已解锁但仍待核验”。 */
  verifyRisk(
    state,
    added.id,
    { note: '已核对演示原文与派息口径', evidenceUrl: 'https://example.com/demo/notice' },
    now,
  );
  const verified = deriveRiskGate(state.risks, symbol, now);
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.allowedLevels, ['L1', 'L2', 'L3']);
  assert.equal(getStockSnapshot(state, symbol, now).riskGate.status, 'verified');

  /** 新增高风险：状态立刻回到 blocked，旧核验一并失效。 */
  addRiskEvent(
    state,
    {
      symbol,
      title: '演示：高风险事项',
      type: '公告',
      severity: 'high',
      summary: '演示：高风险登记后全部等级阻断。',
      source: {
        publisher: '演示公告库',
        excerpt: '演示原文摘录：高风险事项。',
        publishedAt: '2026-10-21',
      },
    },
    now + 1_000,
  );
  const blocked = deriveRiskGate(state.risks, symbol, now + 1_000);
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(blocked.allowedLevels, []);
});

test('executeTrade 捕获成交时的研究快照：假设、等级、风险与计划档位', () => {
  const state = createDemoState();
  saveAssumption(state, '601318.SH', {
    forecastYear: 2027,
    scenario: 'conservative',
    requiredYield: 6.5,
  });
  // 记录成交时的预期等级（保存 6.5% 假设后 601318 股息率跌破门槛，实际等级为 L0）
  const expectedLevel = getStockSnapshot(state, '601318.SH').level;
  const portfolio = executeTrade(state, {
    symbol: '601318.SH',
    side: 'buy',
    shares: 100,
    price: 40,
    planLevel: 'L1',
  });

  const trade = portfolio.trades[0];
  assert.ok(trade.researchContext, '成交必须携带研究快照');
  const context = trade.researchContext!;
  assert.equal(context.assumption.version, 1);
  assert.equal(context.assumption.forecastYear, 2027);
  assert.equal(context.assumption.requiredYield, 6.5);
  assert.equal(context.level, expectedLevel);
  assert.ok(context.dividendYield > 0);
  assert.ok(context.plan.length === 3);
  assert.equal(context.plan[0].level, 'L1');
  assert.ok(Array.isArray(context.risks), '快照应包含成交时的逐条风险');
  assert.ok(context.risks.every((risk) => typeof risk.status === 'string'));
  /** 快照冻结的是同一事实源的股票级状态，复盘不再二次推断。 */
  assert.equal(context.riskGate.status, getStockSnapshot(state, '601318.SH').riskGate.status);
  assert.equal(trade.planLevel, 'L1');
  assert.ok(trade.planTargetPrice !== null);
});

test('reviewTrades 区分按规则执行的盈利/亏损与未按规则执行', () => {
  const state = createDemoState();

  /** 合规买入：研究等级达到 L1、风险闸门放行、价格不高于目标价。 */
  const snapshot = getStockSnapshot(state, '601318.SH');
  const assumption = resolveAssumption(state, '601318.SH');
  const plan = buildResearchPlan(snapshot, assumption);
  const l1 = plan.find((tier) => tier.level === 'L1')!;
  const compliant = executeTrade(state, {
    symbol: '601318.SH',
    side: 'buy',
    shares: 100,
    price: (l1.targetPrice ?? 40) - 1,
    planLevel: 'L1',
  });
  const buyId = compliant.trades[0].id;

  /** 卖出高于买入价 → 按规则执行且盈利。 */
  executeTrade(state, {
    symbol: '601318.SH',
    side: 'sell',
    shares: 100,
    price: 60,
  });
  const review = reviewTrades(state);
  const item = review.items.find((i) => i.tradeId === buyId)!;
  assert.equal(item.ruleCompliant, true);
  assert.equal(item.classification, 'rule_compliant_profit');
  assert.ok(item.pairedSell?.fullyClosed);
  assert.ok((item.pairedSell?.pnl ?? 0) > 0);
  assert.equal(review.summary.ruleCompliantProfit, 1);
  assert.ok(review.summary.totalPnl > 0);
});

test('reviewTrades 区分按规则执行但结果亏损', () => {
  const state = createDemoState();
  const snapshot = getStockSnapshot(state, '601318.SH');
  const assumption = resolveAssumption(state, '601318.SH');
  const plan = buildResearchPlan(snapshot, assumption);
  const l1 = plan.find((tier) => tier.level === 'L1')!;

  const compliant = executeTrade(state, {
    symbol: '601318.SH',
    side: 'buy',
    shares: 100,
    price: (l1.targetPrice ?? 40) - 1,
    planLevel: 'L1',
  });
  const buyId = compliant.trades[0].id;

  /** 卖出低于买入价 → 按规则执行但亏损。 */
  executeTrade(state, { symbol: '601318.SH', side: 'sell', shares: 100, price: 30 });
  const review = reviewTrades(state);
  const item = review.items.find((i) => i.tradeId === buyId)!;
  assert.equal(item.ruleCompliant, true);
  assert.equal(item.classification, 'rule_compliant_loss');
  assert.ok((item.pairedSell?.pnl ?? 0) < 0);
  assert.equal(review.summary.ruleCompliantLoss, 1);
});

test('reviewTrades 标记未按规则执行与未平仓、无计划、无快照', () => {
  const state = createDemoState();

  /** 违规：计划档位 L3 但风险闸门不放行（未关闭风险）。 */
  const violation = executeTrade(state, {
    symbol: '601318.SH',
    side: 'buy',
    shares: 100,
    price: 40,
    planLevel: 'L3',
  });
  assert.equal(
    reviewTrades(state).items.find((i) => i.tradeId === violation.trades[0].id)!.classification,
    'rule_violation',
  );

  /** 无计划的人工记录。 */
  const noPlan = executeTrade(state, {
    symbol: '600941.SH',
    side: 'buy',
    shares: 100,
    price: 50,
  });
  assert.equal(
    reviewTrades(state).items.find((i) => i.tradeId === noPlan.trades[0].id)!.classification,
    'no_plan',
  );

  /** 无快照：模拟旧记录。 */
  const old = state.trades.find((t) => t.id === noPlan.trades[0].id)!;
  old.researchContext = null;
  assert.equal(
    reviewTrades(state).items.find((i) => i.tradeId === noPlan.trades[0].id)!.classification,
    'no_snapshot',
  );

  /** 未平仓：合规买入未卖出（601318 默认等级 L1、闸门允许 L1、L1 目标价约 51.8 ≥ 40）。 */
  const open = executeTrade(state, {
    symbol: '601318.SH',
    side: 'buy',
    shares: 100,
    price: 40,
    planLevel: 'L1',
  });
  assert.equal(
    reviewTrades(state).items.find((i) => i.tradeId === open.trades[0].id)!.classification,
    'open_position',
  );
});

test('hydratePortfolio 恢复观察仓、现金、持仓与交易账本，快照读取时叠加持仓', () => {
  const state = createDemoState();
  executeTrade(state, { symbol: '601318.SH', side: 'buy', shares: 100, price: 40 });
  executeTrade(state, { symbol: '600941.SH', side: 'buy', shares: 200, price: 50 });
  state.watchlist.delete('000333.SZ');

  const persisted = {
    watchlist: Array.from(state.watchlist),
    cash: state.cash,
    holdings: Array.from(state.holdings, ([symbol, h]) => ({
      symbol,
      shares: h.shares,
      cost: h.cost,
      assumptionVersion: h.assumptionVersion,
    })),
    trades: state.trades,
  };

  const restored = createDemoState();
  hydratePortfolio(restored, persisted);
  assert.deepEqual(Array.from(restored.watchlist), Array.from(state.watchlist));
  assert.equal(restored.cash, state.cash);
  assert.equal(restored.holdings.get('601318.SH')!.shares, 2100); // 2000 初始 + 100 买入
  assert.equal(restored.holdings.get('600941.SH')!.shares, 200);
  assert.equal(restored.trades.length, state.trades.length);
  /** 持仓是账本事实，快照读取时叠加，不在股票缓存里重复维护。 */
  assert.equal(getStockSnapshot(restored, '601318.SH').holdingShares, 2100);
  assert.equal(getStockSnapshot(restored, '600941.SH').holdingShares, 200);
  assert.equal(getStockSnapshot(restored, '000333.SZ').holdingShares, 0);
});

test('hydratePortfolio 过滤无效代码与非法交易记录，空记录保留演示初始状态', () => {
  const state = createDemoState();
  hydratePortfolio(state, {
    watchlist: ['601318.SH', 'INVALID', 123] as unknown as string[],
    cash: -100,
    holdings: [{ symbol: '601318.SH', shares: 50, cost: 10, assumptionVersion: 1 }],
    trades: [
      {
        id: 'bad',
        symbol: '601318.SH',
        name: '演示脏数据',
        side: 'hold' as unknown as 'buy',
        shares: 100,
        price: 40,
        grossAmount: 4000,
        fee: 0,
        tax: 0,
        netAmount: 4000,
        executedAt: '2026-10-01',
        taxBasis: 'pre_tax',
        assumptionVersion: 1,
        planLevel: 'L1',
        planTargetPrice: 40,
        researchContext: null,
      },
    ],
  });
  /** 无效 watchlist 项被过滤，但至少保留初始三只。 */
  assert.ok(state.watchlist.has('601318.SH'));
  assert.equal(state.watchlist.size >= 1, true);
  /** 负现金被拒绝，保持初始现金。 */
  assert.equal(state.cash, 50_000);
  /** 非法 side 被过滤，账本为空。 */
  assert.equal(state.trades.length, 0);
  /** 持仓字段由账本派生。 */
  assert.equal(getStockSnapshot(state, '601318.SH').holdingShares, 50);
  assert.equal(state.holdings.get('601318.SH')!.shares, 50);
});

test('成交日期必须是真实日历日期，非法值直接拒绝且不改动账本', () => {
  assert.equal(isIsoCalendarDate('2026-10-23'), true);
  assert.equal(isIsoCalendarDate('2024-02-29'), true);
  assert.equal(isIsoCalendarDate('2026-02-31'), false);
  assert.equal(isIsoCalendarDate('2026-13-01'), false);
  assert.equal(isIsoCalendarDate('2026-2-3'), false);
  assert.equal(isIsoCalendarDate('2026-10-23 '), false);
  assert.equal(isIsoCalendarDate(null), false);

  const state = createDemoState();
  const cashBefore = state.cash;
  const sharesBefore = state.holdings.get('601318.SH')!.shares;
  assert.throws(
    () =>
      executeTrade(state, {
        symbol: '601318.SH',
        side: 'buy',
        shares: 100,
        price: 48.6,
        executedAt: '2026-02-31',
      }),
    (error: unknown) => error instanceof TradeError,
  );
  /** 拒绝发生在记账之前：现金、持仓与账本都必须保持原样。 */
  assert.equal(state.cash, cashBefore);
  assert.equal(state.holdings.get('601318.SH')!.shares, sharesBefore);
  assert.equal(state.trades.length, 0);

  /** 缺省成交日期仍按行情日记录，这是显式缺省而不是对非法输入的替换。 */
  const traded = executeTrade(state, {
    symbol: '601318.SH',
    side: 'buy',
    shares: 100,
    price: 48.6,
  });
  assert.equal(traded.trades[0].executedAt, '2026-10-23');
});

test('记账口径影响现金影响：税前按毛额记账，税后按扣除费用与印花税的净额记账', () => {
  const preTax = createDemoState();
  executeTrade(preTax, {
    symbol: '601318.SH',
    side: 'buy',
    shares: 100,
    price: 48.6,
    taxBasis: 'pre_tax',
  });
  /** 税前口径：现金影响 = 成交金额 4860，佣金 5 + 过户费 0.05 仅展示、不进现金。 */
  assert.equal(preTax.trades[0].taxBasis, 'pre_tax');
  assert.equal(preTax.trades[0].netAmount, 4860);
  assert.equal(preTax.cash, 45_140);

  executeTrade(preTax, {
    symbol: '601318.SH',
    side: 'sell',
    shares: 100,
    price: 48.6,
    taxBasis: 'pre_tax',
  });
  assert.equal(preTax.trades[0].netAmount, 4860);
  assert.equal(preTax.cash, 50_000);

  const afterTax = createDemoState();
  executeTrade(afterTax, { symbol: '601318.SH', side: 'buy', shares: 100, price: 48.6 });
  /** 缺省为税后：买入现金影响 = 成交金额 + 佣金 5 + 过户费 0.05。 */
  assert.equal(afterTax.trades[0].taxBasis, 'after_tax');
  assert.equal(afterTax.trades[0].netAmount, 4865.05);
  assert.equal(afterTax.cash, 45_134.95);

  executeTrade(afterTax, { symbol: '601318.SH', side: 'sell', shares: 100, price: 48.6 });
  /** 卖出税后：现金影响 = 成交金额 − 佣金 5 − 过户费 0.05 − 印花税 2.43。 */
  assert.equal(afterTax.trades[0].netAmount, 4852.52);
  assert.equal(afterTax.cash, 49_987.47);
});

test('交易 id 取最大既有序号 + 1：恢复过滤后不与既有 id 撞号', () => {
  const state = createDemoState();
  const record = {
    symbol: '601318.SH',
    name: '中国平安',
    side: 'buy' as const,
    shares: 100,
    price: 40,
    grossAmount: 4000,
    fee: 0,
    tax: 0,
    netAmount: 4000,
    executedAt: '2026-10-01',
    taxBasis: 'after_tax' as const,
    assumptionVersion: 1,
    planLevel: 'L1' as const,
    planTargetPrice: 40,
    researchContext: null,
  };
  /** 账本只剩 3 条有效记录但最大序号为 4：按 length+1 生成会撞出第二个 trade-4。 */
  hydratePortfolio(state, {
    watchlist: ['601318.SH'],
    cash: 50_000,
    holdings: [],
    trades: [
      { ...record, id: 'trade-4' },
      { ...record, id: 'trade-2' },
      { ...record, id: 'trade-1' },
    ],
  });
  executeTrade(state, { symbol: '601318.SH', side: 'buy', shares: 100, price: 40 });
  const ids = state.trades.map((trade) => trade.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(state.trades[0].id, 'trade-5');
});

test('公开部署必须显式声明并配置访问令牌', () => {
  assert.equal(parsePublicDeployment('true'), true);
  assert.equal(parsePublicDeployment('TRUE'), true);
  assert.equal(parsePublicDeployment('on'), true);
  assert.equal(parsePublicDeployment('0'), false);
  assert.equal(parsePublicDeployment(undefined), false);

  /** 回环监听且未声明公开部署：允许无令牌运行（本机开发）。 */
  assert.equal(deploymentAuthError('127.0.0.1', '', false), null);
  assert.equal(deploymentAuthError('localhost', '   ', false), null);
  /** 反向代理下 HOST 仍是回环地址：声明公开部署后必须配置令牌。 */
  assert.match(deploymentAuthError('127.0.0.1', '', true) ?? '', /ACCESS_TOKEN/);
  assert.equal(deploymentAuthError('127.0.0.1', 'token', true), null);
  /** 非回环监听无论是否声明公开部署都需要令牌。 */
  assert.match(deploymentAuthError('0.0.0.0', '', false) ?? '', /ACCESS_TOKEN/);
  assert.equal(deploymentAuthError('0.0.0.0', 'token', false), null);
});

/** 真实 fqkline 事件形态：year=分红年度、perShare=每10股派息（如 10派16.2元 → 16.2）。 */
function fixtureEvent(year: string, perShare: number, exDate: string): DividendEvent {
  return { year, perShare, recordDate: exDate, exDate, content: `10派${perShare}元` };
}

test('真实分红事件按分红年度聚合：每10股换算每股、排除未完结与无效年度', () => {
  const events = [
    fixtureEvent('2024', 16.2, '2025-06-30'),
    fixtureEvent('2024', 9.3, '2024-10-18'),
    fixtureEvent('2025', 17.5, '2026-06-10'),
    fixtureEvent('2025', 9.5, '2025-10-24'),
    /** 当前日历年（2026）尚未完结（年报分红未落地），一律排除。 */
    fixtureEvent('2026', 9.8, '2026-09-10'),
    /** 非法年度与零派息事件不入账。 */
    fixtureEvent('bad', 5, '2020-01-01'),
    fixtureEvent('2023', 0, '2023-07-01'),
  ];
  const records = aggregateDividendRecords(events, 2026);
  assert.deepEqual(
    records.map((record) => [record.year, record.dividend, record.growth, record.payoutRatio]),
    [
      [2024, 2.55, 0, null],
      [2025, 2.7, 5.88, null],
    ],
  );
  /** maxYears 只保留最近 N 个完整年度。 */
  assert.deepEqual(
    aggregateDividendRecords([...events, fixtureEvent('2023', 15, '2024-07-01')], 2026, 2).map(
      (record) => record.year,
    ),
    [2024, 2025],
  );
});

test('连续分红年数从最近完整年度起回数，缺口即中断', () => {
  const consecutive = [
    fixtureEvent('2021', 10, '2022-06-20'),
    fixtureEvent('2022', 10, '2023-06-14'),
    fixtureEvent('2023', 10, '2024-07-26'),
    fixtureEvent('2024', 10, '2025-06-30'),
    fixtureEvent('2025', 10, '2026-06-10'),
  ];
  assert.equal(computeDividendStreak(consecutive, 2026), 5);
  /** 2024 缺口中断：即便 2025 有分红也从 2025 起算。 */
  const gapped = [
    fixtureEvent('2025', 10, '2026-06-10'),
    fixtureEvent('2023', 10, '2024-07-26'),
    fixtureEvent('2022', 10, '2023-06-14'),
  ];
  assert.equal(computeDividendStreak(gapped, 2026), 1);
  /** 只有当前年度事件（未完结）时无法证明任何完整年度。 */
  assert.equal(computeDividendStreak([fixtureEvent('2026', 9.8, '2026-09-10')], 2026), 0);
});

test('applyDividendHistory 替换演示口径并标注来源，无完整年度时不生效', () => {
  const state = createDemoState();
  const symbol = '601318.SH';
  const seedRecords = state.dividends.get(symbol)!;
  const now = Date.parse('2026-10-29T08:00:00.000Z');

  const applied = applyDividendHistory(
    state,
    symbol,
    [
      fixtureEvent('2024', 16.2, '2025-06-30'),
      fixtureEvent('2024', 9.3, '2024-10-18'),
      fixtureEvent('2025', 17.5, '2026-06-10'),
      fixtureEvent('2025', 9.5, '2025-10-24'),
      fixtureEvent('2026', 9.8, '2026-09-10'),
    ],
    '2026-10-29T00:54:01.774Z',
    now,
  );
  assert.equal(applied, true);
  const stock = state.stocks.get(symbol)!;
  assert.deepEqual(
    state.dividends.get(symbol)!.map((record) => [record.year, record.dividend]),
    [
      [2024, 2.55],
      [2025, 2.7],
    ],
  );
  assert.equal(stock.dividendStreak, 2);
  assert.equal(stock.dividendHistorySource, 'tencent-fqkline');
  assert.equal(stock.dividendHistorySyncedAt, '2026-10-29T00:54:01.774Z');
  /** 假设说明基于真实增速重建，投影随真实增长外推（2026 基准年不外推）。 */
  assert.match(stock.dividendForecast.hypothesis, /以每股 2\.85 元为基准/);
  assert.equal(
    projectedDividendPerShare(stock.baseDividend, state.dividends.get(symbol)!, 2027, 'base'),
    3.02,
  );

  /** 只有当前年度事件时不生效：保持种子口径与未标注状态。 */
  const untouched = createDemoState();
  assert.equal(
    applyDividendHistory(untouched, symbol, [fixtureEvent('2026', 9.8, '2026-09-10')], '2026-10-29T00:00:00.000Z', now),
    false,
  );
  assert.deepEqual(untouched.dividends.get(symbol), seedRecords);
  assert.equal(untouched.stocks.get(symbol)!.dividendHistorySource, null);
});
