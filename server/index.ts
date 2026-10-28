import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { createFileAssumptionStore } from './assumption-store.ts';
import { createFileRiskStore } from './risk-store.ts';
import { createFilePortfolioStore } from './portfolio-store.ts';
import { AS_OF, createDemoState } from './engine.ts';

const assumptionFile = fileURLToPath(new URL('./.data/assumptions.json', import.meta.url));
const riskFile = fileURLToPath(new URL('./.data/risks.json', import.meta.url));
const portfolioFile = fileURLToPath(new URL('./.data/portfolio.json', import.meta.url));
const app = createApp(
  createDemoState(),
  createFileAssumptionStore(assumptionFile),
  createFileRiskStore(riskFile),
  createFilePortfolioStore(portfolioFile),
);

app.listen(4174, () => {
  console.log(`演示后端已启动：http://localhost:4174（数据截至${AS_OF}）`);
});
