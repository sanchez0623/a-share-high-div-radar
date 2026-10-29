import type {
  AssumptionInput,
  DividendAssumption,
  DividendForecast,
  ForecastSource,
  PlanTier,
} from '../shared/types.ts';
import {
  REQUIRE_YIELD_MAX,
  REQUIRE_YIELD_MIN,
  buildForecastHypothesis,
  forecastSourceLabel,
  isDividendScenario,
  isForecastSource,
  projectedDividendPerShare,
} from '../shared/assumptions.ts';
import { buildDividendQuality } from './dividend-quality.ts';
import { AssumptionError } from './errors.ts';
import { buildResearchPlan } from './research.ts';
import { getStockSnapshot } from './snapshot.ts';
import type { DemoState } from './state.ts';

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
  if (!state.stocks.has(symbol)) throw new AssumptionError('未知股票代码');
  const assumption = composeAssumption(state, symbol, input, null);
  /** 档位解锁使用当前纯计算快照，避免读取股票缓存里可能过期的研究等级。 */
  return { assumption, plan: buildResearchPlan(getStockSnapshot(state, symbol, now), assumption) };
}

function applyAssumption(state: DemoState, assumption: DividendAssumption): void {
  state.assumptions.set(assumption.symbol, assumption);
  const stock = state.stocks.get(assumption.symbol);
  if (!stock) return;
  const qualityInput = state.qualityInputs.get(assumption.symbol);
  state.stocks.set(assumption.symbol, {
    ...stock,
    forecastDividend: assumption.dividendPerShare,
    buyThreshold: assumption.requiredYield,
    assumptionVersion: assumption.version,
    dividendForecast: forecastFromAssumption(assumption),
    /** 分红下修会改变现金流覆盖，质量检查必须随预测同步重算。 */
    dividendQuality: qualityInput
      ? buildDividendQuality(qualityInput, assumption.dividendPerShare)
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
