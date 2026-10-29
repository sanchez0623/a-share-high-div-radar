import type { DividendQuality, DividendRecord, PriceBar, Stock, StockRegistrationInput } from '../shared/types.ts';
import { normalizeSymbol } from '../shared/quote-types.ts';
import { FORECAST_BASE_YEAR, REQUIRE_YIELD_MAX, REQUIRE_YIELD_MIN, buildForecastHypothesis } from '../shared/assumptions.ts';
import type { RawQuote } from '../shared/quote-types.ts';
import { loadAllBars } from './bar-store.ts';
import { DATA_META } from './config.ts';
import { buildSeedEntry } from './demo-data.ts';
import { StockError } from './errors.ts';
import { round } from './numeric.ts';
import { fetchIndustries } from './providers/industry-eastmoney.ts';
import { fetchDailyBars, fetchDailyBarsDetailed } from './providers/kline-eastmoney.ts';
import { fetchTencentDailyBars } from './providers/tencent-fqkline.ts';
import { tencentProvider } from './providers/tencent.ts';
import { analyzeStock } from './research.ts';
import { deriveRiskGate } from './risk-model.ts';
import type { DemoState } from './state.ts';
import {
  DEFAULT_BUY_THRESHOLD,
  type PersistedStockRecord,
  type PersistedStocks,
} from './stock-store.ts';
import type { DividendQualityInput } from './dividend-quality.ts';

/**
 * 动态添加/停用/恢复股票的领域逻辑（见 docs/dynamic-stock-watchlist.md §2.2–2.3）。
 *
 * 职责边界：
 * - 本模块只负责「校验 → 拉取基础数据 → 构建/拆除 DemoState 条目」；
 * - 落盘（stocks.json 与 bars）由 app.ts 的写事务统一编排；
 * - 网络依赖通过 StockRegistrationDeps 注入，测试可替换为假数据源。
 */

/** 数据源抽象：默认走东财日线 + 腾讯行情 + 东财行业，测试注入假实现。 */
export interface StockRegistrationDeps {
  fetchBars(symbol: string): Promise<{ bars: PriceBar[]; name: string }>;
  /** 行情捎带名称与 PE/PB；失败允许降级（停牌股可能拿不到）。 */
  fetchQuote(symbol: string): Promise<RawQuote | null>;
  fetchSector(symbol: string): Promise<string | null>;
}

/**
 * 日线拉取降级链：东财 push2his（主源，前复权）→ 腾讯 fqkline（同一免费接口，前复权）。
 * 两个源同为前复权口径，技术指标与除息缺口处理保持一致。
 */
async function fetchDailyBarsResilient(symbol: string): Promise<PriceBar[]> {
  try {
    return await fetchDailyBars(symbol, { limit: 140 });
  } catch (reason) {
    const bars = await fetchTencentDailyBars(symbol, 140).catch(() => {
      throw reason;
    });
    if (bars.length === 0) throw reason;
    return bars;
  }
}

export const defaultStockDataDeps: StockRegistrationDeps = {
  async fetchBars(symbol) {
    try {
      return await fetchDailyBarsDetailed(symbol, { limit: 140 });
    } catch (reason) {
      /** 东财日线不可用（限流/网络阻断）→ 腾讯 fqkline 降级；证券简称交由行情快照兜底。 */
      const bars = await fetchTencentDailyBars(symbol, 140).catch(() => {
        throw reason;
      });
      if (bars.length === 0) throw reason;
      return { bars, name: '' };
    }
  },
  async fetchQuote(symbol) {
    const quotes = await tencentProvider.fetchQuotes([symbol]);
    return quotes.find((quote) => quote.symbol === symbol) ?? null;
  },
  async fetchSector(symbol) {
    const industries = await fetchIndustries([symbol]);
    return industries.get(symbol) ?? null;
  },
};

/** 上海时区今日（YYYY-MM-DD）。 */
export function shanghaiToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** 「日线最后一根距今超过 7 个自然日」视为疑似停牌（约 5 个交易日）。 */
function isSuspiciouslySuspended(lastBarDate: string, today: string): boolean {
  const last = Date.parse(`${lastBarDate}T00:00:00.000Z`);
  const now = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return false;
  return (now - last) / 86_400_000 > 7;
}

