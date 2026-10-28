import type {
  AssumptionInput,
  ComplianceCheck,
  DataMeta,
  DividendAssumption,
  DividendFlow,
  DividendForecast,
  DividendPayment,
  DividendQuality,
  DividendQualityCheck,
  DividendQualityStatus,
  DividendRecord,
  DividendStage,
  ForecastSource,
  PersistedHolding,
  PersistedPortfolio,
  PlanAllocation,
  PlanTier,
  Portfolio,
  PortfolioPosition,
  PriceBar,
  ResearchLevel,
  RiskEvent,
  RiskEventInput,
  RiskEventRecord,
  RiskGate,
  RiskPolicy,
  RiskSeverity,
  RiskSourcePatch,
  RiskType,
  RiskVerification,
  RiskVerificationInput,
  RiskVerificationStatus,
  Signal,
  SignalKey,
  SignalStatus,
  StatBasis,
  Stock,
  TaxBasis,
  TradeClassification,
  TradePairedSell,
  TradeRecord,
  TradeResearchSnapshot,
  TradeRequest,
  TradeReviewItem,
  TradeReviewResponse,
  TradeReviewSummary,
} from '../shared/types.ts';
import {
  FORECAST_BASE_YEAR,
  REQUIRE_YIELD_MAX,
  REQUIRE_YIELD_MIN,
  adjustForExDividend,
  buildForecastHypothesis,
  dividendQualityLabel,
  forecastSourceLabel,
  isDividendScenario,
  isForecastSource,
  projectedDividendPerShare,
  researchPrice,
} from '../shared/assumptions.ts';
import {
  DEFAULT_MAX_SECTOR_WEIGHT,
  DEFAULT_MAX_STOCK_WEIGHT,
  MIN_CASH_RESERVE_RATIO,
  buildPlanAllocation,
} from '../shared/allocation.ts';
import { DIVIDEND_TAX_RATE, estimateTradeFees } from '../shared/costs.ts';

export const AS_OF = '2026-10-23';
export const DATA_NOTICE =
  '演示数据，不构成实时行情或投资建议；行情为前复权收盘价，PE 为 TTM、ROE 为年报口径';
export const ADVICE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** 行情时间、复权方式与估值口径；真实数据接入后必须由数据源覆盖。 */
export const DATA_META: DataMeta = {
  dataMode: 'demo',
  quoteTime: `${AS_OF} 15:00`,
  priceAdjustment: 'forward',
  indicatorAdjustment: 'forward',
  peBasis: 'ttm',
  roeBasis: 'annual',
  note: '技术指标基于前复权收盘价，除息缺口已抹平；PE 为 TTM、ROE 为年报口径。',
};

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
  /** 提醒发送时的股票级风险签名；任一条风险状态变化即重新评估。 */
  riskSignature: string;
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
  /** 风险事项的原文与核验记录；核验状态一律派生，不存储。 */
  risks: RiskEventRecord[];
  watchlist: Set<string>;
  cash: number;
  holdings: Map<string, Holding>;
  /** 提醒冷却记录：只影响提醒事件，绝不改变等级、动作与原因。 */
  lastNotices: Map<string, AdviceNotice>;
  /** 模拟交易账本，最新一笔在前。 */
  trades: TradeRecord[];
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
  /** 演示种子：是否预置一条已完成的核验记录。 */
  riskVerified: boolean;
  pattern: 'dip' | 'rise' | 'range';
  /** 原始预测来源、公告日期与报告期。 */
  forecast: Pick<
    DividendForecast,
    'source' | 'sourceDetail' | 'announcementDate' | 'reportPeriod'
  >;
  /** 质量检查所需的现金流、利润波动与杠杆数据。 */
  quality: {
    operatingCashFlowPerShare: number;
    freeCashFlowPerShare: number;
    profitVolatility: number;
    debtRatio: number;
    oneOff: boolean;
    oneOffNote?: string;
  };
  /** 区间内除息事件，用于前复权与除息说明。 */
  exDividend: DividendPayment;
  /** 已宣告但尚未派息的分红；null 表示无待收。 */
  pendingDividend: DividendPayment | null;
  valuationBasis: { pe: StatBasis; roe: StatBasis };
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

export class RiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskError';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RISK_SEVERITIES: readonly RiskSeverity[] = ['high', 'medium', 'low'];
const RISK_TYPES: readonly RiskType[] = ['公告', '财务', '行业', '数据'];
/** 严重度排序：数字越小越严重。 */
const SEVERITY_RANK: Record<RiskSeverity, number> = { high: 0, medium: 1, low: 2 };
const ALL_LEVELS: ResearchLevel[] = ['L1', 'L2', 'L3'];

/**
 * 风险政策：核验有效期与“严重度 × L1–L3”阻断矩阵的唯一公开口径。
 * 高风险未关闭时全部等级阻断；仅中/低风险未关闭时阻断 L3；全部有效核验才解锁 L3。
 */
