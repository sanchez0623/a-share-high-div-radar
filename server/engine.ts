import type {
  AssumptionInput,
  DividendAssumption,
  DividendRecord,
  PlanTier,
  Portfolio,
  PortfolioPosition,
  PriceBar,
  ResearchLevel,
  RiskEvent,
  Signal,
  SignalStatus,
  Stock,
  TradeRequest,
} from '../shared/types.ts';
import {
  FORECAST_BASE_YEAR,
  REQUIRE_YIELD_MAX,
  REQUIRE_YIELD_MIN,
  isDividendScenario,
  projectedDividendPerShare,
  researchPrice,
} from '../shared/assumptions.ts';

export const AS_OF = '2026-10-23';
export const DATA_NOTICE = '演示数据，不构成实时行情或投资建议';
export const ADVICE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface Holding {
  shares: number;
  cost: number;
  /** 建仓时记录的已保存假设版本，null 表示按默认假设建仓。 */
  assumptionVersion: number | null;
}

/** 已发送的提醒记录，仅用于抑制重复通知，不参与研究结论计算。 */
export interface AdviceNotice {
  level: ResearchLevel;
  /** 提醒发送时生效的假设版本；假设变化即重新评估提醒资格。 */
  assumptionVersion: number;
  /** 提醒发送时的人工风险核验状态；状态变化即重新评估提醒资格。 */
  riskVerified: boolean;
  at: number;
}

export interface ReminderDecision {
  notify: boolean;
  reason: string;
}

export interface DemoState {
  stocks: Map<string, Stock>;
  histories: Map<string, PriceBar[]>;
  dividends: Map<string, DividendRecord[]>;
  /** 已保存的分红假设，按股票代码索引；临时预览不写入这里。 */
  assumptions: Map<string, DividendAssumption>;
  risks: RiskEvent[];
  watchlist: Set<string>;
  cash: number;
  holdings: Map<string, Holding>;
  /** 提醒冷却记录：只影响提醒事件，绝不改变等级、动作与原因。 */
  lastNotices: Map<string, AdviceNotice>;
}

interface StockSeed {
  symbol: string;
  name: string;
  market: 'SH' | 'SZ';
  sector: string;
  price: number;
  forecastDividend: number;
  buyThreshold: number;
  payoutRatio: number;
  dividendStreak: number;
  pe: number;
  pb: number;
  roe: number;
  riskVerified: boolean;
  pattern: 'dip' | 'rise' | 'range';
}

export interface IndicatorResult {
  ma20: number;
  bollUpper: number;
  bollMiddle: number;
  bollLower: number;
  percentB: number;
  atr: number;
}

export class TradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TradeError';
  }
}

export class AssumptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssumptionError';
  }
}

