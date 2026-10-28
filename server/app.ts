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
  SettingsPatch,
  Stock,
  StockDetailResponse,
  TradeRequest,
} from '../shared/types.ts';
import {
  AS_OF,
  AssumptionError,
  DATA_META,
  DATA_NOTICE,
  RISK_POLICY,
  RiskError,
  TradeError,
  addRiskEvent,
  buildAllocation,
  buildResearchPlan,
  dispatchReminder,
  executeTrade,
  getPortfolio,
  getRiskEvents,
  getStockSnapshot,
  hydrateAssumptions,
  hydratePortfolio,
  hydrateRisks,
  parseAssumptionInput,
  previewAssumption,
  resolveAssumption,
  reviewTrades,
  saveAssumption,
  updateRiskSource,
  verifyRisk,
  type DemoState,
} from './engine.ts';
import { createMemoryAssumptionStore, type AssumptionStore } from './assumption-store.ts';
import { createMemoryRiskStore, type RiskStore } from './risk-store.ts';
import {
  createMemoryPortfolioStore,
  type PortfolioStore,
} from './portfolio-store.ts';

function normalizeSymbol(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function createApp(
  state: DemoState,
  store: AssumptionStore = createMemoryAssumptionStore(),
  riskStore: RiskStore = createMemoryRiskStore(),
  portfolioStore: PortfolioStore = createMemoryPortfolioStore(),
) {
  const app = express();
  app.use(cors());
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
    const stock = getStockSnapshot(state, risk.symbol);
    dispatchReminder(state, stock);
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
      const stock = getStockSnapshot(state, symbol);
      dispatchReminder(state, stock);
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

  app.patch('/api/stocks/:symbol/settings', (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const current = state.stocks.get(symbol);
    if (!current) {
      res.status(404).json({ error: '股票代码不存在' });
      return;
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: '请求体必须为JSON对象' });
      return;
    }

    const patch = req.body as SettingsPatch & { riskVerified?: unknown };
    if (patch.riskVerified !== undefined) {
      res.status(400).json({ error: '风险状态由风险事件核验派生，请在风险哨兵中逐条核验' });
      return;
    }
    if (
      patch.buyThreshold !== undefined &&
      (typeof patch.buyThreshold !== 'number' ||
        !Number.isFinite(patch.buyThreshold) ||
        patch.buyThreshold < 3 ||
        patch.buyThreshold > 10)
    ) {
      res.status(400).json({ error: 'buyThreshold必须在3到10之间' });
      return;
    }

    state.stocks.set(symbol, { ...current, buyThreshold: patch.buyThreshold ?? current.buyThreshold });
    const saved = state.assumptions.get(symbol);
    if (patch.buyThreshold !== undefined && saved) {
      saveAssumption(state, symbol, {
        forecastYear: saved.forecastYear,
        scenario: saved.scenario,
        requiredYield: patch.buyThreshold,
      });
      persistAssumptions();
    }
    const stock = getStockSnapshot(state, symbol);
    dispatchReminder(state, stock);
    res.json(stock);
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
      const portfolio = executeTrade(state, req.body as TradeRequest);
      persistPortfolio();
      res.json(portfolio);
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
      })
      .send(`\uFEFF${csv}`);
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

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