export const RISK_POLICY: RiskPolicy = {
  validityDays: { high: 7, medium: 14, low: 30 },
  rules: [
    {
      condition: '全部风险事件在有效期内完成核验',
      allowedLevels: [...ALL_LEVELS],
    },
    {
      condition: '仅中/低风险未关闭（无高风险未关闭）',
      allowedLevels: ['L1', 'L2'],
    },
    {
      condition: '存在未关闭的高风险事项',
      allowedLevels: [],
    },
  ],
  note: '风险闸门只下调研究等级上限，不产生任何自动交易；每次核验必须留下备注与证据，核验有效期按严重度分别为高7天、中14天、低30天。',
};

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
    forecast: {
      source: 'guidance',
      sourceDetail: '公司2026年分红指引：派息率不低于35%，以2025年报每股派息2.85元测算',
      announcementDate: '2026-03-21',
      reportPeriod: '2025年报',
    },
    quality: {
      operatingCashFlowPerShare: 9.2,
      freeCashFlowPerShare: 5.4,
      profitVolatility: 26,
      debtRatio: 91.4,
      oneOff: false,
    },
    exDividend: { exDate: '2026-09-10', payDate: '2026-10-16', dividendPerShare: 2.55 },
    pendingDividend: { exDate: '2026-10-15', payDate: '2026-11-20', dividendPerShare: 0.95 },
    valuationBasis: { pe: 'ttm', roe: 'annual' },
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
    forecast: {
      source: 'announced',
      sourceDetail: '2025年报已宣告每股派息4.65元（含税）',
      announcementDate: '2026-03-20',
      reportPeriod: '2025年报',
    },
    quality: {
      operatingCashFlowPerShare: 11.8,
      freeCashFlowPerShare: 6.4,
      profitVolatility: 8,
      debtRatio: 35.2,
      oneOff: false,
    },
    exDividend: { exDate: '2026-09-18', payDate: '2026-10-16', dividendPerShare: 4.2 },
    pendingDividend: null,
    valuationBasis: { pe: 'ttm', roe: 'annual' },
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
    forecast: {
      source: 'announced',
      sourceDetail: '2025年报已宣告每股派息4.00元（含税）',
      announcementDate: '2026-03-28',
      reportPeriod: '2025年报',
    },
    quality: {
      operatingCashFlowPerShare: 7.2,
      freeCashFlowPerShare: 5.1,
      profitVolatility: 12,
      debtRatio: 62.3,
      oneOff: false,
    },
    exDividend: { exDate: '2026-09-04', payDate: '2026-09-25', dividendPerShare: 3.6 },
    pendingDividend: null,
    valuationBasis: { pe: 'ttm', roe: 'annual' },
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
    forecast: {
      source: 'announced',
      sourceDetail: '2025年报已宣告每股派息0.32元（含税），含中期已派部分',
      announcementDate: '2026-03-27',
      reportPeriod: '2025年报',
    },
    quality: {
      operatingCashFlowPerShare: 1.85,
      freeCashFlowPerShare: 1.2,
      profitVolatility: 6,
      debtRatio: 91.6,
      oneOff: false,
    },
    exDividend: { exDate: '2026-07-10', payDate: '2026-08-14', dividendPerShare: 0.29 },
    pendingDividend: null,
    valuationBasis: { pe: 'ttm', roe: 'annual' },
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
    forecast: {
      source: 'extrapolation',
      sourceDetail: '按近五年分红均值外推，2025年含一次性特别分红1.20元/股',
      announcementDate: null,
      reportPeriod: '2025年报',
    },
    quality: {
      operatingCashFlowPerShare: 3.1,
      freeCashFlowPerShare: 1.9,
      profitVolatility: 38,
      debtRatio: 38.4,
      oneOff: true,
      oneOffNote: '预测分红包含一次性特别分红1.20元/股，不可线性外推，研究等级封顶L1',
    },
    exDividend: { exDate: '2026-08-21', payDate: '2026-09-12', dividendPerShare: 2.1 },
    pendingDividend: null,
    valuationBasis: { pe: 'ttm', roe: 'annual' },
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
    forecast: {
      source: 'extrapolation',
      sourceDetail: '按近五年稳定分红与资本开支计划外推',
      announcementDate: null,
      reportPeriod: '2025年报',
    },
    quality: {
      operatingCashFlowPerShare: 1.78,
      freeCashFlowPerShare: 1.0,
      profitVolatility: 9,
      debtRatio: 58.2,
      oneOff: false,
    },
    exDividend: { exDate: '2026-06-26', payDate: '2026-07-18', dividendPerShare: 0.82 },
    pendingDividend: null,
    valuationBasis: { pe: 'ttm', roe: 'annual' },
  },
];

const STOCK_SEED_MAP = new Map(STOCK_SEEDS.map((seed) => [seed.symbol, seed]));

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** 五道量化闸门之外，分红质量单独计分，避免高股息由一次性或不可持续分红堆出。 */
const SIGNAL_WEIGHTS: Record<SignalKey, number> = {
  valuation: 25,
  dividend: 20,
  technical: 20,
  trend: 10,
  risk: 15,
  budget: 10,
};

/** 金融行业杠杆天然偏高，按行业口径放宽负债率阈值。 */
const FINANCIAL_SECTORS = new Set(['银行', '保险']);

/** 派息率、现金流覆盖、利润波动与杠杆质量共同决定分红是否可持续。 */
function buildDividendQuality(seed: StockSeed, dividendPerShare: number): DividendQuality {
  const payoutRatio = seed.payoutRatio;
  const operatingCoverage =
    dividendPerShare > 0 ? seed.quality.operatingCashFlowPerShare / dividendPerShare : 0;
  const freeCoverage =
    dividendPerShare > 0 ? seed.quality.freeCashFlowPerShare / dividendPerShare : 0;
  const profitVolatility = seed.quality.profitVolatility;
  const leverage = seed.quality.debtRatio;
  const financial = FINANCIAL_SECTORS.has(seed.sector);
  const leveragePass = financial ? 94 : 65;
  const leverageWatch = financial ? 96 : 80;

  const checks: DividendQualityCheck[] = [
    {
      key: 'payout',
      label: '派息率',
      status: payoutRatio <= 70 ? 'pass' : payoutRatio <= 90 ? 'watch' : 'block',
      value: `${payoutRatio.toFixed(0)}%（年报）`,
      detail:
        payoutRatio <= 70
          ? '派息率处于可持续区间'
          : payoutRatio <= 90
            ? '派息率偏高，需要现金流覆盖配合'
            : '派息率超过90%，分红空间有限',
    },
    {
      key: 'cashflow',
      label: '现金流覆盖',
      status: freeCoverage >= 1.2 && operatingCoverage >= 1.5 ? 'pass' : freeCoverage >= 1 && operatingCoverage >= 1.2 ? 'watch' : 'block',
      value: `经营 ${round(operatingCoverage)}× / 自由 ${round(freeCoverage)}×`,
      detail: '经营与自由现金流对年度分红总额的覆盖倍数，低于 1 倍视为不可持续',
    },
    {
      key: 'volatility',
      label: '利润波动',
      status: profitVolatility <= 20 ? 'pass' : profitVolatility <= 40 ? 'watch' : 'block',
      value: `±${profitVolatility.toFixed(0)}%`,
      detail: '近五年净利润同比波动，波动越大分红越容易被下修',
    },
    {
      key: 'leverage',
      label: '杠杆质量',
      status: leverage <= leveragePass ? 'pass' : leverage <= leverageWatch ? 'watch' : 'block',
      value: `资产负债率 ${leverage.toFixed(0)}%`,
      detail: financial
        ? '金融行业按行业口径放宽负债率阈值'
        : '非金融企业负债率越高，分红可持续性越弱',
    },
  ];

  const blocked = checks.some((check) => check.status === 'block');
  const watched = checks.some((check) => check.status === 'watch') || seed.quality.oneOff;
  const status: DividendQualityStatus = blocked ? 'fragile' : watched ? 'watch' : 'sustainable';

  const notes: string[] = [];
  if (seed.quality.oneOff) {
    notes.push(seed.quality.oneOffNote ?? '预测分红包含一次性特别分红，不可线性外推');
  }
  if (blocked) {
    notes.push('至少一项质量检查未通过，研究等级封顶为L1');
  } else if (watched) {
    notes.push('存在需人工复核的质量项，分红可持续性尚不能视为通过');
  }

  return {
    status,
    payoutRatio,
    operatingCashFlowCoverage: round(operatingCoverage),
    freeCashFlowCoverage: round(freeCoverage),
    profitVolatility,
    leverage,
    oneOff: seed.quality.oneOff,
    checks,
    notes,
  };
}