const STOCK_SEEDS: StockSeed[] = [
  {
    symbol: '601318.SH',
    name: '中国平安',
    market: 'SH',
    sector: '保险',
    price: 48.6,
    forecastDividend: 2.85,
    buyThreshold: 5.5,
    payoutRatio: 38,
    dividendStreak: 14,
    pe: 7.8,
    pb: 0.9,
    roe: 12.6,
    riskVerified: false,
    pattern: 'dip',
  },
  {
    symbol: '600941.SH',
    name: '中国移动',
    market: 'SH',
    sector: '通信服务',
    price: 104.8,
    forecastDividend: 4.65,
    buyThreshold: 6,
    payoutRatio: 72,
    dividendStreak: 8,
    pe: 12.4,
    pb: 1.2,
    roe: 10.8,
    riskVerified: false,
    pattern: 'rise',
  },
  {
    symbol: '000333.SZ',
    name: '美的集团',
    market: 'SZ',
    sector: '家用电器',
    price: 71.6,
    forecastDividend: 4,
    buyThreshold: 6,
    payoutRatio: 62,
    dividendStreak: 11,
    pe: 13.1,
    pb: 2.5,
    roe: 20.2,
    riskVerified: false,
    pattern: 'rise',
  },
  {
    symbol: '601398.SH',
    name: '工商银行',
    market: 'SH',
    sector: '银行',
    price: 6.25,
    forecastDividend: 0.32,
    buyThreshold: 5,
    payoutRatio: 30,
    dividendStreak: 16,
    pe: 6.1,
    pb: 0.65,
    roe: 10.1,
    riskVerified: true,
    pattern: 'range',
  },
  {
    symbol: '601088.SH',
    name: '中国神华',
    market: 'SH',
    sector: '煤炭开采',
    price: 38.8,
    forecastDividend: 2.4,
    buyThreshold: 6,
    payoutRatio: 75,
    dividendStreak: 12,
    pe: 11.8,
    pb: 1.7,
    roe: 14.6,
    riskVerified: false,
    pattern: 'range',
  },
  {
    symbol: '600900.SH',
    name: '长江电力',
    market: 'SH',
    sector: '电力',
    price: 27.4,
    forecastDividend: 0.9,
    buyThreshold: 5.5,
    payoutRatio: 68,
    dividendStreak: 10,
    pe: 18.6,
    pb: 2.8,
    roe: 15.4,
    riskVerified: false,
    pattern: 'range',
  },
];

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function tradingDates(): string[] {
  const dates: string[] = [];
  let cursor = Date.parse(`${AS_OF}T00:00:00.000Z`);

  while (dates.length < 90) {
    const date = new Date(cursor);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      dates.push(date.toISOString().slice(0, 10));
    }
    cursor -= 24 * 60 * 60 * 1000;
  }

  return dates.reverse();
}

export function generateDemoHistory(seed: StockSeed): PriceBar[] {
  const dates = tradingDates();
  const numericSeed = seed.symbol
    .slice(0, 6)
    .split('')
    .reduce((total, digit) => total + Number(digit), 0);
  const closes = dates.map((_, index) => {
    const progress = index / (dates.length - 1);
    const envelope = Math.sin(Math.PI * progress);
    const wave =
      (0.012 * Math.sin(index * 0.51 + numericSeed) +
        0.006 * Math.cos(index * 0.19 + numericSeed)) *
      envelope;

    let relative = 1;
    if (seed.pattern === 'dip') {
      const recentSupport = index >= 70 ? (dates.length - 1 - index) * 0.0015 : 0;
      relative = 1.08 - 0.08 * progress + wave + recentSupport;
    } else if (seed.pattern === 'rise') {
      relative = 0.94 + 0.06 * progress + wave;
    } else {
      relative = 1 + 0.03 * Math.sin(index * 0.3 + numericSeed) * envelope;
    }
    return index === dates.length - 1 ? seed.price : round(seed.price * relative);
  });

  return dates.map((date, index) => {
    const close = closes[index];
    const previousClose = index === 0 ? close * 0.998 : closes[index - 1];
    const gap = 0.002 * Math.sin(index * 0.73 + numericSeed);
    const open = round(previousClose * (1 + gap));
    const high = round(Math.max(open, close) * (1 + 0.006 + (index % 3) * 0.001));
    const low = round(Math.min(open, close) * (1 - 0.006 - (index % 2) * 0.001));
    return {
      date,
      open,
      high,
      low,
      close,
      volume: 8_000_000 + numericSeed * 100_000 + ((index * 7919) % 4_000_000),
    };
  });
}

