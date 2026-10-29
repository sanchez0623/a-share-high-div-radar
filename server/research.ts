import type {
  DividendAssumption,
  DividendQuality,
  PlanTier,
  PriceBar,
  ResearchLevel,
  RiskGate,
  Signal,
  SignalKey,
  SignalStatus,
  Stock,
} from '../shared/types.ts';
import { dividendQualityBasisLabel, dividendQualityLabel, researchPrice } from '../shared/assumptions.ts';
import { calculateIndicators, type IndicatorResult } from './indicators.ts';
import { reaches, round } from './numeric.ts';

export const ALL_LEVELS: ResearchLevel[] = ['L1', 'L2', 'L3'];

/**
 * 评分权重：按 SignalKey 一一绑定，评分时按权重表迭代而非按信号数组下标，
 * 新增信号键会在类型层强制补齐权重，信号顺序变化也不会影响得分。
 */
export const SIGNAL_WEIGHTS: Record<SignalKey, number> = {
  valuation: 25,
  dividend: 20,
  technical: 20,
  trend: 10,
  risk: 15,
  budget: 10,
};

/** 纯函数：根据价格、预测分红、技术位置与风险闸门派生研究等级。 */
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
    /** 分解决策一律使用未舍入的原始股息率与 %B，避免门槛附近与展示值不一致。 */
    const valuationPass = reaches(currentYield, tier.threshold);
    const technicalPass = stock.percentB <= tier.percentB;
    /** 风险阻断来自股票级闸门，由全部风险事件派生。 */
    const riskPass = stock.riskGate.allowedLevels.includes(tier.level);
    if (valuationPass && technicalPass && riskPass) return tier.level;
  }
  return 'L0';
}

/** 纯函数：把研究等级与假设展开成三档研究价格阶梯。 */
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

function buildSignals(
  stock: Stock,
  indicators: IndicatorResult,
  dividendYield: number,
  availableCash: number,
): Signal[] {
  const l1Amount = (stock.forecastDividend / (stock.buyThreshold / 100)) * 100;
  const valuationStatus: SignalStatus =
    reaches(dividendYield, stock.buyThreshold)
      ? 'pass'
      : reaches(dividendYield, stock.buyThreshold - 0.5)
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
      value: `${dividendQualityLabel(quality.status)}${quality.basis === 'base' ? `（${dividendQualityBasisLabel(quality.basis)}）` : ''} · 覆盖 ${quality.freeCashFlowCoverage.toFixed(2)}×`,
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
      /** 直接使用派生出的股票级状态，避免信号与风险页各自推断出不同结论。 */
      status:
        stock.riskGate.status === 'clear'
          ? 'neutral'
          : stock.riskGate.status === 'verified'
            ? 'pass'
            : stock.riskGate.status === 'blocked'
              ? 'block'
              : 'watch',
      value:
        stock.riskGate.status === 'clear'
          ? '未登记风险事项'
          : stock.riskGate.status === 'verified'
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
  /** 按 SignalKey 取状态、按权重表迭代，得分与信号数组顺序无关。 */
  const statusByKey = new Map(signals.map((signal) => [signal.key, signal.status]));
  const score = (Object.keys(SIGNAL_WEIGHTS) as SignalKey[]).reduce(
    (total, key) => total + SIGNAL_WEIGHTS[key] * factors[statusByKey.get(key)!],
    0,
  );
  return round(Math.max(0, Math.min(100, score)));
}

function researchAction(stock: Stock): Pick<Stock, 'action' | 'summary'> {
  const qualityBlocked =
    stock.dividendQuality.status === 'fragile' || stock.dividendQuality.oneOff;
  const gate = stock.riskGate;

  /** 公开规则：存在未关闭的高风险事项时，L1–L3 全部阻断。 */
  if (gate.status === 'blocked') {
    return {
      action: '风险阻断',
      summary: `存在${gate.openCount}项未关闭风险且含高风险，按公开阻断矩阵L1–L3全部暂停，先完成逐条核验并留下证据。`,
    };
  }

  if (stock.level === 'L0') {
    const valuationPass = reaches(stock.dividendYield, stock.buyThreshold);
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
      summary: `达到${stock.level}估值与超跌条件，但${stock.dividendQuality.oneOff ? '预测分红含一次性特别分红' : '现金流覆盖不足'}，研究等级封顶L1${stock.dividendQuality.basis === 'base' ? '，质量口径为基期质量参考' : ''}。`,
    };
  }

  return {
    action: '进入人工复核',
    summary:
      gate.status === 'verified'
        ? `达到${stock.level}估值与超跌研究条件，${gate.totalCount}项风险均在有效期内完成核验，仍需结合公告和组合约束人工复核。`
        : gate.status === 'clear'
          ? `达到${stock.level}估值与超跌研究条件，未登记风险事项，风险闸门不额外阻断，仍需结合公告和组合约束人工复核。`
          : `达到${stock.level}估值与超跌研究条件，仍有${gate.openCount}项中/低风险待核验，L3保持阻断。`,
  };
}

export interface StockAnalysisInput {
  /** 研究口径存储：价格与等级等派生字段会在本次计算中被覆盖。 */
  stock: Stock;
  history: PriceBar[];
  availableCash: number;
  riskGate: RiskGate;
  holding: { shares: number; cost: number };
}

/**
 * 纯函数：把研究口径、行情、风险闸门与持仓合并成一份完整快照。
 * 不读取缓存中的等级/评分/信号，也不写入任何状态。
 * 分级、信号与动作全部使用未舍入值；舍入只发生在返回展示快照的最后一步。
 */
export function analyzeStock(input: StockAnalysisInput): Stock {
  const { stock, history, availableCash, riskGate, holding } = input;
  const indicators = calculateIndicators(history);
  const price = history[history.length - 1].close;
  const previousClose = history[history.length - 2]?.close ?? price;
  const changePct = (price / previousClose - 1) * 100;
  const dividendYield = (stock.forecastDividend / price) * 100;
  const withMarketData: Stock = {
    ...stock,
    price,
    changePct,
    dividendYield,
    holdingShares: holding.shares,
    holdingCost: holding.cost,
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
    /** 以下字段仅用于展示：决策已在上方按未舍入值完成。 */
    changePct: round(changePct),
    dividendYield: round(dividendYield),
    ma20: round(indicators.ma20),
    bollUpper: round(indicators.bollUpper),
    bollMiddle: round(indicators.bollMiddle),
    bollLower: round(indicators.bollLower),
    percentB: round(indicators.percentB, 4),
    atr: round(indicators.atr),
    score: scoreSignals(signals),
    signals,
    sparkline: history.slice(-30).map((bar) => bar.close),
  };
}
