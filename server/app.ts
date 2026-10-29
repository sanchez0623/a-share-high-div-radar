import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import type {
  AssumptionPreviewResponse,
  CatalogItem,
  DashboardResponse,
  RiskEvent,
  RiskEventInput,
  RiskMutationResponse,
  RiskSourcePatch,
  RiskVerificationInput,
  Stock,
  StockDetailResponse,
  TradeRequest,
  TradeResponse,
} from '../shared/types.ts';
import {
  hydrateAssumptions,
  parseAssumptionInput,
  previewAssumption,
  resolveAssumption,
  saveAssumption,
} from './assumptions.ts';
import { AS_OF, DATA_META, DATA_NOTICE } from './config.ts';
import { AssumptionError, RiskError, SettingsError, TradeError } from './errors.ts';
import { buildAllocation, executeTrade, getPortfolio, hydratePortfolio } from './portfolio.ts';
import { buildResearchPlan } from './research.ts';
import { getRiskEvents, RISK_POLICY } from './risk-model.ts';
import { addRiskEvent, hydrateRisks, updateRiskSource, verifyRisk } from './risk-actions.ts';
import { createOriginGuard, createTokenGuard, isAllowedOrigin } from './security.ts';
import { updateStockSettings } from './settings.ts';
import { getStockSnapshot } from './snapshot.ts';
import { commitPortfolioChange, commitResearchChange, collectPortfolioSymbols } from './state-change.ts';
import { reviewTrades } from './trade-review.ts';
import type { DemoState } from './state.ts';
import { createMemoryAssumptionStore, type AssumptionStore } from './assumption-store.ts';
import { createMemoryRiskStore, type RiskStore } from './risk-store.ts';
import {
  createMemoryPortfolioStore,
  type PortfolioStore,
} from './portfolio-store.ts';

function normalizeSymbol(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

/** vite build 产物目录：一体化部署时由 Express 直接托管。 */
export const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url));

export interface AppOptions {
  /** 是否托管 vite build 产物；前后端分离部署时关闭。 */
  serveStatic?: boolean;
  /** 额外允许的浏览器来源（独立前端域名）；缺省只放行本机回环来源。 */
  allowedOrigins?: string[];
  /** 访问令牌；配置后所有 /api 请求必须携带，绑定非回环地址时必填。 */
  accessToken?: string;
}