export function calculateIndicators(history: PriceBar[]): IndicatorResult {
  if (history.length < 20) {
    throw new Error('计算布林指标至少需要20根K线');
  }

  const recentCloses = history.slice(-20).map((bar) => bar.close);
  const middle = recentCloses.reduce((sum, close) => sum + close, 0) / 20;
  const variance =
    recentCloses.reduce((sum, close) => sum + (close - middle) ** 2, 0) / 20;
  const standardDeviation = Math.sqrt(variance);
  const upper = middle + 2 * standardDeviation;
  const lower = middle - 2 * standardDeviation;
  const latestClose = history[history.length - 1].close;
  const percentB = upper === lower ? 0.5 : (latestClose - lower) / (upper - lower);

  const trueRanges = history.slice(-14).map((bar, index) => {
    const historyIndex = history.length - 14 + index;
    if (historyIndex === 0) return bar.high - bar.low;
    const previousClose = history[historyIndex - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  });
  const atr = trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length;

  return {
    ma20: round(middle),
    bollUpper: round(upper),
    bollMiddle: round(middle),
    bollLower: round(lower),
    percentB: round(percentB, 4),
    atr: round(atr),
  };
}

export function deriveResearchLevel(
  stock: Pick<Stock, 'price' | 'forecastDividend' | 'buyThreshold' | 'percentB' | 'riskVerified'>,
): ResearchLevel {
  const currentYield = (stock.forecastDividend / stock.price) * 100;
  const tiers: Array<{
    level: Exclude<ResearchLevel, 'L0'>;
    threshold: number;
    percentB: number;
  }> = [
    { level: 'L3', threshold: stock.buyThreshold + 1, percentB: 0.05 },
    { level: 'L2', threshold: stock.buyThreshold + 0.5, percentB: 0.1 },
    { level: 'L1', threshold: stock.buyThreshold, percentB: 0.2 },
  ];

  for (const tier of tiers) {
    const valuationPass = currentYield + Number.EPSILON >= tier.threshold;
    const technicalPass = stock.percentB <= tier.percentB;
    const riskPass = tier.level !== 'L3' || stock.riskVerified;
    if (valuationPass && technicalPass && riskPass) return tier.level;
  }
  return 'L0';
}

export function buildResearchPlan(
  stock: Pick<Stock, 'level' | 'riskVerified'>,
  assumption: DividendAssumption,
): PlanTier[] {
  const levelRank: Record<ResearchLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };
  const definitions: Array<{
    level: Exclude<ResearchLevel, 'L0'>;
    name: string;
    premium: number;
    shares: number;
    percentB: number;
  }> = [
    { level: 'L1', name: '初步研究', premium: 0, shares: 100, percentB: 0.2 },
    { level: 'L2', name: '深入复核', premium: 0.5, shares: 200, percentB: 0.1 },
    { level: 'L3', name: '严格核验', premium: 1, shares: 300, percentB: 0.05 },
  ];

  return definitions.map((definition) => {
    const yieldPercent = assumption.requiredYield + definition.premium;
    const targetPrice = researchPrice(assumption.dividendPerShare, yieldPercent);
    const conditions = [
      `${assumption.forecastYear}年预测股息率达到${yieldPercent.toFixed(2)}%研究门槛`,
      `%B不高于${definition.percentB.toFixed(2)}，确认布林超跌条件`,
      definition.level === 'L3'
        ? '仅当riskVerified=true且风险事项完成人工核验后解锁'
        : '风险事项须进入人工复核，不以量化信号替代决策',
    ];

    return {
      level: definition.level,
      name: definition.name,
      yieldThreshold: yieldPercent / 100,
      targetPrice,
      shares: definition.shares,
      estimatedAmount: round(targetPrice * definition.shares),
      conditions,
      unlocked:
        levelRank[stock.level] >= levelRank[definition.level] &&
        (definition.level !== 'L3' || stock.riskVerified),
      assumptionVersion: assumption.version,
    };
  });
}