function scaleBar(bar: PriceBar, factor: number): PriceBar {
  const open = round(bar.open * factor);
  const close = round(bar.close * factor);
  return {
    ...bar,
    open,
    close,
    high: round(Math.max(open, close, bar.high * factor)),
    low: round(Math.min(open, close, bar.low * factor)),
  };
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

/**
 * 演示行情先还原成“含权”序列（除息日前价格包含即将派发的股息），
 * 再统一做前复权，保证除息日的价格回落不会进入技术指标与涨跌幅。
 */
function buildMarketHistory(seed: StockSeed): PriceBar[] {
  const smooth = generateDemoHistory(seed);
  const { exDate, dividendPerShare } = seed.exDividend;
  if (!(dividendPerShare > 0)) return smooth;

  const index = smooth.findIndex((bar) => bar.date >= exDate);
  if (index <= 0) return smooth;
  const exClose = smooth[index].close;
  if (!(exClose > 0)) return smooth;

  const cumRatio = (exClose + dividendPerShare) / exClose;
  const cumDividendBars = smooth.map((bar, position) =>
    position < index ? scaleBar(bar, cumRatio) : bar,
  );
  return adjustForExDividend(cumDividendBars, [seed.exDividend]);
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
  stock: Pick<
    Stock,
    'price' | 'forecastDividend' | 'buyThreshold' | 'percentB'
  > & {
    riskGate: Pick<RiskGate, 'allowedLevels'>;
    dividendQuality?: Pick<DividendQuality, 'status' | 'oneOff'>;
  },
): ResearchLevel {
  const currentYield = (stock.forecastDividend / stock.price) * 100;
  /** 质量不达标或含一次性分红时，高股息不能支撑高等级研究结论。 */
  const qualityCapped = Boolean(
    stock.dividendQuality &&
      (stock.dividendQuality.status === 'fragile' || stock.dividendQuality.oneOff),
  );
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
    if (qualityCapped && tier.level !== 'L1') continue;
    const valuationPass = currentYield + Number.EPSILON >= tier.threshold;
    const technicalPass = stock.percentB <= tier.percentB;
    /** 风险阻断来自股票级闸门，由全部风险事件派生。 */
    const riskPass = stock.riskGate.allowedLevels.includes(tier.level);
    if (valuationPass && technicalPass && riskPass) return tier.level;
  }
  return 'L0';
}

export function buildResearchPlan(
  stock: Pick<Stock, 'level'> & { riskGate: Pick<RiskGate, 'allowedLevels'> },
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
        ? '仅当全部风险事件都在有效期内完成核验后解锁（高风险7天、中14天、低30天）'
        : '存在未关闭的高风险事项时，L1/L2同样阻断',
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
        stock.riskGate.allowedLevels.includes(definition.level),
      assumptionVersion: assumption.version,
    };
  });
}

/**
 * 派生单条风险的核验状态。
 * 原文版本不一致、被后续事件作废或超过有效期，都不算通过。
 */
export function deriveRiskEvent(record: RiskEventRecord, now = Date.now()): RiskEvent {
  const verification = record.verification;
  let status: RiskVerificationStatus = 'pending';
  let statusReason = '尚未完成人工核验，原文与来源仍需人工确认';

  if (verification) {
    const verifiedAt = Date.parse(verification.verifiedAt);
    const invalidatedAt = record.invalidatedAt ? Date.parse(record.invalidatedAt) : null;
    const expiresAt = Date.parse(verification.expiresAt);
    if (invalidatedAt !== null && Number.isFinite(verifiedAt) && invalidatedAt >= verifiedAt) {
      status = 'invalidated';
      statusReason = record.invalidatedReason ?? '核验已被后续事件作废，需重新核验';
    } else if (verification.revision !== record.source.revision) {
      status = 'invalidated';
      statusReason = `原文已更新至 v${record.source.revision}，原核验基于 v${verification.revision}`;
    } else if (!verification.evidenceUrl || verification.evidenceUrl.trim().length < 4) {
      /** 旧记录或手改文件可能缺少证据；没有证据的核验一律不算通过。 */
      status = 'invalidated';
      statusReason = '核验缺少可追溯证据，需重新完成核验';
    } else if (!Number.isFinite(expiresAt) || now > expiresAt) {
      status = 'expired';
      statusReason = `核验有效期至 ${verification.expiresAt.slice(0, 10)}，已过期`;
    } else {
      status = 'verified';
      statusReason = `核验有效至 ${verification.expiresAt.slice(0, 10)}`;
    }
  }

  const daysRemaining =
    verification && status === 'verified'
      ? Math.max(0, Math.ceil((Date.parse(verification.expiresAt) - now) / DAY_MS))
      : null;

  return { ...record, status, statusReason, daysRemaining };
}

