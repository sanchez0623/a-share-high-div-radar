import type {
  DividendForecast,
  DividendPayment,
  DividendRecord,
  PriceBar,
  RiskEventRecord,
  StatBasis,
  Stock,
} from '../shared/types.ts';
import {
  FORECAST_BASE_YEAR,
  adjustForExDividend,
  buildForecastHypothesis,
} from '../shared/assumptions.ts';
import { AS_OF, DATA_META } from './config.ts';
import { buildDividendQuality, type DividendQualityInput } from './dividend-quality.ts';
import { round } from './numeric.ts';
import { analyzeStock } from './research.ts';
import { RISK_POLICY, deriveRiskGate } from './risk-model.ts';
import type { DemoState } from './state.ts';

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

function qualityInputOf(seed: StockSeed): DividendQualityInput {
  return {
    sector: seed.sector,
    /** 演示质量口径与基准预测年度（FORECAST_BASE_YEAR）对齐；真实数据源应传报告年度。 */
    dataYear: FORECAST_BASE_YEAR,
    payoutRatio: seed.payoutRatio,
    operatingCashFlowPerShare: seed.quality.operatingCashFlowPerShare,
    freeCashFlowPerShare: seed.quality.freeCashFlowPerShare,
    profitVolatility: seed.quality.profitVolatility,
    debtRatio: seed.quality.debtRatio,
    oneOff: seed.quality.oneOff,
    oneOffNote: seed.quality.oneOffNote,
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

function generateDemoHistory(seed: StockSeed): PriceBar[] {
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
  const DAY_MS = 24 * 60 * 60 * 1000;
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

/** 演示初始状态：写入事实数据，派生结论由 snapshot.ts 现算。 */
export function createDemoState(now = Date.now()): DemoState {
  const state: DemoState = {
    stocks: new Map(),
    histories: new Map(),
    dividends: new Map(),
    assumptions: new Map(),
    qualityInputs: new Map(STOCK_SEEDS.map((seed) => [seed.symbol, qualityInputOf(seed)])),
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
      dividendQuality: buildDividendQuality(
        qualityInputOf(seed),
        seed.forecastDividend,
        FORECAST_BASE_YEAR,
      ),
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
      analyzeStock({
        stock: initial,
        history,
        availableCash: state.cash,
        riskGate: deriveRiskGate(state.risks, seed.symbol, now),
        holding,
      }),
    );
  }

  return state;
}