/** 校验并规范化客户端提交的假设输入。 */
export function parseAssumptionInput(body: unknown): AssumptionInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AssumptionError('请求体必须为JSON对象');
  }
  const { forecastYear, scenario, requiredYield } = body as Partial<AssumptionInput>;
  if (
    typeof forecastYear !== 'number' ||
    !Number.isInteger(forecastYear) ||
    forecastYear < 2020 ||
    forecastYear > 2035
  ) {
    throw new AssumptionError('预测年度必须在2020到2035之间');
  }
  if (!isDividendScenario(scenario)) {
    throw new AssumptionError('分红情景必须为conservative、base或optimistic');
  }
  if (
    typeof requiredYield !== 'number' ||
    !Number.isFinite(requiredYield) ||
    requiredYield < REQUIRE_YIELD_MIN ||
    requiredYield > REQUIRE_YIELD_MAX
  ) {
    throw new AssumptionError(`要求股息率必须在${REQUIRE_YIELD_MIN}到${REQUIRE_YIELD_MAX}之间`);
  }
  return { forecastYear, scenario, requiredYield };
}

function composeAssumption(
  state: DemoState,
  symbol: string,
  input: AssumptionInput,
  savedAt: number | null,
): DividendAssumption {
  const stock = state.stocks.get(symbol)!;
  const dividends = state.dividends.get(symbol) ?? [];
  return {
    symbol,
    forecastYear: input.forecastYear,
    scenario: input.scenario,
    dividendPerShare: projectedDividendPerShare(
      stock.baseDividend,
      dividends,
      input.forecastYear,
      input.scenario,
    ),
    requiredYield: input.requiredYield,
    version: (state.assumptions.get(symbol)?.version ?? 0) + 1,
    savedAt: savedAt === null ? null : new Date(savedAt).toISOString(),
  };
}

/** 当前生效的假设：已保存优先，否则回落到股票默认口径。 */
export function resolveAssumption(state: DemoState, symbol: string): DividendAssumption {
  const saved = state.assumptions.get(symbol);
  if (saved) return saved;
  const stock = state.stocks.get(symbol);
  if (!stock) throw new Error('未知股票代码');
  return {
    symbol,
    forecastYear: FORECAST_BASE_YEAR,
    scenario: 'base',
    dividendPerShare: stock.forecastDividend,
    requiredYield: stock.buyThreshold,
    version: 0,
    savedAt: null,
  };
}

/** 临时预览：按同一公式计算，但不写入状态、不递增版本。 */
export function previewAssumption(
  state: DemoState,
  symbol: string,
  input: AssumptionInput,
): { assumption: DividendAssumption; plan: PlanTier[] } {
  const stock = state.stocks.get(symbol);
  if (!stock) throw new AssumptionError('未知股票代码');
  const assumption = composeAssumption(state, symbol, input, null);
  return { assumption, plan: buildResearchPlan(stock, assumption) };
}

function applyAssumption(state: DemoState, assumption: DividendAssumption): void {
  state.assumptions.set(assumption.symbol, assumption);
  const stock = state.stocks.get(assumption.symbol);
  if (!stock) return;
  state.stocks.set(assumption.symbol, {
    ...stock,
    forecastDividend: assumption.dividendPerShare,
    buyThreshold: assumption.requiredYield,
    assumptionVersion: assumption.version,
  });
}

/** 保存正式假设：同步写回股票的研究口径，返回新版本。 */
export function saveAssumption(
  state: DemoState,
  symbol: string,
  input: AssumptionInput,
  now = Date.now(),
): DividendAssumption {
  if (!state.stocks.has(symbol)) throw new AssumptionError('未知股票代码');
  const assumption = composeAssumption(state, symbol, input, now);
  applyAssumption(state, assumption);
  return assumption;
}