/** 股票级风险闸门：由该股票全部风险事件派生，任何单条核验都不能代表整体完成。 */
export function deriveRiskGate(
  records: RiskEventRecord[],
  symbol: string,
  now = Date.now(),
): RiskGate {
  const items = records.filter((record) => record.symbol === symbol).map((record) =>
    deriveRiskEvent(record, now),
  );
  const open = items.filter((item) => item.status !== 'verified');
  const highestOpenSeverity = open.reduce<RiskSeverity | null>(
    (worst, item) =>
      worst === null || SEVERITY_RANK[item.severity] < SEVERITY_RANK[worst]
        ? item.severity
        : worst,
    null,
  );
  const allowedLevels: ResearchLevel[] =
    highestOpenSeverity === 'high' ? [] : open.length > 0 ? ['L1', 'L2'] : [...ALL_LEVELS];
  const blockedLevels = ALL_LEVELS.filter((level) => !allowedLevels.includes(level));

  const count = (status: RiskVerificationStatus) =>
    items.filter((item) => item.status === status).length;

  const summary =
    items.length === 0
      ? '未登记风险事项，风险闸门不额外阻断'
      : open.length === 0
        ? `${items.length}项风险均在有效期内完成核验，L1–L3按量化条件放行`
        : highestOpenSeverity === 'high'
          ? `${open.length}/${items.length}项风险未关闭且含高风险：L1–L3全部阻断`
          : `${open.length}/${items.length}项风险未关闭（无高风险）：L1/L2可研究，L3阻断`;

  return {
    verified: items.length > 0 && open.length === 0,
    totalCount: items.length,
    openCount: open.length,
    pendingCount: count('pending'),
    expiredCount: count('expired'),
    invalidatedCount: count('invalidated'),
    highestOpenSeverity,
    allowedLevels,
    blockedLevels,
    signature: items
      .map(
        (item) =>
          `${item.id}:${item.status}:r${item.source.revision}:${item.verification?.expiresAt ?? '-'}`,
      )
      .sort()
      .join('|'),
    summary,
  };
}

/** 对外返回的风险列表：每次都按当前时间重新派生状态。 */
export function getRiskEvents(state: DemoState, now = Date.now()): RiskEvent[] {
  return state.risks.map((record) => deriveRiskEvent(record, now));
}

/** 记录一次人工核验：备注与证据必填，有效期由公开政策决定。 */
export function verifyRisk(
  state: DemoState,
  id: string,
  input: RiskVerificationInput,
  now = Date.now(),
): RiskEvent {
  const risk = state.risks.find((item) => item.id === id);
  if (!risk) throw new RiskError('风险事项不存在');
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RiskError('核验请求必须为JSON对象');
  }

  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length < 4) throw new RiskError('核验备注至少4个字，用于说明核对结论');
  if (note.length > 500) throw new RiskError('核验备注不能超过500字');

  const evidenceUrl = typeof input.evidenceUrl === 'string' ? input.evidenceUrl.trim() : '';
  if (evidenceUrl.length > 500) throw new RiskError('证据链接或内部记录编号不能超过500字');
  /** 任何严重度的核验都必须留下证据，否则 L3 放行无法追溯到具体材料。 */
  if (evidenceUrl.length < 4) {
    throw new RiskError('核验必须填写证据链接或内部记录编号');
  }

  const verifiedBy =
    typeof input.verifiedBy === 'string' && input.verifiedBy.trim()
      ? input.verifiedBy.trim().slice(0, 40)
      : '研究台用户';
  const validityDays = RISK_POLICY.validityDays[risk.severity];

  risk.verification = {
    verifiedAt: new Date(now).toISOString(),
    verifiedBy,
    note,
    evidenceUrl,
    revision: risk.source.revision,
    severity: risk.severity,
    expiresAt: new Date(now + validityDays * DAY_MS).toISOString(),
  };
  risk.invalidatedAt = null;
  risk.invalidatedReason = null;

  return deriveRiskEvent(risk, now);
}

/** 新增风险事项；新增高风险时，该股票此前的核验全部失效，必须重新核验。 */
export function addRiskEvent(
  state: DemoState,
  input: RiskEventInput,
  now = Date.now(),
): RiskEvent {
  const parsed = parseRiskEventInput(state, input);
  const record: RiskEventRecord = {
    id: nextRiskId(state, parsed.symbol),
    symbol: parsed.symbol,
    title: parsed.title,
    type: parsed.type,
    severity: parsed.severity,
    date: parsed.source.publishedAt,
    summary: parsed.summary,
    source: {
      publisher: parsed.source.publisher,
      url: parsed.source.url ?? null,
      excerpt: parsed.source.excerpt,
      publishedAt: parsed.source.publishedAt,
      revision: 1,
    },
    verification: null,
    invalidatedAt: null,
    invalidatedReason: null,
  };
  state.risks.push(record);

  if (record.severity === 'high') {
    invalidateSymbolVerifications(
      state,
      record.symbol,
      '新增高风险事项，原有核验需重新完成',
      now,
    );
  }

  return deriveRiskEvent(record, now);
}

/** 原文更新：版本号递增，仅使本条风险的核验失效，其他风险不受影响。 */
export function updateRiskSource(
  state: DemoState,
  id: string,
  patch: RiskSourcePatch,
  now = Date.now(),
): RiskEvent {
  const risk = state.risks.find((item) => item.id === id);
  if (!risk) throw new RiskError('风险事项不存在');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new RiskError('原文更新必须为JSON对象');
  }

  const next = { ...risk.source };
  if (patch.publisher !== undefined) {
    next.publisher = requireText(patch.publisher, '发布方', 80);
  }
  if (patch.url !== undefined) {
    if (patch.url === null) next.url = null;
    else next.url = requireText(patch.url, '原文链接', 500);
  }
  if (patch.excerpt !== undefined) {
    next.excerpt = requireText(patch.excerpt, '原文摘录', 500);
  }
  if (patch.publishedAt !== undefined) {
    next.publishedAt = requireIsoDate(patch.publishedAt, '原文发布日期');
  }
  next.revision = risk.source.revision + 1;
  risk.source = next;

  if (risk.verification) {
    risk.invalidatedAt = new Date(now).toISOString();
    risk.invalidatedReason = `原文更新至 v${next.revision}，原核验失效`;
  }

  return deriveRiskEvent(risk, now);
}

/** 服务启动时恢复风险原文与核验记录；空记录保留演示种子。 */
export function hydrateRisks(state: DemoState, records: unknown[]): void {
  const restored = records
    .map((record) => normalizeRiskRecord(record, state))
    .filter((record): record is RiskEventRecord => record !== null);
  if (restored.length > 0) state.risks = restored;
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

  /** 同步股票的持仓字段，保证快照读取一致。 */
  for (const [symbol, holding] of state.holdings) {
    const stock = state.stocks.get(symbol);
    if (stock) {
      stock.holdingShares = holding.shares;
      stock.holdingCost = holding.cost;
    }
  }
}

function invalidateSymbolVerifications(
  state: DemoState,
  symbol: string,
  reason: string,
  now: number,
): void {
  const at = new Date(now).toISOString();
  for (const item of state.risks) {
    if (item.symbol !== symbol || !item.verification) continue;
    item.invalidatedAt = at;
    item.invalidatedReason = reason;
  }
}

