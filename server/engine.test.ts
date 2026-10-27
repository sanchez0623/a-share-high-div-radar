import assert from 'node:assert/strict';
import test from 'node:test';
import type { PriceBar } from '../shared/types.ts';
import { researchPrice } from '../shared/assumptions.ts';
import {
  TradeError,
  buildResearchPlan,
  calculateIndicators,
  createDemoState,
  deriveResearchLevel,
  executeTrade,
  hydrateAssumptions,
  previewAssumption,
  refreshStock,
  resolveAssumption,
  saveAssumption,
} from './engine.ts';

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

test('布林20日与ATR14使用确定口径计算', () => {
  const result = calculateIndicators(fixtureHistory());
  assert.equal(result.ma20, 11);
  assert.equal(result.bollMiddle, 11);
  assert.equal(result.bollUpper, 13);
  assert.equal(result.bollLower, 9);
  assert.equal(result.percentB, 0.75);
  assert.equal(result.atr, 2.07);
});

test('研究价严格由预测股息除以各档收益率门槛推导', () => {
  const state = createDemoState();
  const stock = state.stocks.get('601318.SH')!;
  const assumption = resolveAssumption(state, '601318.SH');
  const plan = buildResearchPlan({ ...stock, level: 'L3', riskVerified: true }, assumption);
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
});

test('风险未核验时即使估值和超跌满足也不能升至L3', () => {
  const state = createDemoState();
  const stock = {
    ...state.stocks.get('601318.SH')!,
    price: 50,
    forecastDividend: 10,
    buyThreshold: 5,
    percentB: 0,
    riskVerified: false,
  };
  assert.equal(deriveResearchLevel(stock), 'L2');
  assert.equal(deriveResearchLevel({ ...stock, riskVerified: true }), 'L3');
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
  assert.equal(portfolio.cash, 40_000);
  assert.equal(state.holdings.get('600941.SH')!.shares, 100);
  assert.throws(
    () => executeTrade(state, { symbol: '600941.SH', side: 'sell', shares: 200, price: 100 }),
    /持仓数量不足/,
  );
  assert.equal(state.cash, 40_000);
  assert.equal(state.holdings.get('600941.SH')!.shares, 100);
});

test('初始观察仓等级与冷却期符合演示设定', () => {
  const state = createDemoState();
  assert.equal(state.histories.get('601318.SH')!.length, 90);
  assert.equal(state.stocks.get('601318.SH')!.level, 'L1');
  assert.equal(state.stocks.get('600941.SH')!.level, 'L0');
  assert.equal(state.stocks.get('000333.SZ')!.level, 'L0');

  const first = refreshStock(state, '601318.SH', 1_000);
  const second = refreshStock(state, '601318.SH', 2_000);
  assert.equal(first.action, '进入人工复核');
  assert.equal(second.level, 'L1');
  assert.equal(second.action, '继续观察');
});