/** 服务启动时恢复已持久化的假设，保证重启后口径不变。 */
export function hydrateAssumptions(state: DemoState, records: DividendAssumption[]): void {
  for (const record of records) {
    if (!record || typeof record.symbol !== 'string' || !state.stocks.has(record.symbol)) continue;
    if (!isDividendScenario(record.scenario)) continue;
    if (!Number.isFinite(record.dividendPerShare) || record.dividendPerShare <= 0) continue;
    if (
      !Number.isFinite(record.requiredYield) ||
      record.requiredYield < REQUIRE_YIELD_MIN ||
      record.requiredYield > REQUIRE_YIELD_MAX
    ) {
      continue;
    }
    if (!Number.isInteger(record.version) || record.version <= 0) continue;

    state.assumptions.set(record.symbol, record);
    const stock = state.stocks.get(record.symbol)!;
    stock.forecastDividend = record.dividendPerShare;
    stock.buyThreshold = record.requiredYield;
    stock.assumptionVersion = record.version;
  }
}

function buildSignals(
  stock: Stock,
  indicators: IndicatorResult,
  dividendYield: number,
  availableCash: number,
): Signal[] {
  const l1Amount = (stock.forecastDividend / (stock.buyThreshold / 100)) * 100;
  const valuationStatus: SignalStatus =
    dividendYield >= stock.buyThreshold
      ? 'pass'
      : dividendYield >= stock.buyThreshold - 0.5
        ? 'watch'
        : 'neutral';
  const technicalStatus: SignalStatus =
    indicators.percentB <= 0.2 ? 'pass' : indicators.percentB <= 0.5 ? 'watch' : 'neutral';
  const trendStatus: SignalStatus =
    stock.price >= indicators.ma20
      ? 'pass'
      : stock.price >= indicators.bollMiddle * 0.98
        ? 'watch'
        : 'neutral';
  const budgetStatus: SignalStatus =
    availableCash >= l1Amount ? 'pass' : availableCash >= l1Amount / 2 ? 'watch' : 'neutral';

  return [
    {
      key: 'valuation',
      label: '股息估值',
      status: valuationStatus,
      value: `${dividendYield.toFixed(2)}% / ${stock.buyThreshold.toFixed(2)}%`,
      description: '预测股息率与个性化研究门槛独立比较。',
    },
    {
      key: 'technical',
      label: '布林超跌',
      status: technicalStatus,
      value: `%B ${indicators.percentB.toFixed(2)}`,
      description: '观察收盘价在20日布林通道中的相对位置。',
    },
    {
      key: 'trend',
      label: '趋势',
      status: trendStatus,
      value: `MA20 ${indicators.ma20.toFixed(2)}`,
      description: '趋势信号与估值、超跌信号分开计分。',
    },
    {
      key: 'risk',
      label: '事件风险',
      status: stock.riskVerified ? 'pass' : 'watch',
      value: stock.riskVerified ? '已人工核验' : '待人工核验',
      description: '风险核验是独立信号，L3必须完成人工复核。',
    },
    {
      key: 'budget',
      label: '资金仓位',
      status: budgetStatus,
      value: `可用现金 ${availableCash.toFixed(2)}`,
      description: '按L1参考股数检查演示资金是否充足。',
    },
  ];
}

function scoreSignals(signals: Signal[]): number {
  const weights = [30, 25, 15, 15, 15];
  const factors: Record<SignalStatus, number> = {
    pass: 1,
    watch: 0.6,
    neutral: 0.3,
    block: 0,
  };
  const score = signals.reduce(
    (total, signal, index) => total + weights[index] * factors[signal.status],
    0,
  );
  return round(Math.max(0, Math.min(100, score)));
}

function researchAction(stock: Stock): Pick<Stock, 'action' | 'summary'> {
  if (stock.level === 'L0') {
    const valuationPass = stock.dividendYield >= stock.buyThreshold;
    return {
      action: valuationPass ? '继续观察' : '等待更深价格',
      summary: valuationPass
        ? '演示估值门槛已达，但布林超跌条件不足，继续观察。'
        : '演示预测股息率未达L1门槛，等待更深价格。',
    };
  }

  return {
    action: '进入人工复核',
    summary: stock.riskVerified
      ? `达到${stock.level}估值与超跌研究条件，仍需结合公告和组合约束人工复核。`
      : `达到${stock.level}估值与超跌研究条件，风险事项尚待人工核验。`,
  };
}