function nextRiskId(state: DemoState, symbol: string): string {
  const base = `risk-${symbol}`;
  if (!state.risks.some((item) => item.id === base)) return base;
  let index = 2;
  while (state.risks.some((item) => item.id === `${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function isRiskSeverity(value: unknown): value is RiskSeverity {
  return typeof value === 'string' && (RISK_SEVERITIES as readonly string[]).includes(value);
}

function isRiskType(value: unknown): value is RiskType {
  return typeof value === 'string' && (RISK_TYPES as readonly string[]).includes(value);
}

function requireIsoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RiskError(`${field}必须为YYYY-MM-DD格式`);
  }
  return value;
}

function requireText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new RiskError(`${field}不能为空`);
  if (text.length > maxLength) throw new RiskError(`${field}不能超过${maxLength}字`);
  return text;
}

/** 新增风险的规范化入参：原文摘录必填，没有原文就不登记风险。 */
export interface ParsedRiskEventInput {
  symbol: string;
  title: string;
  type: RiskType;
  severity: RiskSeverity;
  summary: string;
  source: { publisher: string; url: string | null; excerpt: string; publishedAt: string };
}

export function parseRiskEventInput(state: DemoState, body: unknown): ParsedRiskEventInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RiskError('请求体必须为JSON对象');
  }
  const input = body as Partial<RiskEventInput>;
  const symbol = typeof input.symbol === 'string' ? input.symbol.trim().toUpperCase() : '';
  if (!state.stocks.has(symbol)) throw new RiskError('股票代码无效');
  if (!isRiskType(input.type)) throw new RiskError('风险类型必须为公告、财务、行业或数据');
  if (!isRiskSeverity(input.severity)) throw new RiskError('风险严重度必须为high、medium或low');

  const rawSource = input.source;
  if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) {
    throw new RiskError('风险来源不能为空');
  }
  const url =
    typeof rawSource.url === 'string' && rawSource.url.trim()
      ? rawSource.url.trim().slice(0, 500)
      : undefined;

  return {
    symbol,
    title: requireText(input.title, '风险标题', 120),
    type: input.type,
    severity: input.severity,
    summary: requireText(input.summary, '风险摘要', 500),
    source: {
      publisher: requireText(rawSource.publisher, '发布方', 80),
      url: url ?? null,
      excerpt: requireText(rawSource.excerpt, '原文摘录', 500),
      publishedAt: requireIsoDate(rawSource.publishedAt, '原文发布日期'),
    },
  };
}

/** 恢复落盘记录时做边界校验，避免手改文件污染研究结论。 */
function normalizeRiskRecord(record: unknown, state: DemoState): RiskEventRecord | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const raw = record as Partial<RiskEventRecord>;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.symbol !== 'string' || !state.stocks.has(raw.symbol)) return null;
  if (!isRiskType(raw.type) || !isRiskSeverity(raw.severity)) return null;
  if (!raw.source || typeof raw.source !== 'object') return null;

  const source = raw.source;
  if (typeof source.publisher !== 'string' || !source.publisher) return null;
  if (typeof source.excerpt !== 'string' || !source.excerpt) return null;
  if (typeof source.publishedAt !== 'string') return null;
  if (!Number.isInteger(source.revision) || source.revision < 1) return null;

  let verification: RiskVerification | null = null;
  if (raw.verification) {
    const item = raw.verification;
    if (
      typeof item.verifiedAt !== 'string' ||
      typeof item.verifiedBy !== 'string' ||
      typeof item.note !== 'string' ||
      typeof item.expiresAt !== 'string' ||
      !isRiskSeverity(item.severity) ||
      !Number.isInteger(item.revision)
    ) {
      return null;
    }
    verification = {
      verifiedAt: item.verifiedAt,
      verifiedBy: item.verifiedBy,
      note: item.note,
      evidenceUrl: typeof item.evidenceUrl === 'string' ? item.evidenceUrl : null,
      revision: item.revision,
      severity: item.severity,
      expiresAt: item.expiresAt,
    };
  }

  return {
    id: raw.id,
    symbol: raw.symbol,
    title: typeof raw.title === 'string' ? raw.title : '',
    type: raw.type,
    severity: raw.severity,
    date: typeof raw.date === 'string' ? raw.date : source.publishedAt,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    source: {
      publisher: source.publisher,
      url: typeof source.url === 'string' ? source.url : null,
      excerpt: source.excerpt,
      publishedAt: source.publishedAt,
      revision: source.revision,
    },
    verification,
    invalidatedAt: typeof raw.invalidatedAt === 'string' ? raw.invalidatedAt : null,
    invalidatedReason: typeof raw.invalidatedReason === 'string' ? raw.invalidatedReason : null,
  };
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
  const version = (state.assumptions.get(symbol)?.version ?? 0) + 1;
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
    version,
    savedAt: savedAt === null ? null : new Date(savedAt).toISOString(),
    source: 'assumption',
    sourceDetail: `用户假设 v${version}，基于${forecastSourceLabel(stock.baseForecast.source)}：${stock.baseForecast.sourceDetail}`,
    announcementDate: stock.baseForecast.announcementDate,
    reportPeriod: stock.baseForecast.reportPeriod,
    hypothesis: buildForecastHypothesis(
      stock.baseDividend,
      dividends,
      input.forecastYear,
      input.scenario,
    ),
  };
}

/** 把当前生效假设展开成可追溯的预测对象，保证预测值、来源和假设同步更新。 */
function forecastFromAssumption(assumption: DividendAssumption): DividendForecast {
  return {
    year: assumption.forecastYear,
    scenario: assumption.scenario,
    dividendPerShare: assumption.dividendPerShare,
    source: assumption.source,
    sourceDetail: assumption.sourceDetail,
    announcementDate: assumption.announcementDate,
    reportPeriod: assumption.reportPeriod,
    hypothesis: assumption.hypothesis,
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
    forecastYear: stock.dividendForecast.year,
    scenario: stock.dividendForecast.scenario,
    dividendPerShare: stock.forecastDividend,
    requiredYield: stock.buyThreshold,
    version: 0,
    savedAt: null,
    source: stock.dividendForecast.source,
    sourceDetail: stock.dividendForecast.sourceDetail,
    announcementDate: stock.dividendForecast.announcementDate,
    reportPeriod: stock.dividendForecast.reportPeriod,
    hypothesis: stock.dividendForecast.hypothesis,
  };
}

/** 临时预览：按同一公式计算，但不写入状态、不递增版本。 */
export function previewAssumption(
  state: DemoState,
  symbol: string,
  input: AssumptionInput,
  now = Date.now(),
): { assumption: DividendAssumption; plan: PlanTier[] } {
  const stock = state.stocks.get(symbol);
  if (!stock) throw new AssumptionError('未知股票代码');
  const assumption = composeAssumption(state, symbol, input, null);
  const riskGate = deriveRiskGate(state.risks, symbol, now);
  return { assumption, plan: buildResearchPlan({ ...stock, riskGate }, assumption) };
}

function applyAssumption(state: DemoState, assumption: DividendAssumption): void {
  state.assumptions.set(assumption.symbol, assumption);
  const stock = state.stocks.get(assumption.symbol);
  const seed = STOCK_SEED_MAP.get(assumption.symbol);
  if (!stock) return;
  state.stocks.set(assumption.symbol, {
    ...stock,
    forecastDividend: assumption.dividendPerShare,
    buyThreshold: assumption.requiredYield,
    assumptionVersion: assumption.version,
    dividendForecast: forecastFromAssumption(assumption),
    /** 分红下修会改变现金流覆盖，质量检查必须随预测同步重算。 */
    dividendQuality: seed
      ? buildDividendQuality(seed, assumption.dividendPerShare)
      : stock.dividendQuality,
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

    const stock = state.stocks.get(record.symbol)!;
    const source: ForecastSource = isForecastSource(record.source) ? record.source : 'assumption';
    const sourceDetail =
      typeof record.sourceDetail === 'string' && record.sourceDetail.length > 0
        ? record.sourceDetail
        : `用户假设 v${record.version}，基于${forecastSourceLabel(stock.baseForecast.source)}`;
    const hypothesis =
      typeof record.hypothesis === 'string' && record.hypothesis.length > 0
        ? record.hypothesis
        : buildForecastHypothesis(
            stock.baseDividend,
            state.dividends.get(record.symbol) ?? [],
            record.forecastYear,
            record.scenario,
          );

    applyAssumption(state, {
      ...record,
      source,
      sourceDetail,
      announcementDate:
        typeof record.announcementDate === 'string' ? record.announcementDate : null,
      reportPeriod:
        typeof record.reportPeriod === 'string' && record.reportPeriod.length > 0
          ? record.reportPeriod
          : stock.baseForecast.reportPeriod,
      hypothesis,
    });
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
  const quality = stock.dividendQuality;
  const dividendStatus: SignalStatus = quality.oneOff
    ? 'block'
    : quality.status === 'sustainable'
      ? 'pass'
      : quality.status === 'watch'
        ? 'watch'
        : 'block';

  return [
    {
      key: 'valuation',
      label: '股息估值',
      status: valuationStatus,
      value: `${dividendYield.toFixed(2)}% / ${stock.buyThreshold.toFixed(2)}%`,
      description: '预测股息率与个性化研究门槛独立比较。',
    },
    {
      key: 'dividend',
      label: '分红质量',
      status: dividendStatus,
      value: `${dividendQualityLabel(quality.status)} · 覆盖 ${quality.freeCashFlowCoverage.toFixed(2)}×`,
      description: '派息率、经营与自由现金流覆盖、利润波动与杠杆质量共同决定分红可持续性。',
    },
    {
      key: 'technical',
      label: '布林超跌',
      status: technicalStatus,
      value: `%B ${indicators.percentB.toFixed(2)}`,
      description: '观察前复权收盘价在20日布林通道中的相对位置。',
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
      status: stock.riskGate.verified
        ? 'pass'
        : stock.riskGate.highestOpenSeverity === 'high'
          ? 'block'
          : 'watch',
      value: stock.riskGate.verified
        ? `全部${stock.riskGate.totalCount}项有效核验`
        : `${stock.riskGate.openCount}项未关闭${stock.riskGate.allowedLevels.length === 0 ? ' · 全部阻断' : ' · L3阻断'}`,
      description:
        '按风险事件逐条核验并记录证据与有效期；高风险未关闭阻断全部等级，中/低风险未关闭仅阻断L3。',
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
  const factors: Record<SignalStatus, number> = {
    pass: 1,
    watch: 0.6,
    neutral: 0.3,
    block: 0,
  };
  const score = signals.reduce(
    (total, signal) => total + SIGNAL_WEIGHTS[signal.key] * factors[signal.status],
    0,
  );
  return round(Math.max(0, Math.min(100, score)));
}

function researchAction(stock: Stock): Pick<Stock, 'action' | 'summary'> {
  const qualityBlocked =
    stock.dividendQuality.status === 'fragile' || stock.dividendQuality.oneOff;
  const gate = stock.riskGate;

  /** 公开规则：存在未关闭的高风险事项时，L1–L3 全部阻断。 */
  if (gate.highestOpenSeverity === 'high') {
    return {
      action: '风险阻断',
      summary: `存在${gate.openCount}项未关闭风险且含高风险，按公开阻断矩阵L1–L3全部暂停，先完成逐条核验并留下证据。`,
    };
  }

  if (stock.level === 'L0') {
    const valuationPass = stock.dividendYield >= stock.buyThreshold;
    return {
      action: valuationPass ? '继续观察' : '等待更深价格',
      summary: qualityBlocked
        ? '分红质量检查未通过，即使估值门槛已达，也不进入价格阶梯。'
        : valuationPass
          ? '演示估值门槛已达，但布林超跌条件不足，继续观察。'
          : '演示预测股息率未达L1门槛，等待更深价格。',
    };
  }

  if (qualityBlocked) {
    return {
      action: '分红质量复核',
      summary: `达到${stock.level}估值与超跌条件，但${stock.dividendQuality.oneOff ? '预测分红含一次性特别分红' : '现金流覆盖不足'}，研究等级封顶L1。`,
    };
  }

  return {
    action: '进入人工复核',
    summary: gate.verified
      ? `达到${stock.level}估值与超跌研究条件，${gate.totalCount}项风险均在有效期内完成核验，仍需结合公告和组合约束人工复核。`
      : `达到${stock.level}估值与超跌研究条件，仍有${gate.openCount}项中/低风险待核验，L3保持阻断。`,
  };
}

export function analyzeStock(
  stock: Stock,
  history: PriceBar[],
  availableCash: number,
  riskGate: RiskGate,
): Stock {
  const indicators = calculateIndicators(history);
  const price = history[history.length - 1].close;
  const previousClose = history[history.length - 2]?.close ?? price;
  const changePct = round((price / previousClose - 1) * 100);
  const dividendYield = round((stock.forecastDividend / price) * 100);
  const withMarketData = {
    ...stock,
    price,
    changePct,
    dividendYield,
    ...indicators,
    riskGate,
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

function buildRiskEvents(): RiskEventRecord[] {
  return STOCK_SEEDS.map((seed, index) => {
    const type = (['公告', '财务', '行业', '数据'] as const)[index % 4];
    const severity = (['medium', 'low', 'medium', 'low', 'high', 'low'] as const)[index];
    const date = `2026-10-${String(18 + (index % 4)).padStart(2, '0')}`;
    const verifiedAt = Date.parse(`${date}T02:00:00.000Z`);

    return {
      id: `risk-${seed.symbol}`,
      symbol: seed.symbol,
      title: `${seed.name}演示风险事项`,
      type,
      severity,
      date,
      summary: '仅用于演示人工风险复核流程，不对应真实公告或实时事件。',
      source: {
        publisher: '演示公告库',
        url: null,
        excerpt: `演示原文摘录：${seed.name}${type}类风险事项，用于核对“原文—来源—严重度—核验记录—有效期”的完整链路。`,
        publishedAt: date,
        revision: 1,
      },
      verification: seed.riskVerified
        ? {
            verifiedAt: new Date(verifiedAt).toISOString(),
            verifiedBy: '演示核验',
            note: '演示登记：已在演示环境核对原文摘录，不代表真实投资结论。',
            evidenceUrl: `demo://risk/${seed.symbol}/source`,
            revision: 1,
            severity,
            expiresAt: new Date(
              verifiedAt + RISK_POLICY.validityDays[severity] * DAY_MS,
            ).toISOString(),
          }
        : null,
      invalidatedAt: null,
      invalidatedReason: null,
    };
  });
}

