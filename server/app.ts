import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import type {
  CatalogItem,
  DashboardResponse,
  SettingsPatch,
  StockDetailResponse,
  TradeRequest,
} from '../shared/types.ts';
import {
  AS_OF,
  DATA_NOTICE,
  TradeError,
  buildResearchPlan,
  executeTrade,
  getPortfolio,
  refreshStock,
  type DemoState,
} from './engine.ts';

function normalizeSymbol(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function createApp(state: DemoState) {
  const app = express();
  app.use(cors());
  app.use(express.json());

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
      dataMode: 'demo',
      asOf: AS_OF,
      dataNotice: DATA_NOTICE,
    });
  });

  app.get('/api/dashboard', (_req, res) => {
    const response: DashboardResponse = {
      asOf: AS_OF,
      dataMode: 'demo',
      stocks: Array.from(state.watchlist, (symbol) => refreshStock(state, symbol)),
      portfolio: getPortfolio(state),
      risks: state.risks,
      dataNotice: DATA_NOTICE,
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

    const stock = refreshStock(state, symbol);
    const response: StockDetailResponse = {
      stock,
      history: state.histories.get(symbol)!,
      dividends: state.dividends.get(symbol)!,
      plan: buildResearchPlan(stock),
    };
    res.json(response);
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

    const patch = req.body as SettingsPatch;
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
    if (patch.riskVerified !== undefined && typeof patch.riskVerified !== 'boolean') {
      res.status(400).json({ error: 'riskVerified必须为布尔值' });
      return;
    }

    state.stocks.set(symbol, { ...current, ...patch });
    res.json(refreshStock(state, symbol));
  });

  app.post('/api/watchlist', (req, res) => {
    const symbol = normalizeSymbol(req.body?.symbol);
    if (!state.stocks.has(symbol)) {
      res.status(400).json({ error: '股票代码无效' });
      return;
    }
    state.watchlist.add(symbol);
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
    res.json(getCatalog());
  });

  app.post('/api/risk/:id/acknowledge', (req, res) => {
    const risk = state.risks.find((item) => item.id === req.params.id);
    if (!risk) {
      res.status(404).json({ error: '风险事项不存在' });
      return;
    }

    risk.status = 'acknowledged';
    const stock = state.stocks.get(risk.symbol);
    if (stock) {
      stock.riskVerified = true;
      refreshStock(state, stock.symbol);
    }
    res.json(risk);
  });

  app.post('/api/portfolio/trade', (req, res) => {
    try {
      const portfolio = executeTrade(state, req.body as TradeRequest);
      res.json(portfolio);
    } catch (error) {
      if (error instanceof TradeError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.get('/api/export/watchlist', (_req, res) => {
    const headers = [
      'symbol',
      'name',
      'sector',
      'price',
      'forecastDividend',
      'dividendYield',
      'buyThreshold',
      'score',
      'level',
      'action',
      'holdingShares',
      'holdingCost',
    ];
    const rows = Array.from(state.watchlist, (symbol) => {
      const stock = state.stocks.get(symbol)!;
      return [
        stock.symbol,
        stock.name,
        stock.sector,
        stock.price,
        stock.forecastDividend,
        stock.dividendYield,
        stock.buyThreshold,
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
