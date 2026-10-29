import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp, DIST_DIR } from './app.ts';
import { createFileAssumptionStore } from './assumption-store.ts';
import { createFileSettingsStore } from './settings-store.ts';
import { createFileRiskStore } from './risk-store.ts';
import { createFilePortfolioStore } from './portfolio-store.ts';
import { RiskPersistenceError } from './errors.ts';
import { DEFAULT_HOST, deploymentAuthError, isLoopbackHost, parseAllowedOrigins, parsePublicDeployment } from './security.ts';
import { AS_OF, DATA_META } from './config.ts';
import { createDemoState } from './demo-data.ts';
import { eastmoneyProvider } from './providers/eastmoney.ts';
import { sinaProvider } from './providers/sina.ts';
import { tencentProvider } from './providers/tencent.ts';
import { createQuoteService } from './quote-service.ts';
import { startQuoteScheduler } from './quote-scheduler.ts';
import { collectPortfolioSymbols } from './state-change.ts';
import type { QuoteProvider, QuoteSource } from '../shared/quote-types.ts';

const assumptionFile = fileURLToPath(new URL('./.data/assumptions.json', import.meta.url));
const settingsFile = fileURLToPath(new URL('./.data/settings.json', import.meta.url));
const riskFile = fileURLToPath(new URL('./.data/risks.json', import.meta.url));
const portfolioFile = fileURLToPath(new URL('./.data/portfolio.json', import.meta.url));

const state = createDemoState();

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
  dataMode: DATA_META.dataMode,
  fallbackOrder,
  ttlMs: Number(process.env.QUOTE_CACHE_TTL_MS) || 5_000,
  closedTtlMs: Number(process.env.QUOTE_CLOSED_TTL_MS) || 300_000,
  staleMs: Number(process.env.QUOTE_STALE_MS) || 60_000,
  requestTimeoutMs: Number(process.env.QUOTE_REQUEST_TIMEOUT_MS) || 8_000,
  ratePerSecond: Number(process.env.QUOTE_RATE_PER_SECOND) || 2,
  rateCapacity: Number(process.env.QUOTE_RATE_CAPACITY) || 5,
  breakerThreshold: Number(process.env.QUOTE_BREAKER_THRESHOLD) || 5,
  breakerOpenMs: Number(process.env.QUOTE_BREAKER_OPEN_MS) || 30_000,
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
function start(): void {
  let app: ReturnType<typeof createApp>;
  try {
    app = createApp(
      state,
      createFileAssumptionStore(assumptionFile),
      createFileRiskStore(riskFile),
      createFilePortfolioStore(portfolioFile),
      { serveStatic: !apiOnly, allowedOrigins, accessToken, quoteService, settingsStore: createFileSettingsStore(settingsFile) },
    );
  } catch (error) {
    if (error instanceof RiskPersistenceError) {
      console.error(
        [
          '拒绝启动：风险核验数据无法安全恢复（文件损坏或不可读）。',
          `原因：${error.message}`,
          '为避免用演示种子覆盖原文件，服务不会启动，也不会写入任何数据。',
          `请先备份 ${riskFile}，修复或用可信备份替换后重试；`,
          '如确认放弃历史风险记录，请手工移走该文件，让服务以演示种子首次启动。',
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
    console.log(`演示后端已启动：http://${displayHost}:${port}（${mode}，数据截至${AS_OF}）`);
    console.log(
      `实时行情：主源 ${fallbackOrder.join(' → ')}；` +
        (intradayEnabled ? `盘中预取已开启（${quotePollIntervalMs}ms）` : '盘中预取关闭（按需拉取）'),
    );
    if (intradayEnabled) {
      startQuoteScheduler(quoteService, () => collectPortfolioSymbols(state), quotePollIntervalMs);
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

start();