export function createDemoState(now = Date.now()): DemoState {
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
    lastNotices: new Map(),
    trades: [],
  };

  for (const seed of STOCK_SEEDS) {
    const history = buildMarketHistory(seed);
    const dividends = buildDividendHistory(seed);
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
      riskGate: deriveRiskGate(state.risks, seed.symbol, now),
      dividendForecast: {
        year: FORECAST_BASE_YEAR,
        scenario: 'base',
        dividendPerShare: seed.forecastDividend,
        ...seed.forecast,
        hypothesis: buildForecastHypothesis(
          seed.forecastDividend,
          dividends,
          FORECAST_BASE_YEAR,
          'base',
        ),
      },
      baseForecast: { ...seed.forecast },
      dividendQuality: buildDividendQuality(seed, seed.forecastDividend),
      valuationBasis: { ...seed.valuationBasis },
      marketData: {
        quoteTime: DATA_META.quoteTime,
        priceAdjustment: DATA_META.priceAdjustment,
        indicatorAdjustment: DATA_META.indicatorAdjustment,
        lastExDate: seed.exDividend.exDate,
      },
      /** 已到账与已宣告待收各记一条，避免把待收现金当成可用资金。 */
      receivedDividend: seed.exDividend,
      pendingDividend: seed.pendingDividend,
    };
    state.histories.set(seed.symbol, history);
    state.dividends.set(seed.symbol, dividends);
    state.stocks.set(
      seed.symbol,
      analyzeStock(initial, history, state.cash, deriveRiskGate(state.risks, seed.symbol, now)),
    );
  }

  return state;
}