export function createApp(
  state: DemoState,
  store: AssumptionStore = createMemoryAssumptionStore(),
  riskStore: RiskStore = createMemoryRiskStore(),
  portfolioStore: PortfolioStore = createMemoryPortfolioStore(),
  options: AppOptions = {},
) {
  const app = express();
  const extraOrigins = options.allowedOrigins ?? [];
  app.disable('x-powered-by');
  /** 先拦来源再交给 cors：预检请求同样按白名单拒绝，浏览器拿不到任何响应头。 */
  app.use('/api', createOriginGuard(extraOrigins));
  app.use(cors({ origin: (origin, callback) => callback(null, isAllowedOrigin(origin, extraOrigins)) }));
  /** 预检不带令牌，cors 已在此前结束 OPTIONS，因此令牌只约束真实请求。 */
  app.use('/api', createTokenGuard(options.accessToken ?? ''));
  app.use(express.json());

  hydrateAssumptions(state, store.load());
  hydrateRisks(state, riskStore.load());
  hydratePortfolio(state, portfolioStore.load());

  function persistAssumptions(): void {
    store.save(Array.from(state.assumptions.values()));
  }

  function persistRisks(): void {
    riskStore.save(state.risks);
  }

  function persistPortfolio(): void {
    portfolioStore.save({
      watchlist: Array.from(state.watchlist),
      cash: state.cash,
      holdings: Array.from(state.holdings, ([symbol, holding]) => ({
        symbol,
        shares: holding.shares,
        cost: holding.cost,
        assumptionVersion: holding.assumptionVersion,
      })),
      trades: state.trades,
    });
  }

  /** 风险写操作统一返回最新风险事件与重算后的股票闸门。 */
  function respondWithRisk(res: Response, risk: RiskEvent): void {
    const { stock } = commitResearchChange(state, risk.symbol);
    const response: RiskMutationResponse = { risk, stock };
    res.json(response);
  }

  function buildDetail(stock: Stock, budget?: number): StockDetailResponse {
    const assumption = resolveAssumption(state, stock.symbol);
    const plan = buildResearchPlan(stock, assumption);
    return {
      stock,
      history: state.histories.get(stock.symbol)!,
      dividends: state.dividends.get(stock.symbol)!,
      plan,
      assumption,
      assumptionSaved: state.assumptions.has(stock.symbol),
      /** 分配：以已到账现金、最低储备与集中度上限为约束；budget 缺省用可投入现金。 */
      allocation: buildAllocation(state, stock.symbol, plan, budget),
    };
  }

  function getCatalog(): CatalogItem[] {
    return Array.from(state.stocks.values(), (stock) => ({
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      inWatchlist: state.watchlist.has(stock.symbol),
    }));
  }

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      dataMode: DATA_META.dataMode,
      asOf: AS_OF,
      dataNotice: DATA_NOTICE,
      dataMeta: DATA_META,
    });
  });

  app.get('/api/dashboard', (_req, res) => {
    const response: DashboardResponse = {
      asOf: AS_OF,
      dataMode: 'demo',
      stocks: Array.from(state.watchlist, (symbol) => getStockSnapshot(state, symbol)),
      /** 交易候选与观察仓分离：移出观察仓的持仓仍必须可卖出。 */
      tradeStocks: collectPortfolioSymbols(state).map((symbol) => getStockSnapshot(state, symbol)),
      portfolio: getPortfolio(state),
      risks: getRiskEvents(state),
      riskPolicy: RISK_POLICY,
      dataNotice: DATA_NOTICE,
      dataMeta: DATA_META,
    };
    res.json(response);
  });

  app.get('/api/catalog', (_req, res) => {
    const response: CatalogItem[] = getCatalog();
    res.json(response);
  });

  app.get('/api/stocks/:symbol', (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    if (!state.stocks.has(symbol)) {
      res.status(404).json({ error: '股票代码不存在' });
      return;
    }

    const rawBudget = typeof req.query.budget === 'string' ? Number(req.query.budget) : NaN;
    const budget = Number.isFinite(rawBudget) && rawBudget >= 0 ? rawBudget : undefined;
    res.json(buildDetail(getStockSnapshot(state, symbol), budget));
  });

  app.post('/api/stocks/:symbol/assumption', (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    if (!state.stocks.has(symbol)) {
      res.status(404).json({ error: '股票代码不存在' });
      return;
    }

    try {
      saveAssumption(state, symbol, parseAssumptionInput(req.body));
      persistAssumptions();
      const { stock } = commitResearchChange(state, symbol);
      res.json(buildDetail(stock));
    } catch (error) {
      if (error instanceof AssumptionError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.post('/api/stocks/:symbol/assumption/preview', (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    if (!state.stocks.has(symbol)) {
      res.status(404).json({ error: '股票代码不存在' });
      return;
    }

    try {
      const preview: AssumptionPreviewResponse = previewAssumption(
        state,
        symbol,
        parseAssumptionInput(req.body),
      );
      res.json(preview);
    } catch (error) {
      if (error instanceof AssumptionError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  /** 设置项写操作：统一走 DTO 校验、白名单更新与结论重算，杜绝批量赋值。 */
  app.patch('/api/stocks/:symbol/settings', (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    if (!state.stocks.has(symbol)) {
      res.status(404).json({ error: '股票代码不存在' });
      return;
    }

    try {
      const { assumptionUpdated } = updateStockSettings(state, symbol, req.body);
      if (assumptionUpdated) persistAssumptions();
      const { stock } = commitResearchChange(state, symbol);
      res.json(stock);
    } catch (error) {
      if (error instanceof SettingsError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.post('/api/watchlist', (req, res) => {
    const symbol = normalizeSymbol(req.body?.symbol);
    if (!state.stocks.has(symbol)) {
      res.status(400).json({ error: '股票代码无效' });
      return;
    }
    state.watchlist.add(symbol);
    persistPortfolio();
    res.json(getCatalog());
  });

  app.delete('/api/watchlist/:symbol', (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    if (!state.stocks.has(symbol)) {
      res.status(404).json({ error: '股票代码不存在' });
      return;
    }
    if (state.watchlist.size === 1 && state.watchlist.has(symbol)) {
      res.status(409).json({ error: '观察仓至少需要保留一只股票' });
      return;
    }
    state.watchlist.delete(symbol);
    persistPortfolio();
    res.json(getCatalog());
  });

  /** 逐条记录人工核验：备注必填、高风险必须留证据、有效期由公开政策决定。 */
  app.post('/api/risk/:id/verify', (req, res) => {
    if (!state.risks.some((item) => item.id === req.params.id)) {
      res.status(404).json({ error: '风险事项不存在' });
      return;
    }
    try {
      const risk = verifyRisk(state, req.params.id, req.body as RiskVerificationInput);
      persistRisks();
      respondWithRisk(res, risk);
    } catch (error) {
      if (error instanceof RiskError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  /** 登记新的风险事项；高风险会让该股票既有核验全部失效。 */
  app.post('/api/risk', (req, res) => {
    try {
      const risk = addRiskEvent(state, req.body as RiskEventInput);
      persistRisks();
      respondWithRisk(res, risk);
    } catch (error) {
      if (error instanceof RiskError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  /** 原文更新：版本号递增，本条风险的核验随即失效。 */
  app.patch('/api/risk/:id/source', (req, res) => {
    if (!state.risks.some((item) => item.id === req.params.id)) {
      res.status(404).json({ error: '风险事项不存在' });
      return;
    }
    try {
      const risk = updateRiskSource(state, req.params.id, req.body as RiskSourcePatch);
      persistRisks();
      respondWithRisk(res, risk);
    } catch (error) {
      if (error instanceof RiskError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.post('/api/portfolio/trade', (req, res) => {
    try {
      executeTrade(state, req.body as TradeRequest);
      persistPortfolio();
      /** 现金与持仓已变化：统一重算组合账本与派生快照，响应直接携带最新评分。 */
      const { portfolio, stocks } = commitPortfolioChange(state);
      const response: TradeResponse = { ...portfolio, stocks };
      res.json(response);
    } catch (error) {
      if (error instanceof TradeError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.get('/api/portfolio/review', (_req, res) => {
    res.json(reviewTrades(state));
  });

  app.get('/api/export/watchlist', (_req, res) => {
    const headers = [
      'symbol',
      'name',
      'sector',
      'price',
      'forecastDividend',
      'forecastYear',
      'forecastSource',
      'reportPeriod',
      'dividendYield',
      'buyThreshold',
      'payoutRatio',
      'fcfCoverage',
      'qualityStatus',
      'score',
      'level',
      'action',
      'holdingShares',
      'holdingCost',
    ];
    const rows = Array.from(state.watchlist, (symbol) => {
      const stock = getStockSnapshot(state, symbol);
      return [
        stock.symbol,
        stock.name,
        stock.sector,
        stock.price,
        stock.forecastDividend,
        stock.dividendForecast.year,
        stock.dividendForecast.source,
        stock.dividendForecast.reportPeriod,
        stock.dividendYield,
        stock.buyThreshold,
        stock.dividendQuality.payoutRatio,
        stock.dividendQuality.freeCashFlowCoverage,
        stock.dividendQuality.status,
        stock.score,
        stock.level,
        stock.action,
        stock.holdingShares,
        stock.holdingCost,
      ];
    });
    const escapeCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
    const csv = [headers, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n');

    res
      .status(200)
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="watchlist-${AS_OF}.csv"`,
        /** 评分含现金信号：交易后必须按最新账本重算，禁止浏览器复用旧文件。 */
        'Cache-Control': 'no-store',
      })
      .send(`\uFEFF${csv}`);
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  /**
   * 一体化部署：Express 同时托管 API 与 vite build 产物（dist）。
   * 前后端分离时以 --api-only 关闭，前端产物交由网关或静态服务器托管，/api 反向代理到本服务。
   */
  if (options.serveStatic !== false) {
    if (existsSync(DIST_DIR)) {
      app.use(express.static(DIST_DIR, { index: false }));
      /** SPA 回退：非 API 的 GET/HEAD 一律返回 index.html，交由前端路由处理。 */
      app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          next();
          return;
        }
        if (req.path.startsWith('/api')) {
          next();
          return;
        }
        res.sendFile(path.join(DIST_DIR, 'index.html'));
      });
    }
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: 'JSON格式无效' });
      return;
    }
    console.error(error);
    res.status(500).json({ error: '服务器内部错误' });
  });

  return app;
}
