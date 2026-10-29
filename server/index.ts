import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp, DIST_DIR } from './app.ts';
import { createFileAssumptionStore } from './assumption-store.ts';
import { createFileRiskStore } from './risk-store.ts';
import { createFilePortfolioStore } from './portfolio-store.ts';
import { DEFAULT_HOST, isLoopbackHost, parseAllowedOrigins } from './security.ts';
import { AS_OF } from './config.ts';
import { createDemoState } from './demo-data.ts';

const assumptionFile = fileURLToPath(new URL('./.data/assumptions.json', import.meta.url));
const riskFile = fileURLToPath(new URL('./.data/risks.json', import.meta.url));
const portfolioFile = fileURLToPath(new URL('./.data/portfolio.json', import.meta.url));

/** 前后端分离部署使用 --api-only：只提供 /api，前端产物另行托管。 */
const apiOnly = process.argv.includes('--api-only');
const port = Number(process.env.PORT) || 4174;
/** 默认只监听回环地址；跨设备/局域网使用需显式设置 HOST，并同时配置 ACCESS_TOKEN 与 ALLOWED_ORIGINS。 */
const host = process.env.HOST?.trim() || DEFAULT_HOST;
const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const accessToken = process.env.ACCESS_TOKEN?.trim() ?? '';

if (!isLoopbackHost(host) && !accessToken) {
  console.error(
    [
      `拒绝启动：HOST=${host} 会暴露到本机之外，但未设置 ACCESS_TOKEN。`,
      '本服务没有用户隔离（组合、观察仓与全部写接口共用一份数据），',
      '因此不允许无认证对外监听。请设置 ACCESS_TOKEN=... 后重试；',
      '多人使用请按人一实例部署，切勿共享同一数据目录。',
    ].join('\n'),
  );
  process.exit(1);
}

const app = createApp(
  createDemoState(),
  createFileAssumptionStore(assumptionFile),
  createFileRiskStore(riskFile),
  createFilePortfolioStore(portfolioFile),
  { serveStatic: !apiOnly, allowedOrigins, accessToken },
);

app.listen(port, host, () => {
  const mode = apiOnly
    ? '仅API（前后端分离）'
    : existsSync(DIST_DIR)
      ? 'API + 前端静态托管（一体化）'
      : '仅API（未找到dist，请先执行 npm run build）';
  const displayHost = isLoopbackHost(host) ? 'localhost' : host;
  console.log(`演示后端已启动：http://${displayHost}:${port}（${mode}，数据截至${AS_OF}）`);
  if (isLoopbackHost(host)) {
    console.log(`监听地址 ${host}：仅本机可访问，来源白名单为本机回环地址。`);
  } else {
    console.log(
      `监听地址 ${host}：所有 /api 请求需携带 Authorization: Bearer <ACCESS_TOKEN>；` +
        `允许来源：${['回环地址', ...allowedOrigins].join('、')}。`,
    );
  }
});
