import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp, DIST_DIR } from './app.ts';
import { createFileAssumptionStore } from './assumption-store.ts';
import { createFileSettingsStore } from './settings-store.ts';
import { createFileRiskStore } from './risk-store.ts';
import { createFilePortfolioStore } from './portfolio-store.ts';
import { createFileStockStore } from './stock-store.ts';
import { hydrateStocks } from './stock-registration.ts';
import { PersistenceError, RiskPersistenceError } from './errors.ts';
import { DEFAULT_HOST, deploymentAuthError, isLoopbackHost, parseAllowedOrigins, parsePublicDeployment } from './security.ts';
import { activateLiveMeta, AS_OF, DATA_META } from './config.ts';
import { createDemoState } from './demo-data.ts';
import { eastmoneyProvider } from './providers/eastmoney.ts';
import { sinaProvider } from './providers/sina.ts';
import { tencentProvider } from './providers/tencent.ts';
import { fetchDailyBarsBatch } from './providers/kline-eastmoney.ts';
import { fetchIndustries } from './providers/industry-eastmoney.ts';
import { fetchDividendEvents } from './providers/tencent-fqkline.ts';
import { loadDividendEventsFile, saveDividendEvents } from './dividend-event-store.ts';
import { applyDividendHistory } from './dividend-history.ts';
import { ensureTradingCalendar, refreshTradingCalendar } from './trading-calendar.ts';
import { createQuoteService } from './quote-service.ts';
import { startQuoteScheduler } from './quote-scheduler.ts';
import { applyQuoteToHistory, loadAllBars, saveBars } from './bar-store.ts';
import { loadLatestQuotes, saveLatestQuotes } from './quote-store.ts';
import { collectPortfolioSymbols } from './state-change.ts';
import type { QuoteProvider, QuoteSource } from '../shared/quote-types.ts';
import type { PriceBar } from '../shared/types.ts';

/** 加载 .env（可选；缺失时静默跳过，例如 LIXINGER_TOKEN 等备用源凭证）。 */
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  /* 没有 .env 是正常情况 */
}

const assumptionFile = fileURLToPath(new URL('./.data/assumptions.json', import.meta.url));
const settingsFile = fileURLToPath(new URL('./.data/settings.json', import.meta.url));
const riskFile = fileURLToPath(new URL('./.data/risks.json', import.meta.url));
const portfolioFile = fileURLToPath(new URL('./.data/portfolio.json', import.meta.url));
const stockFile = fileURLToPath(new URL('./.data/stocks.json', import.meta.url));

const state = createDemoState();
/** 动态添加股票的落盘：必须在行情装配前恢复，自定义股票才能参与真实日线同步。 */
const stockStore = createFileStockStore(stockFile);

/** live 模式就绪标志：真实日线装配成功后才允许实时价覆盖日线（避免污染演示序列）。 */
let liveActive = false;

/** 分红事件同步窗口（年）：够覆盖「连续 N 年」的真实回溯，同时控制启动耗时。 */
const DIVIDEND_EVENT_YEARS = 15;
/** 分红事件缓存新鲜度：7 天内视为有效，跳过重新同步（分红是低频数据）。 */
const DIVIDEND_SYNC_FRESH_MS = 7 * 86_400_000;

/** 上海时区今日（YYYY-MM-DD）。 */
function shanghaiToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** 行业分类真实化：东财 f100 覆盖种子 sector；个别失败保留原值。 */
async function refreshSectors(): Promise<void> {
  const symbols = Array.from(state.stocks.keys());
  try {
    const industries = await fetchIndustries(symbols);
    let updated = 0;
    for (const [symbol, industry] of industries) {
      const stock = state.stocks.get(symbol);
      if (stock && stock.sector !== industry) {
        stock.sector = industry;
        updated += 1;
      }
    }
    console.log(`行业分类已同步（东财 f100）：${updated} 只更新`);
  } catch (reason) {
    console.warn(`行业分类同步失败，保留现有口径：${(reason as Error).message}`);
  }
}

/**
 * 真实日线装配（P1）：
 * - bars 落盘缓存已含今日 → 直接复用，跳过 kline 同步；
 * - 否则拉东财前复权日线覆盖 state.histories 并落盘；
 * - 全部成功才 activateLiveMeta 切 live；任何失败保留演示数据（fail-safe 回 demo）。
 * 研究口径（预测分红/质量/ROE）不在此范围内：它们是用户假设，与行情真实化解耦。
 */