/** 校验并规范化客户端提交的添加请求；白名单之外的字段一律拒绝。 */
export function parseStockRegistrationInput(body: unknown): StockRegistrationInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new StockError('请求体必须为JSON对象');
  }
  const payload = body as Record<string, unknown>;
  let symbol: string;
  try {
    symbol = normalizeSymbol(typeof payload.symbol === 'string' ? payload.symbol : '');
  } catch (reason) {
    throw new StockError((reason as Error).message);
  }
  /** B 股以美元/港币计价，与 CNY 现金账本混算会错，MVP 明确拒绝。 */
  if (symbol.startsWith('90') || symbol.startsWith('20')) {
    throw new StockError('暂不支持B股（美元/港币计价），仅支持沪深A股');
  }

  const input: StockRegistrationInput = { symbol };
  if (payload.sector !== undefined) {
    if (typeof payload.sector !== 'string') throw new StockError('sector 必须为字符串');
    const sector = payload.sector.trim();
    if (sector.length > 12) throw new StockError('行业名称过长');
    if (sector.length > 0) input.sector = sector;
  }
  if (payload.forecastDividend !== undefined) {
    const value = payload.forecastDividend;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) {
      throw new StockError('forecastDividend 必须为0到1000之间的数字');
    }
    input.forecastDividend = round(value, 4);
  }
  if (payload.buyThreshold !== undefined) {
    const value = payload.buyThreshold;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < REQUIRE_YIELD_MIN ||
      value > REQUIRE_YIELD_MAX
    ) {
      throw new StockError(`buyThreshold必须在${REQUIRE_YIELD_MIN}到${REQUIRE_YIELD_MAX}之间`);
    }
    input.buyThreshold = value;
  }
  if (payload.confirmSuspended === true) input.confirmSuspended = true;
  return input;
}

/** 注册/恢复共用的数据包：record 为落盘口径，bars 为日线序列。 */
export interface StockRegistrationParts {
  record: PersistedStockRecord;
  bars: PriceBar[];
  /** 本次是否新拉取了日线；false 表示命中本地缓存，恢复时无需重复落盘。 */
  freshBars: boolean;
}

/** 添加新股票：校验代码有效性（日线为准）→ 停牌检查 → 汇总名称/行业/估值。 */
export async function prepareNewStock(
  input: StockRegistrationInput,
  deps: StockRegistrationDeps,
  today = shanghaiToday(),
): Promise<StockRegistrationParts> {
  const symbol = input.symbol;
  const detailed = await deps.fetchBars(symbol).catch((reason: Error) => {
    throw new StockError(`代码不存在或已退市（日线拉取失败：${reason.message}）`);
  });
  if (detailed.bars.length < 20) {
    throw new StockError('该股票上市时间过短（K线不足20根），暂不支持添加');
  }
  const lastDate = detailed.bars[detailed.bars.length - 1].date;
  if (!input.confirmSuspended && isSuspiciouslySuspended(lastDate, today)) {
    throw new StockError(`该股票最近交易日为 ${lastDate}，疑似长期停牌，确认后仍可加入`, 409, true);
  }

  const quote = await deps.fetchQuote(symbol).catch(() => null);
  const sector =
    input.sector ?? (await deps.fetchSector(symbol).catch(() => null)) ?? '';

  const record: PersistedStockRecord = {
    symbol,
    name: detailed.name || quote?.name || symbol,
    kind: 'custom',
    disabled: false,
    sector,
    addedAt: today,
    forecastDividend: input.forecastDividend ?? 0,
    buyThreshold: input.buyThreshold ?? DEFAULT_BUY_THRESHOLD,
    pe: quote?.pe ?? null,
    pb: quote?.pb ?? null,
    price: detailed.bars[detailed.bars.length - 1].close,
  };
  return { record, bars: detailed.bars, freshBars: true };
}