/**
 * 研究快照：只依据当前价格、分红假设与全部风险事件重新计算研究结论。
 * 纯计算，不读写提醒冷却状态，因此任意次数的 GET 都返回同一结论。
 */
export function getStockSnapshot(state: DemoState, symbol: string, now = Date.now()): Stock {
  const current = state.stocks.get(symbol);
  const history = state.histories.get(symbol);
  if (!current || !history) throw new Error('未知股票代码');
  return analyzeStock(current, history, state.cash, deriveRiskGate(state.risks, symbol, now));
}

/**
 * 提醒资格：只回答“这次要不要发提醒”，不改变等级、动作与原因。
 * 分红假设或风险状态变化时，视为新的提醒场景重新评估。
 */
export function evaluateReminder(
  state: DemoState,
  stock: Stock,
  now = Date.now(),
): ReminderDecision {
  if (stock.level === 'L0') {
    return { notify: false, reason: '当前为L0，不产生提醒' };
  }

  const previous = state.lastNotices.get(stock.symbol);
  if (!previous) {
    return { notify: true, reason: '首次触发该等级的研究提醒' };
  }

  const changed =
    previous.level !== stock.level ||
    previous.assumptionVersion !== stock.assumptionVersion ||
    previous.riskSignature !== stock.riskGate.signature;
  if (changed) {
    return { notify: true, reason: '研究等级、分红假设或风险核验状态变化，重新评估提醒' };
  }

  if (now < previous.at || now - previous.at >= ADVICE_COOLDOWN_MS) {
    return { notify: true, reason: '已超出24小时冷却期，重新发送提醒' };
  }

  return { notify: false, reason: '同一等级与假设处于24小时冷却期，仅抑制重复提醒' };
}

/** 状态变更事件（保存假设、更新门槛、人工核验）触发；GET 路由不得调用。 */
export function dispatchReminder(
  state: DemoState,
  stock: Stock,
  now = Date.now(),
): ReminderDecision {
  if (stock.level === 'L0') {
    state.lastNotices.delete(stock.symbol);
    return { notify: false, reason: '当前为L0，不产生提醒' };
  }

  const decision = evaluateReminder(state, stock, now);
  if (decision.notify) {
    state.lastNotices.set(stock.symbol, {
      level: stock.level,
      assumptionVersion: stock.assumptionVersion,
      riskSignature: stock.riskGate.signature,
      at: now,
    });
  }
  return decision;
}

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
  const stock = state.stocks.get(request.symbol)!;
  const amount = round(request.shares * request.price);
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

  stock.holdingShares = holding.shares;
  stock.holdingCost = holding.cost;
  return getPortfolio(state);
}