async function prepareLiveHistory(): Promise<boolean> {
  const symbols = Array.from(state.stocks.keys());
  const today = shanghaiToday();
  const cached = loadAllBars(symbols);
  const cachedFresh = symbols.every((symbol) => {
    const bars = cached.get(symbol);
    return bars !== undefined && (bars[bars.length - 1]?.date ?? '') >= today;
  });

  let barsBySymbol: Map<string, PriceBar[]>;
  if (cachedFresh) {
    barsBySymbol = cached;
    console.log(`日线缓存已含 ${today}，跳过 kline 同步`);
  } else {
    console.log('正在同步真实日线（东方财富，前复权）…');
    const { bars, errors } = await fetchDailyBarsBatch(symbols);
    if (errors.length > 0 || bars.size !== symbols.length) {
      console.warn(`真实日线同步失败，继续使用演示数据：${errors.join('；') || '部分标的缺失'}`);
      return false;
    }
    barsBySymbol = bars;
    for (const [symbol, bars] of barsBySymbol) saveBars(symbol, bars);
    console.log(`真实日线同步完成：${bars.size} 只 × ${bars.get(symbols[0]!)?.length ?? 0} 根`);
  }

  for (const [symbol, bars] of barsBySymbol) state.histories.set(symbol, bars);
  const latestDate = barsBySymbol.get(symbols[0]!)?.at(-1)?.date ?? today;
  activateLiveMeta(`${latestDate} 前复权日线`);
  return true;
}

/**
 * 实时行情配置（全部可选，缺省值见 quote-service；未配置任何环境变量即可用免费源跑通）。
 * QUOTE_ENABLE_INTRADAY 只控制后台预取轮询；/api/quotes 的按需拉取始终可用。
 */
const QUOTE_SOURCE_ENV = process.env.QUOTE_PROVIDER?.trim();
const QUOTE_FALLBACKS_ENV = process.env.QUOTE_FALLBACKS?.trim();
const providers = new Map<QuoteSource, QuoteProvider>([
  ['tencent', tencentProvider],
  ['sina', sinaProvider],
  ['eastmoney', eastmoneyProvider],
]);
const fallbackOrder = (QUOTE_FALLBACKS_ENV ?? QUOTE_SOURCE_ENV ?? 'tencent,sina,eastmoney')
  .split(',')
  .map((source) => source.trim())
  .filter((source): source is QuoteSource => providers.has(source as QuoteSource));
if (fallbackOrder.length === 0) {
  console.error('拒绝启动：QUOTE_FALLBACKS/QUOTE_PROVIDER 未匹配到任何已注册行情源。');
  process.exit(1);
}
const quoteService = createQuoteService(providers, {
  // 动态读取：activateLiveMeta 在启动装配阶段才把 DATA_META 切到 live。
  dataMode: () => DATA_META.dataMode,
  fallbackOrder,
  ttlMs: Number(process.env.QUOTE_CACHE_TTL_MS) || 5_000,
  closedTtlMs: Number(process.env.QUOTE_CLOSED_TTL_MS) || 300_000,
  staleMs: Number(process.env.QUOTE_STALE_MS) || 60_000,
  requestTimeoutMs: Number(process.env.QUOTE_REQUEST_TIMEOUT_MS) || 8_000,
  ratePerSecond: Number(process.env.QUOTE_RATE_PER_SECOND) || 2,
  rateCapacity: Number(process.env.QUOTE_RATE_CAPACITY) || 5,
  breakerThreshold: Number(process.env.QUOTE_BREAKER_THRESHOLD) || 5,
  breakerOpenMs: Number(process.env.QUOTE_BREAKER_OPEN_MS) || 30_000,
  // 每批行情写入缓存后：落盘最新快照（重启预热）；live 模式下同时把实时价覆盖进当日日线，
  // 雷达的 price/changePct/股息率与评分即随行情重算（方案 A，见 docs/live-data-integration.md §5.6）。
  onUpdate: (quotes) => {
    saveLatestQuotes(quotes);
    if (!liveActive) return;
    for (const quote of quotes) {
      const current = state.histories.get(quote.symbol);
      if (current) {
        const next = applyQuoteToHistory(current, quote);
        if (next !== current) state.histories.set(quote.symbol, next);
      }
      // PE/PB 随行情快照动态更新（腾讯 f39/f46，实测口径与理杏仁一致）；异常值不覆盖。
      const stock = state.stocks.get(quote.symbol);
      if (stock) {
        if (quote.pe != null && quote.pe > 0) stock.pe = quote.pe;
        if (quote.pb != null && quote.pb > 0) stock.pb = quote.pb;
      }
    }
  },
  // 重启预热：上游暂时不可用时 getSnapshot 仍返回上次真实快照（陈旧度如实标注）。
  seed: loadLatestQuotes(),
});
const quotePollIntervalMs = Number(process.env.QUOTE_POLL_INTERVAL_MS) || 15_000;
const intradayEnabled = process.env.QUOTE_ENABLE_INTRADAY === 'true';

