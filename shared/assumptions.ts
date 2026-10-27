import type { DividendRecord, DividendScenario } from './types.ts';

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