/** 停用后的恢复：优先本地日线缓存，其次现拉日线；种子股兜底合成演示序列。 */
export async function prepareRestore(record: PersistedStockRecord): Promise<StockRegistrationParts> {
  const cached = loadAllBars([record.symbol]).get(record.symbol);
  if (cached && cached.length >= 20) {
    return { record, bars: cached, freshBars: false };
  }
  try {
    const bars = await fetchDailyBarsResilient(record.symbol);
    if (bars.length >= 20) return { record, bars, freshBars: true };
  } catch (reason) {
    if (record.kind !== 'seed') {
      throw new StockError(`日线数据暂不可用，无法恢复该股票：${(reason as Error).message}`, 503);
    }
    /* 种子股继续走合成演示序列兜底 */
  }
  if (record.kind === 'seed') {
    const entry = buildSeedEntry(record.symbol);
    if (!entry) throw new StockError('内置股票定义缺失，无法恢复', 503);
    return { record, bars: entry.history, freshBars: false };
  }
  throw new StockError('该股票K线不足20根，暂无法恢复', 503);
}

/** 质量数据未录入时的占位口径：如实标注「需复核」，不虚构检查结果。 */
function unassessedDividendQuality(): DividendQuality {
  const detail = '质量数据未录入：派息率、现金流覆盖等免费源不可得，请人工核验后补充';
  return {
    status: 'watch',
    basis: 'base',
    dataYear: null,
    payoutRatio: 0,
    operatingCashFlowCoverage: 0,
    freeCashFlowCoverage: 0,
    profitVolatility: 0,
    leverage: 0,
    oneOff: false,
    checks: [
      { key: 'payout', label: '派息率', status: 'watch', value: '—', detail },
      { key: 'cashflow', label: '现金流覆盖', status: 'watch', value: '—', detail },
      { key: 'volatility', label: '利润波动', status: 'watch', value: '—', detail },
      { key: 'leverage', label: '杠杆质量', status: 'watch', value: '—', detail },
    ],
    notes: ['质量数据未录入，分红可持续性结论仅为占位；研究等级不受封顶，但请先完成人工核验'],
  };
}

/** 自定义股票的初始研究口径：行情事实 + 用户假设（预测分红），派生结论交给 analyzeStock。 */
function buildCustomStockInitial(record: PersistedStockRecord, history: PriceBar[]): Stock {
  const forecastDividend = record.forecastDividend;
  const sourceDetail = '用户录入的预测分红，尚未对照分红公告原文核验';
  const reportPeriod = `${FORECAST_BASE_YEAR}年预测`;
  return {
    symbol: record.symbol,
    name: record.name,
    market: record.symbol.endsWith('.SH') ? 'SH' : 'SZ',
    sector: record.sector,
    price: history[history.length - 1].close,
    changePct: 0,
    baseDividend: forecastDividend,
    forecastDividend,
    dividendYield: 0,
    buyThreshold: record.buyThreshold,
    assumptionVersion: 0,
    payoutRatio: 0,
    dividendStreak: 0,
    pe: record.pe ?? 0,
    pb: record.pb ?? 0,
    roe: 0,
    holdingShares: 0,
    holdingCost: 0,
    updatedAt: record.addedAt || shanghaiToday(),
    dataMode: DATA_META.dataMode,
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
    riskGate: deriveRiskGate([], record.symbol),
    dividendForecast: {
      year: FORECAST_BASE_YEAR,
      scenario: 'base',
      dividendPerShare: forecastDividend,
      source: 'assumption',
      sourceDetail,
      announcementDate: null,
      reportPeriod,
      hypothesis: buildForecastHypothesis(forecastDividend, [], FORECAST_BASE_YEAR, 'base'),
    },
    baseForecast: { source: 'assumption', sourceDetail, announcementDate: null, reportPeriod },
    dividendQuality: unassessedDividendQuality(),
    valuationBasis: { pe: 'ttm', roe: 'annual' },
    marketData: {
      quoteTime: DATA_META.quoteTime,
      priceAdjustment: DATA_META.priceAdjustment,
      indicatorAdjustment: DATA_META.indicatorAdjustment,
      lastExDate: null,
    },
    receivedDividend: null,
    pendingDividend: null,
    /** 注册时无分红历史；启动装配读到真实分红事件缓存时由 applyDividendHistory 填充。 */
    dividendHistorySource: null,
    dividendHistorySyncedAt: null,
  };
}