/** 前后端分离部署使用 --api-only：只提供 /api，前端产物另行托管。 */
const apiOnly = process.argv.includes('--api-only');
const port = Number(process.env.PORT) || 4174;
/** 默认只监听回环地址；跨设备/局域网使用需显式设置 HOST，并同时配置 ACCESS_TOKEN 与 ALLOWED_ORIGINS。 */
const host = process.env.HOST?.trim() || DEFAULT_HOST;
const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const accessToken = process.env.ACCESS_TOKEN?.trim() ?? '';
/** 反向代理/公网部署必须显式声明：此时 HOST 仍可能是回环地址，不能据此判定无需认证。 */
const publicDeployment = parsePublicDeployment(process.env.PUBLIC_DEPLOYMENT);

const authError = deploymentAuthError(host, accessToken, publicDeployment);
if (authError) {
  console.error(authError);
  process.exit(1);
}

if (publicDeployment && allowedOrigins.length === 0) {
  console.warn(
    [
      '警告：已声明公开部署，但未设置 ALLOWED_ORIGINS。',
      '浏览器同源写请求（POST/PATCH/DELETE）会携带公开域名作为 Origin，',
      '来源守卫会将其判为不可信并返回 403；请把对外域名加入 ALLOWED_ORIGINS。',
    ].join('\n'),
  );
}

/**
 * 只有在风险文件不存在（首次启动）时才允许使用演示种子。
 * 文件存在但损坏时必须 fail-closed：拒绝启动并保持原文件不动，
 * 否则后续写盘会用演示状态覆盖真实的高风险记录。
 */
