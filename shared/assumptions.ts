import type {
  DividendQualityStatus,
  DividendRecord,
  DividendScenario,
  ForecastSource,
  PriceBar,
  StatBasis,
} from './types.ts';

/** 预测基准年：该年的每股分红直接取自原始预测，之后按近一年增速外推。 */
export const FORECAST_BASE_YEAR = 2026;
export const FORECAST_YEARS = [2026, 2027, 2028];

export const REQUIRE_YIELD_MIN = 3;
export const REQUIRE_YIELD_MAX = 10;

export const SCENARIOS: {
  key: DividendScenario;
  label: string;
  factor: number;
  note: string;
}[] = [
  { key: 'conservative', label: '谨慎', factor: 0.85, note: '分红下修 15%' },
  { key: 'base', label: '基准', factor: 1, note: '沿用当前预测' },
  { key: 'optimistic', label: '乐观', factor: 1.1, note: '分红增长 10%' },
];

export function scenarioMeta(key: DividendScenario) {
  return SCENARIOS.find((item) => item.key === key) ?? SCENARIOS[1];
}

export function isDividendScenario(value: unknown): value is DividendScenario {
  return SCENARIOS.some((item) => item.key === value);
}

export const FORECAST_SOURCE_LABELS: Record<ForecastSource, string> = {
  announced: '已宣告分红',
  guidance: '公司指引',
  extrapolation: '历史外推',
  assumption: '用户假设',
};

export function forecastSourceLabel(source: ForecastSource): string {
  return FORECAST_SOURCE_LABELS[source] ?? FORECAST_SOURCE_LABELS.assumption;
}

export function isForecastSource(value: unknown): value is ForecastSource {
  return value === 'announced' || value === 'guidance' || value === 'extrapolation' || value === 'assumption';
}

export const STAT_BASIS_LABELS: Record<StatBasis, string> = {
  annual: '年报',
  quarter: '单季',
  ttm: 'TTM',
};

export function statBasisLabel(basis: StatBasis): string {
  return STAT_BASIS_LABELS[basis] ?? STAT_BASIS_LABELS.annual;
}

export const DIVIDEND_QUALITY_LABELS: Record<DividendQualityStatus, string> = {
  sustainable: '可持续',
  watch: '需复核',
  fragile: '不达标',
};

export function dividendQualityLabel(status: DividendQualityStatus): string {
  return DIVIDEND_QUALITY_LABELS[status] ?? DIVIDEND_QUALITY_LABELS.watch;
}

export function roundTo(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function latestDividendGrowth(dividends: DividendRecord[]): number {
  return dividends.at(-1)?.growth ?? 0;
}

/** 预测每股分红 = 原始预测 × 年度增速外推 × 情景系数，两端共用同一公式。 */
export function projectedDividendPerShare(
  baseDividend: number,
  dividends: DividendRecord[],
  forecastYear: number,
  scenario: DividendScenario,
): number {
  const growth = latestDividendGrowth(dividends) / 100;
  const years = Math.max(0, forecastYear - FORECAST_BASE_YEAR);
  return roundTo(baseDividend * (1 + growth) ** years * scenarioMeta(scenario).factor, 2);
}

/** 研究价格 = 预测每股分红 ÷ 要求股息率，实验室与计划页共用。 */
export function researchPrice(dividendPerShare: number, requiredYield: number): number {
  if (!Number.isFinite(requiredYield) || requiredYield <= 0) return 0;
  return roundTo(dividendPerShare / (requiredYield / 100), 2);
}

/** 把一次预测的推导过程写成可复述的假设说明，随预测值一同返回。 */
export function buildForecastHypothesis(
  baseDividend: number,
  dividends: DividendRecord[],
  forecastYear: number,
  scenario: DividendScenario,
): string {
  const growth = latestDividendGrowth(dividends);
  const years = Math.max(0, forecastYear - FORECAST_BASE_YEAR);
  const meta = scenarioMeta(scenario);
  const steps = [`以每股 ${roundTo(baseDividend)} 元为基准`];
  if (years > 0) {
    steps.push(`按近一年增速 ${growth.toFixed(2)}% 外推 ${years} 年`);
  } else {
    steps.push('不外推年度增长');
  }
  if (meta.factor !== 1) {
    steps.push(`叠加${meta.label}情景系数 ${meta.factor}`);
  }
  return `${steps.join('，')}，得到 ${forecastYear} 年每股分红预测。`;
}

export interface ExDividendEvent {
  exDate: string;
  dividendPerShare: number;
}

/**
 * 前复权：把除息日之前的行情按除息比例整体缩放，抹平除息缺口。
 * 技术指标与涨跌幅必须基于复权后的价格，否则除息回落会被误判为额外超跌。
 */
export function adjustForExDividend(bars: PriceBar[], events: ExDividendEvent[]): PriceBar[] {
  const adjusted = bars.map((bar) => ({ ...bar }));
  const sorted = [...events].sort((a, b) => a.exDate.localeCompare(b.exDate));

  for (const event of sorted) {
    if (!(event.dividendPerShare > 0)) continue;
    const index = adjusted.findIndex((bar) => bar.date >= event.exDate);
    if (index <= 0) continue;
    const cumClose = adjusted[index - 1].close;
    if (!(cumClose > 0)) continue;
    const factor = (cumClose - event.dividendPerShare) / cumClose;
    if (!(factor > 0) || factor >= 1) continue;

    for (let i = 0; i < index; i += 1) {
      const bar = adjusted[i];
      bar.open = roundTo(bar.open * factor);
      bar.close = roundTo(bar.close * factor);
      bar.high = roundTo(Math.max(bar.open, bar.close, bar.high * factor));
      bar.low = roundTo(Math.min(bar.open, bar.close, bar.low * factor));
    }
  }

  return adjusted;
}