export function analyzeStock(stock: Stock, history: PriceBar[], availableCash: number): Stock {
  const indicators = calculateIndicators(history);
  const price = history[history.length - 1].close;
  const dividendYield = round((stock.forecastDividend / price) * 100);
  const withMarketData = {
    ...stock,
    price,
    dividendYield,
    ...indicators,
  };
  const level = deriveResearchLevel(withMarketData);
  const leveled = { ...withMarketData, level };
  const signals = buildSignals(leveled, indicators, dividendYield, availableCash);
  const action = researchAction(leveled);

  return {
    ...leveled,
    ...action,
    score: scoreSignals(signals),
    signals,
    sparkline: history.slice(-30).map((bar) => bar.close),
  };
}

function buildDividendHistory(seed: StockSeed): DividendRecord[] {
  let previousDividend: number | null = null;
  return [2021, 2022, 2023, 2024, 2025].map((year, index) => {
    const dividend = round(seed.forecastDividend * (0.78 + index * 0.055));
    const growth = previousDividend === null ? 0 : round((dividend / previousDividend - 1) * 100);
    previousDividend = dividend;
    return {
      year,
      dividend,
      payoutRatio: round(seed.payoutRatio + (index - 2) * 0.6),
      growth,
    };
  });
}

function buildRiskEvents(): RiskEvent[] {
  return STOCK_SEEDS.map((seed, index) => ({
    id: `risk-${seed.symbol}`,
    symbol: seed.symbol,
    title: `${seed.name}演示风险事项`,
    type: (['公告', '财务', '行业', '数据'] as const)[index % 4],
    severity: (['medium', 'low', 'medium', 'low', 'high', 'low'] as const)[index],
    date: `2026-10-${String(18 + (index % 4)).padStart(2, '0')}`,
    status: seed.riskVerified ? 'acknowledged' : 'pending',
    summary: '仅用于演示人工风险复核流程，不对应真实公告或实时事件。',
  }));
}

export function createDemoState(): DemoState {
  const state: DemoState = {
    stocks: new Map(),
    histories: new Map(),
    dividends: new Map(),
    assumptions: new Map(),
    risks: buildRiskEvents(),
    watchlist: new Set(['601318.SH', '600941.SH', '000333.SZ']),
    cash: 50_000,
    holdings: new Map([
      ['601318.SH', { shares: 2000, cost: 48.2, assumptionVersion: null }],
      ...STOCK_SEEDS.filter((seed) => seed.symbol !== '601318.SH').map(
        (seed) => [seed.symbol, { shares: 0, cost: 0, assumptionVersion: null }] as const,
      ),
    ]),
    lastAdvices: new Map(),
  };

  for (const seed of STOCK_SEEDS) {
    const history = generateDemoHistory(seed);
    const holding = state.holdings.get(seed.symbol)!;
    const previousClose = history[history.length - 2].close;
    const changePct = round((seed.price / previousClose - 1) * 100);
    const initial: Stock = {
      symbol: seed.symbol,
      name: seed.name,
      market: seed.market,
      sector: seed.sector,
      price: seed.price,
      changePct,
      baseDividend: seed.forecastDividend,
      forecastDividend: seed.forecastDividend,
      dividendYield: 0,
      buyThreshold: seed.buyThreshold,
      assumptionVersion: 0,
      payoutRatio: seed.payoutRatio,
      dividendStreak: seed.dividendStreak,
      pe: seed.pe,
      pb: seed.pb,
      roe: seed.roe,
      holdingShares: holding.shares,
      holdingCost: holding.cost,
      updatedAt: AS_OF,
      dataMode: 'demo',
      score: 0,
      level: 'L0',
      action: '继续观察',
      summary: '',
      percentB: 0,
      bollUpper: 0,
      bollMiddle: 0,
      bollLower: 0,
      atr: 0,
      ma20: 0,
      signals: [],
      sparkline: [],
      riskVerified: seed.riskVerified,
    };
    state.histories.set(seed.symbol, history);
    state.dividends.set(seed.symbol, buildDividendHistory(seed));
    state.stocks.set(seed.symbol, analyzeStock(initial, history, state.cash));
  }

  return state;
}