async function start(): Promise<void> {
  /** 恢复动态添加的自定义股票，并把停用记录从演示全集拆除（失败关闭：文件损坏拒绝启动）。 */
  try {
    hydrateStocks(state, stockStore.load());
  } catch (error) {
    if (error instanceof PersistenceError) {
      console.error(
        [
          '拒绝启动：股票列表无法安全恢复（文件损坏或不可读）。',
          `原因：${error.message}`,
          '为避免覆盖原文件，服务不会启动。请先备份 server/.data/stocks.json，',
          '修复或移走该文件后重试。',
        ].join('\n'),
      );
      process.exit(1);
    }
    throw error;
  }

  // 真实日线装配失败不阻断启动：自动回退演示数据（dataMode 保持 demo）。
  liveActive = await prepareLiveHistory();

  if (liveActive) {
    // 交易日历（腾讯 fqkline 指数成交日）：失败静默，回退「只判周末」并靠陈旧度兜底。
    const calendarOk = await refreshTradingCalendar();
    console.log(calendarOk ? '交易日历已同步（节假日判定启用）' : '交易日历同步失败，节假日暂按周末口径判定');
    // 行业分类真实化（东财 f100）：失败保留种子口径。
    await refreshSectors();
    // 分红事件（腾讯 fqkline 免费路线）：落盘缓存供研究口径接入，失败不阻断。
    // 7 天内同步过的直接复用缓存：分红是低频数据，避免每次启动都重拉 15 年事件。
    let synced = 0;
    let reused = 0;
    let failedSymbols: string[] = [];
    for (const symbol of state.stocks.keys()) {
      const cached = loadDividendEventsFile(symbol);
      const cachedAt = cached ? Date.parse(cached.syncedAt) : NaN;
      if (Number.isFinite(cachedAt) && Date.now() - cachedAt < DIVIDEND_SYNC_FRESH_MS) {
        reused += 1;
        continue;
      }
      // 单只失败只记录并继续，不中断整轮同步（一只失败不应拖垮其余股票）。
      try {
        saveDividendEvents(symbol, await fetchDividendEvents(symbol, DIVIDEND_EVENT_YEARS));
        synced += 1;
      } catch (reason) {
        failedSymbols.push(symbol);
        console.warn(`分红事件同步失败（${symbol}）：${(reason as Error).message}`);
      }
    }
    console.log(
      `分红事件已同步（近${DIVIDEND_EVENT_YEARS}年）：${synced} 只，缓存复用 ${reused} 只` +
        `${failedSymbols.length ? `，失败 ${failedSymbols.length} 只` : ''}`,
    );
  }

  // 真实分红历史接入研究口径：只依赖落盘缓存（不要求 live 模式），
  // 无缓存或事件不含已完结年度的股票保持原口径（种子/空），页面脚注如实标注。
  let dividendApplied = 0;
  for (const symbol of state.stocks.keys()) {
    const snapshot = loadDividendEventsFile(symbol);
    if (snapshot && applyDividendHistory(state, symbol, snapshot.events, snapshot.syncedAt)) {
      dividendApplied += 1;
    }
  }
  console.log(
    dividendApplied > 0
      ? `真实分红历史已接入（腾讯fqkline）：${dividendApplied}/${state.stocks.size} 只`
      : '真实分红历史不可用，保持演示口径',
  );

  /** 收盘固化：先刷一次终值（覆盖当日 bar），再把全部日线落盘。 */
  const persistEodBars = async () => {
    if (!liveActive) return;
    await quoteService.refresh(collectPortfolioSymbols(state));
    for (const [symbol, bars] of state.histories) saveBars(symbol, bars);
    console.log(`已固化当日收盘日线（${state.histories.size} 只）`);
  };

  let app: ReturnType<typeof createApp>;
  try {
    app = createApp(
      state,
      createFileAssumptionStore(assumptionFile),
      createFileRiskStore(riskFile),
      createFilePortfolioStore(portfolioFile),
      { serveStatic: !apiOnly, allowedOrigins, accessToken, quoteService, settingsStore: createFileSettingsStore(settingsFile), stockStore },
    );
  } catch (error) {
    if (error instanceof PersistenceError) {
      console.error(
        [
          error instanceof RiskPersistenceError
            ? '拒绝启动：风险核验数据无法安全恢复（文件损坏或不可读）。'
            : '拒绝启动：研究数据无法安全恢复（文件损坏或不可读）。',
          `原因：${error.message}`,
          '为避免用演示状态覆盖原文件，服务不会启动，也不会写入任何数据。',
          '请先备份 server/.data 下对应文件，修复或用可信备份替换后重试；',
          '如确认放弃该文件内容，请手工移走它，让服务以演示状态重新初始化。',
        ].join('\n'),
      );
      process.exit(1);
    }
    throw error;
  }

  app.listen(port, host, () => {
    const mode = apiOnly
      ? '仅API（前后端分离）'
      : existsSync(DIST_DIR)
        ? 'API + 前端静态托管（一体化）'
        : '仅API（未找到dist，请先执行 npm run build）';
    const displayHost = isLoopbackHost(host) ? 'localhost' : host;
    console.log(`后端已启动：http://${displayHost}:${port}（${mode}）`);
    console.log(
      `数据模式：${DATA_META.dataMode === 'live' ? `真实行情 · ${DATA_META.quoteTime}` : `演示数据 · 截至${AS_OF}`}` +
        `；行情源 ${fallbackOrder.join(' → ')}` +
        `；${intradayEnabled || liveActive ? `预取调度开启（${quotePollIntervalMs}ms）` : '按需拉取'}`,
    );
    // live 模式下即使不开启盘中预取也要挂调度器：收盘边沿触发日线固化。
    if (intradayEnabled || liveActive) {
      startQuoteScheduler(
        quoteService,
        () => collectPortfolioSymbols(state),
        quotePollIntervalMs,
        liveActive ? persistEodBars : undefined,
      );
    }
    if (publicDeployment) {
      console.log(
        `公开部署模式（PUBLIC_DEPLOYMENT）：所有 /api 请求需携带 Authorization: Bearer <ACCESS_TOKEN>；` +
          `允许来源：${['回环地址', ...allowedOrigins].join('、')}。`,
      );
    } else if (isLoopbackHost(host)) {
      console.log(`监听地址 ${host}：仅本机可访问，来源白名单为本机回环地址。`);
    } else {
      console.log(
        `监听地址 ${host}：所有 /api 请求需携带 Authorization: Bearer <ACCESS_TOKEN>；` +
          `允许来源：${['回环地址', ...allowedOrigins].join('、')}。`,
      );
    }
  });
}

start().catch((error: unknown) => {
  console.error('启动失败：', (error as Error).message);
  process.exit(1);
});