/**
 * 复盘：对每笔买入做 FIFO 配对、规则合规检查与盈亏分类。
 * 目标是区分"按规则执行但结果亏损"与"未按规则执行"。
 */
export function reviewTrades(state: DemoState): TradeReviewResponse {
  const levelRank: Record<ResearchLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

  // 交易账本最新在前；按时间升序处理以便 FIFO 配对（同日按插入顺序倒排）。
  const ordered = state.trades
    .map((trade, index) => ({ trade, index }))
    .sort((a, b) => {
      const byDate = a.trade.executedAt.localeCompare(b.trade.executedAt);
      return byDate !== 0 ? byDate : b.index - a.index;
    });

  interface BuyLot {
    trade: TradeRecord;
    remaining: number;
    sellTradeIds: string[];
    soldShares: number;
    sellProceeds: number;
  }

  // 按 symbol 分组，标准 FIFO：卖出从最早未平仓买入开始扣减。
  const queue = new Map<string, BuyLot[]>();
  const lots = new Map<string, BuyLot[]>();

  for (const { trade } of ordered) {
    if (trade.side === 'buy') {
      const lot: BuyLot = {
        trade,
        remaining: trade.shares,
        sellTradeIds: [],
        soldShares: 0,
        sellProceeds: 0,
      };
      if (!queue.has(trade.symbol)) queue.set(trade.symbol, []);
      queue.get(trade.symbol)!.push(lot);
      if (!lots.has(trade.symbol)) lots.set(trade.symbol, []);
      lots.get(trade.symbol)!.push(lot);
    } else {
      const buyQueue = queue.get(trade.symbol);
      if (!buyQueue || buyQueue.length === 0) continue;
      let remainingSell = trade.shares;
      while (remainingSell > 0 && buyQueue.length > 0) {
        const lot = buyQueue[0];
        const matched = Math.min(lot.remaining, remainingSell);
        lot.remaining -= matched;
        lot.soldShares += matched;
        lot.sellProceeds += matched * trade.price;
        lot.sellTradeIds.push(trade.id);
        remainingSell -= matched;
        if (lot.remaining === 0) buyQueue.shift();
      }
    }
  }

  // 逐笔买入生成复盘条目（按时间升序）。
  const items: TradeReviewItem[] = [];
  for (const { trade } of ordered) {
    if (trade.side !== 'buy') continue;
    const lot = lots.get(trade.symbol)!.find((l) => l.trade.id === trade.id)!;
    const fullyClosed = lot.soldShares >= trade.shares;

    const context = trade.researchContext;
    const planLevel = trade.planLevel;
    const complianceChecks: ComplianceCheck[] = [];
    let ruleCompliant = false;
    let classification: TradeClassification;

    if (!context) {
      classification = 'no_snapshot';
    } else if (!planLevel) {
      classification = 'no_plan';
    } else {
      const targetTier = context.plan.find((tier) => tier.level === planLevel);
      const targetPrice = targetTier?.targetPrice ?? trade.planTargetPrice;
      const levelOk = levelRank[context.level] >= levelRank[planLevel];
      complianceChecks.push({
        rule: 'research_level',
        passed: levelOk,
        detail: `成交时研究等级 ${context.level}${levelOk ? '达到' : '未达到'} ${planLevel} 档要求`,
      });
      const gateOk = context.riskGate.allowedLevels.includes(planLevel);
      complianceChecks.push({
        rule: 'risk_gate',
        passed: gateOk,
        detail: gateOk
          ? `成交时风险闸门允许 ${planLevel} 档`
          : `成交时风险闸门不允许 ${planLevel} 档（未关闭风险 ${context.riskGate.openCount} 项）`,
      });
      const priceOk =
        targetPrice === null || targetPrice === undefined || trade.price <= targetPrice;
      complianceChecks.push({
        rule: 'price_discipline',
        passed: priceOk,
        detail: priceOk
          ? `成交价 ${trade.price} 不高于 ${planLevel} 目标价 ${targetPrice ?? '—'}`
          : `成交价 ${trade.price} 高于 ${planLevel} 目标价 ${targetPrice}`,
      });
      ruleCompliant = complianceChecks.every((check) => check.passed);
      const avgSellPrice = lot.soldShares > 0 ? lot.sellProceeds / lot.soldShares : trade.price;
      classification = ruleCompliant
        ? fullyClosed
          ? avgSellPrice >= trade.price
            ? 'rule_compliant_profit'
            : 'rule_compliant_loss'
          : 'open_position'
        : 'rule_violation';
    }

    let pairedSell: TradePairedSell | null = null;
    if (lot.soldShares > 0) {
      const avgSellPrice = lot.sellProceeds / lot.soldShares;
      const buyAmount = trade.price * lot.soldShares;
      const pnl = lot.sellProceeds - buyAmount;
      pairedSell = {
        sellTradeIds: lot.sellTradeIds,
        soldShares: lot.soldShares,
        avgSellPrice: round(avgSellPrice, 4),
        buyPrice: trade.price,
        pnl: round(pnl),
        pnlPct: round(buyAmount > 0 ? (pnl / buyAmount) * 100 : 0, 2),
        fullyClosed,
      };
    }

    items.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      name: trade.name,
      executedAt: trade.executedAt,
      shares: trade.shares,
      buyPrice: trade.price,
      planLevel,
      complianceChecks,
      ruleCompliant,
      pairedSell,
      classification,
    });
  }

  const summary: TradeReviewSummary = {
    totalBuys: items.length,
    ruleCompliantProfit: 0,
    ruleCompliantLoss: 0,
    ruleViolation: 0,
    openPosition: 0,
    noPlan: 0,
    noSnapshot: 0,
    totalPnl: 0,
  };
  for (const item of items) {
    switch (item.classification) {
      case 'rule_compliant_profit':
        summary.ruleCompliantProfit += 1;
        break;
      case 'rule_compliant_loss':
        summary.ruleCompliantLoss += 1;
        break;
      case 'rule_violation':
        summary.ruleViolation += 1;
        break;
      case 'open_position':
        summary.openPosition += 1;
        break;
      case 'no_plan':
        summary.noPlan += 1;
        break;
      case 'no_snapshot':
        summary.noSnapshot += 1;
        break;
    }
    if (item.pairedSell?.fullyClosed) {
      summary.totalPnl += item.pairedSell.pnl;
    }
  }
  summary.totalPnl = round(summary.totalPnl);

  return { items, summary };
}