export function refreshStock(state: DemoState, symbol: string, now = Date.now()): Stock {
  const current = state.stocks.get(symbol);
  const history = state.histories.get(symbol);
  if (!current || !history) throw new Error('未知股票代码');

  const analyzed = analyzeStock(current, history, state.cash);
  if (analyzed.level === 'L0') {
    state.lastAdvices.delete(symbol);
  } else {
    const previous = state.lastAdvices.get(symbol);
    const inCooldown =
      previous?.level === analyzed.level &&
      now >= previous.at &&
      now - previous.at < ADVICE_COOLDOWN_MS;
    if (inCooldown) {
      analyzed.action = '继续观察';
      analyzed.summary = `${analyzed.level}研究信号处于24小时冷却期，暂不重复提示，等待价格或风险状态变化。`;
    } else {
      state.lastAdvices.set(symbol, { level: analyzed.level, at: now });
    }
  }

  state.stocks.set(symbol, analyzed);
  return analyzed;
}

export function getPortfolio(state: DemoState): Portfolio {
  const positions: PortfolioPosition[] = [];
  let marketValue = 0;
  let annualDividend = 0;

  for (const [symbol, holding] of state.holdings) {
    if (holding.shares === 0) continue;
    const stock = state.stocks.get(symbol)!;
    const positionMarketValue = round(holding.shares * stock.price);
    const positionDividend = round(holding.shares * stock.forecastDividend);
    marketValue += positionMarketValue;
    annualDividend += positionDividend;
    positions.push({
      symbol,
      name: stock.name,
      shares: holding.shares,
      cost: holding.cost,
      price: stock.price,
      marketValue: positionMarketValue,
      weight: 0,
      yieldOnCost: holding.cost > 0 ? round((stock.forecastDividend / holding.cost) * 100) : 0,
      annualDividend: positionDividend,
      assumptionVersion: holding.assumptionVersion,
    });
  }

  marketValue = round(marketValue);
  annualDividend = round(annualDividend);
  const totalAssets = round(state.cash + marketValue);
  for (const position of positions) {
    position.weight = totalAssets > 0 ? round((position.marketValue / totalAssets) * 100) : 0;
  }

  return {
    cash: round(state.cash),
    marketValue,
    totalAssets,
    annualDividend,
    portfolioYield: totalAssets > 0 ? round((annualDividend / totalAssets) * 100) : 0,
    positions,
  };
}

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
  if (!Number.isFinite(request.price) || request.price <= 0) {
    throw new TradeError('交易价格必须为正数');
  }

  const holding = state.holdings.get(request.symbol)!;
  const amount = round(request.shares * request.price);
  if (request.side === 'buy') {
    if (amount > state.cash + Number.EPSILON) {
      throw new TradeError('可用现金不足，交易未执行');
    }
    const newShares = holding.shares + request.shares;
    const newCost =
      (holding.shares * holding.cost + request.shares * request.price) / newShares;
    holding.shares = newShares;
    holding.cost = round(newCost, 4);
    holding.assumptionVersion = state.assumptions.get(request.symbol)?.version ?? null;
    state.cash = round(state.cash - amount);
  } else {
    if (request.shares > holding.shares) {
      throw new TradeError('持仓数量不足，交易未执行');
    }
    holding.shares -= request.shares;
    if (holding.shares === 0) holding.cost = 0;
    state.cash = round(state.cash + amount);
  }

  const stock = state.stocks.get(request.symbol)!;
  stock.holdingShares = holding.shares;
  stock.holdingCost = holding.cost;
  return getPortfolio(state);
}