/**
 * 把一只股票（自定义或停用恢复的种子）注入 DemoState：
 * stocks/histories/dividends/qualityInputs/holdings 全部落位，研究结论现算。
 * watchlist 选项仅用于「新增」流程；停用恢复不改观察仓。
 */
export function registerStockIntoState(
  state: DemoState,
  parts: StockRegistrationParts,
  options: { watchlist?: boolean; now?: number } = {},
): void {
  const { record, bars } = parts;
  const now = options.now ?? Date.now();
  const symbol = record.symbol;
  if (state.stocks.has(symbol)) {
    throw new StockError('该股票已在研究列表中', 409);
  }
  if (bars.length < 20) {
    throw new StockError('日线数据不足20根，无法计算技术指标', 503);
  }

  let initial: Stock;
  let dividends: DividendRecord[] = [];
  let qualityInput: DividendQualityInput | null = null;
  if (record.kind === 'seed') {
    const entry = buildSeedEntry(symbol, now);
    if (!entry) throw new StockError('内置股票定义缺失，无法恢复', 503);
    initial = entry.initial;
    dividends = entry.dividends;
    qualityInput = entry.qualityInput;
  } else {
    initial = buildCustomStockInitial(record, bars);
  }

  const holding = state.holdings.get(symbol) ?? { shares: 0, cost: 0, assumptionVersion: null };
  state.histories.set(symbol, bars);
  state.dividends.set(symbol, dividends);
  if (qualityInput) state.qualityInputs.set(symbol, qualityInput);
  state.holdings.set(symbol, holding);
  state.stocks.set(
    symbol,
    analyzeStock({
      stock: initial,
      history: bars,
      availableCash: state.cash,
      riskGate: deriveRiskGate(state.risks, symbol, now),
      holding,
    }),
  );
  if (options.watchlist) state.watchlist.add(symbol);
}

/** 从 DemoState 拆除一只股票（软删除：假设、风险与交易账本保留以供追溯/恢复）。 */
export function removeStockFromState(state: DemoState, symbol: string): void {
  state.stocks.delete(symbol);
  state.histories.delete(symbol);
  state.dividends.delete(symbol);
  state.qualityInputs.delete(symbol);
  state.holdings.delete(symbol);
  state.watchlist.delete(symbol);
}

/**
 * 启动恢复：把 stocks.json 中的自定义股票构建进 state，并把停用记录从 state 拆除。
 * 必须在行情装配（prepareLiveHistory）与 portfolio/assumption 恢复之前调用，
 * 自定义股票才能参与真实日线同步，且观察仓与已保存假设能正确回挂。
 * 日线缓存缺失时用平价占位序列兜底（下次行情同步成功即被真实日线替换）。
 */
export function hydrateStocks(state: DemoState, persisted: PersistedStocks | null): void {
  if (!persisted) return;
  for (const record of persisted.stocks) {
    if (record.disabled) {
      removeStockFromState(state, record.symbol);
      continue;
    }
    if (record.kind !== 'custom' || state.stocks.has(record.symbol)) continue;
    let bars = loadAllBars([record.symbol]).get(record.symbol);
    if (!bars || bars.length < 20) {
      console.warn(
        `自定义股票 ${record.symbol} 日线缓存缺失，先用平价占位序列（行情源可用后自动刷新）`,
      );
      bars = synthesizeFlatHistory(record.price > 0 ? record.price : 1);
    }
    try {
      registerStockIntoState(state, { record, bars, freshBars: false }, { watchlist: false });
    } catch (reason) {
      console.warn(`自定义股票 ${record.symbol} 恢复失败，已跳过：${(reason as Error).message}`);
    }
  }
}

/** 平价占位日线：仅用于缓存缺失的兜底，保证技术指标可计算（布林退化时 %B 取 0.5）。 */
export function synthesizeFlatHistory(price: number, count = 30): PriceBar[] {
  const cursor = Date.parse(`${shanghaiToday()}T00:00:00.000Z`);
  const dates: string[] = [];
  let offset = 0;
  while (dates.length < count) {
    const date = new Date(cursor - offset * 86_400_000);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) {
      dates.push(date.toISOString().slice(0, 10));
    }
    offset += 1;
  }
  return dates.reverse().map((date) => ({
    date,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 0,
  }));
}
