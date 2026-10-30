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
  StockRegistrationInput,
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
import { AS_OF, DATA_META, DATA_NOTICE, getDataNotice } from './config.ts';
import { AssumptionError, RiskError, SettingsError, StockError, TradeError } from './errors.ts';
import { isSeedStock } from './demo-data.ts';
import { buildAllocation, executeTrade, getPortfolio, hydratePortfolio } from './portfolio.ts';
import { buildResearchPlan } from './research.ts';
import { getRiskEvents, RISK_POLICY } from './risk-model.ts';
import { addRiskEvent, hydrateRisks, updateRiskSource, verifyRisk } from './risk-actions.ts';
import { createOriginGuard, createTokenGuard, isAllowedOrigin } from './security.ts';
import { collectSettings, hydrateSettings, updateStockSettings } from './settings.ts';
import { createMemorySettingsStore, type SettingsStore } from './settings-store.ts';
import { getStockSnapshot } from './snapshot.ts';
import type { QuoteService } from './quote-service.ts';
import { saveBars } from './bar-store.ts';
import {
  defaultStockDataDeps,
  parseStockRegistrationInput,
  prepareNewStock,
  prepareRestore,
  registerStockIntoState,
  removeStockFromState,
  type StockRegistrationDeps,
} from './stock-registration.ts';
import {
  createMemoryStockStore,
  type PersistedStockRecord,
  type StockStore,
} from './stock-store.ts';
import { commitPortfolioChange, commitResearchChange, collectPortfolioSymbols } from './state-change.ts';
import { reviewTrades } from './trade-review.ts';
import { cloneDemoState, commitDemoState, type DemoState } from './state.ts';
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
  /** 实时行情服务；未提供时 /api/quotes 返回 503。 */
  quoteService?: QuoteService;
  /** 设置项（买入门槛）的持久化存储；缺省仅写入内存。 */
  settingsStore?: SettingsStore;
  /** 动态添加股票的落盘存储；缺省仅写入内存（启动装配由 index.ts 在 createApp 之前完成）。 */
  stockStore?: StockStore;
  /** 添加/恢复股票的数据源；缺省走东财日线 + 腾讯行情，测试注入假实现。 */
  stockDataDeps?: StockRegistrationDeps;
}

/** /api/quotes 单次请求的标的数上限；观察仓远小于该值，仅防滥用。 */
const MAX_QUOTE_SYMBOLS = 50;

export function createApp(
  state: DemoState,
  store: AssumptionStore = createMemoryAssumptionStore(),
  riskStore: RiskStore = createMemoryRiskStore(),
  portfolioStore: PortfolioStore = createMemoryPortfolioStore(),
  options: AppOptions = {},
) {
  const app = express();
  const extraOrigins = options.allowedOrigins ?? [];
  const settingsStore = options.settingsStore ?? createMemorySettingsStore();
  const stockStore = options.stockStore ?? createMemoryStockStore();
  const stockDataDeps = options.stockDataDeps ?? defaultStockDataDeps;
  app.disable('x-powered-by');
  /** 先拦来源再交给 cors：预检请求同样按白名单拒绝，浏览器拿不到任何响应头。 */
  app.use('/api', createOriginGuard(extraOrigins));
  /** 跨源下载需要读取文件名：不暴露 Content-Disposition 时会退回固定文件名。 */
  app.use(
    cors({
      origin: (origin, callback) => callback(null, isAllowedOrigin(origin, extraOrigins)),
      exposedHeaders: ['Content-Disposition'],
    }),
  );
  /** 预检不带令牌，cors 已在此前结束 OPTIONS，因此令牌只约束真实请求。 */
  app.use('/api', createTokenGuard(options.accessToken ?? ''));
  app.use(express.json());

  /** 门槛先于假设恢复：已保存假设的 requiredYield 会覆盖同一标的的门槛。 */
  hydrateSettings(state, settingsStore.load());
  hydrateAssumptions(state, store.load());
  hydrateRisks(state, riskStore.load());
  hydratePortfolio(state, portfolioStore.load());

  function persistAssumptions(target: DemoState): void {
    store.save(Array.from(target.assumptions.values()));
  }

  function persistSettings(target: DemoState): void {
    settingsStore.save(collectSettings(target));
  }

  function persistRisks(target: DemoState): void {
    riskStore.save(target.risks);
  }

  function persistPortfolio(target: DemoState): void {
    portfolioStore.save({
      watchlist: Array.from(target.watchlist),
      cash: target.cash,
      holdings: Array.from(target.holdings, ([symbol, holding]) => ({
        symbol,
        shares: holding.shares,
        cost: holding.cost,
        assumptionVersion: holding.assumptionVersion,
      })),
      trades: target.trades,
    });
  }

  /**
   * 写路由的唯一事务边界：变更只作用于状态副本，落盘成功后才提交到内存。
   * 落盘失败（磁盘满、只读目录等）会抛出并由错误中间件返回 500，
   * 此时内存仍为变更前的状态，客户端重试不会重复记账或叠加版本号。
   */
  function runWrite<T>(
    mutate: (draft: DemoState) => T,
    persist: (draft: DemoState, result: T) => void,
  ): T {
    const draft = cloneDemoState(state);
    const result = mutate(draft);
    persist(draft, result);
    commitDemoState(state, draft);
    return result;
  }

  /** 风险写操作统一返回最新风险事件与重算后的股票闸门。 */
  function buildRiskMutation(target: DemoState, risk: RiskEvent): RiskMutationResponse {
    const { stock } = commitResearchChange(target, risk.symbol);
    return { risk, stock };
  }

  function buildDetail(target: DemoState, stock: Stock, budget?: number): StockDetailResponse {
    const assumption = resolveAssumption(target, stock.symbol);
    const plan = buildResearchPlan(stock, assumption);
    return {
      stock,
      history: target.histories.get(stock.symbol)!,
      dividends: target.dividends.get(stock.symbol)!,
      plan,
      assumption,
      assumptionSaved: target.assumptions.has(stock.symbol),
      /** 分配：以已到账现金、最低储备与集中度上限为约束；budget 缺省用可投入现金。 */
      allocation: buildAllocation(target, stock, plan, budget),
    };
  }

  function getCatalog(target: DemoState, includeDisabled = false): CatalogItem[] {
    const items: CatalogItem[] = Array.from(target.stocks.values(), (stock) => ({
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      inWatchlist: target.watchlist.has(stock.symbol),
      enabled: true,
    }));
    if (!includeDisabled) return items;
    /** 停用记录不在 state 里：从 stocks.json 读取，让管理弹窗能看到并恢复它们。 */
    const disabled = (stockStore.load()?.stocks ?? [])
      .filter((record) => record.disabled && !target.stocks.has(record.symbol))
      .map(
        (record): CatalogItem => ({
          symbol: record.symbol,
          name: record.name,
          sector: record.sector,
          inWatchlist: false,
          enabled: false,
        }),
      );
    return [...items, ...disabled];
  }

  /** stocks.json 的记录级更新入口：load → 变更 → save（单进程内无并发写）。 */
  function mutateStockRecords(
    mutate: (records: PersistedStockRecord[]) => PersistedStockRecord[],
  ): void {
    const current = stockStore.load() ?? { version: 1 as const, stocks: [] };
    stockStore.save({ version: 1, stocks: mutate(current.stocks) });
  }

  function upsertStockRecord(record: PersistedStockRecord): void {
    mutateStockRecords((records) => [
      ...records.filter((item) => item.symbol !== record.symbol),
      record,
    ]);
  }

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      dataMode: DATA_META.dataMode,
      asOf: AS_OF,
      dataNotice: getDataNotice(),
      dataMeta: DATA_META,
    });
  });

  app.get('/api/dashboard', (_req, res) => {
    const response: DashboardResponse = {
      asOf: AS_OF,
      dataMode: DATA_META.dataMode,
      stocks: Array.from(state.watchlist, (symbol) => getStockSnapshot(state, symbol)),
      /** 交易候选与观察仓分离：移出观察仓的持仓仍必须可卖出。 */
      tradeStocks: collectPortfolioSymbols(state).map((symbol) => getStockSnapshot(state, symbol)),
      portfolio: getPortfolio(state),
      risks: getRiskEvents(state),
      riskPolicy: RISK_POLICY,
      dataNotice: getDataNotice(),
      dataMeta: DATA_META,
    };
    res.json(response);
  });

  app.get('/api/catalog', (req, res) => {
    const includeDisabled = req.query.includeDisabled === '1';
    res.json(getCatalog(state, includeDisabled));
  });

  /**
   * 动态添加股票：校验 → 拉取日线与行情 → 注入状态 → 落盘 → 入观察仓。
   * 网络拉取在写事务之前完成；runWrite 内的重复检查保证并发注册只成功一次。
   */
  app.post('/api/stocks', async (req, res) => {
    let input: StockRegistrationInput;
    try {
      input = parseStockRegistrationInput(req.body);
    } catch (error) {
      if (error instanceof StockError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
    if (state.stocks.has(input.symbol)) {
      res.status(409).json({ error: '该股票已在研究列表中' });
      return;
    }
    try {
      const prepared = await prepareNewStock(input, stockDataDeps);
      const stock = runWrite(
        (draft) => {
          registerStockIntoState(draft, prepared, { watchlist: true });
          return getStockSnapshot(draft, input.symbol);
        },
        (draft) => {
          /** 日线先落盘：stocks.json 写失败时只是孤立缓存文件，反过来则会出现无历史的幽灵股票。 */
          saveBars(input.symbol, prepared.bars);
          upsertStockRecord(prepared.record);
          /** 新股票默认加入观察仓：观察仓变更必须与 stocks.json 同步落盘，否则重启后丢失。 */
          persistPortfolio(draft);
        },
      );
      res.json(stock);
    } catch (error) {
      if (error instanceof StockError) {
        res
          .status(error.status)
          .json(error.confirmRequired ? { error: error.message, confirmRequired: true } : { error: error.message });
        return;
      }
      throw error;
    }
  });

  /**
   * 停用 / 恢复（软删除）：停用后从雷达、观察仓与行情轮询中隐藏；
   * 持仓大于 0 的股票不允许停用，避免账本与交易追溯悬空。
   */
  app.patch('/api/stocks/:symbol/status', async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled 必须为布尔值' });
      return;
    }

    try {
      if (!enabled) {
        if (!state.stocks.has(symbol)) {
          res.status(404).json({ error: '股票代码不存在' });
          return;
        }
        if ((state.holdings.get(symbol)?.shares ?? 0) > 0) {
          res.status(409).json({ error: '持仓大于0，请先清仓后再停用' });
          return;
        }
        const result = runWrite(
          (draft) => {
            const stock = draft.stocks.get(symbol)!;
            const existing = stockStore
              .load()
              ?.stocks.find((item) => item.symbol === symbol && item.kind === 'custom' && !item.disabled);
            /** 自定义股票保留完整定义以便恢复；种子只记录「被停用了」。 */
            const record: PersistedStockRecord = existing
              ? { ...existing, disabled: true }
              : {
                  symbol,
                  name: stock.name,
                  kind: isSeedStock(symbol) ? 'seed' : 'custom',
                  disabled: true,
                  sector: stock.sector,
                  addedAt: '',
                  forecastDividend: stock.forecastDividend,
                  buyThreshold: stock.buyThreshold,
                  pe: stock.pe > 0 ? stock.pe : null,
                  pb: stock.pb > 0 ? stock.pb : null,
                  price: stock.price,
                };
            removeStockFromState(draft, symbol);
            /** 停用记录此刻尚未落盘：响应目录直接拼入刚停用的条目，前端可就地置灰。 */
            const disabledItem: CatalogItem = {
              symbol,
              name: stock.name,
              sector: stock.sector,
              inWatchlist: false,
              enabled: false,
            };
            return { catalog: [...getCatalog(draft, true), disabledItem], record };
          },
          (draft, result) => {
            upsertStockRecord(result.record);
            /** 停用会把股票移出观察仓：以 draft 落盘（此刻内存尚未提交），避免重启后观察仓残留不可用代码。 */
            persistPortfolio(draft);
          },
        );
        res.json(result.catalog);
        return;
      }

      /** 恢复：停用的股票不在 state 里，只能从 stocks.json 找到记录。 */
      if (state.stocks.has(symbol)) {
        res.status(409).json({ error: '该股票未处于停用状态' });
        return;
      }
      const record = stockStore.load()?.stocks.find((item) => item.symbol === symbol && item.disabled);
      if (!record) {
        res.status(404).json({ error: '停用记录不存在' });
        return;
      }
      const restored = await prepareRestore(record);
      const catalog = runWrite(
        (draft) => {
          registerStockIntoState(draft, restored, { watchlist: false });
          /** 停用前保存的分红假设保持生效：恢复后按原版本重挂到研究口径上。 */
          const saved = draft.assumptions.get(symbol);
          if (saved) hydrateAssumptions(draft, [saved]);
          return getCatalog(draft, true);
        },
        () => {
          if (restored.freshBars) saveBars(symbol, restored.bars);
          if (record.kind === 'seed') {
            /** 种子定义在代码里：恢复后清除停用记录，避免 stocks.json 无限累积。 */
            mutateStockRecords((records) => records.filter((item) => item.symbol !== symbol));
          } else {
            upsertStockRecord({ ...record, disabled: false });
          }
        },
      );
      res.json(catalog);
    } catch (error) {
      if (error instanceof StockError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.get('/api/stocks/:symbol', (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    if (!state.stocks.has(symbol)) {
      res.status(404).json({ error: '股票代码不存在' });
      return;
    }

    const rawBudget = typeof req.query.budget === 'string' ? Number(req.query.budget) : NaN;
    const budget = Number.isFinite(rawBudget) && rawBudget >= 0 ? rawBudget : undefined;
    res.json(buildDetail(state, getStockSnapshot(state, symbol), budget));
  });

  app.post('/api/stocks/:symbol/assumption', (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    if (!state.stocks.has(symbol)) {
      res.status(404).json({ error: '股票代码不存在' });
      return;
    }

    try {
      const detail = runWrite(
        (draft) => {
          saveAssumption(draft, symbol, parseAssumptionInput(req.body));
          const { stock } = commitResearchChange(draft, symbol);
          return buildDetail(draft, stock);
        },
        persistAssumptions,
      );
      res.json(detail);
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
      const { assumption, stock, plan } = previewAssumption(
        state,
        symbol,
        parseAssumptionInput(req.body),
      );
      /** 预算与正式详情同一口径：预览分配必须按预览价格阶梯重算。 */
      const rawBudget = typeof req.query.budget === 'string' ? Number(req.query.budget) : NaN;
      const budget = Number.isFinite(rawBudget) && rawBudget >= 0 ? rawBudget : undefined;
      const preview: AssumptionPreviewResponse = {
        assumption,
        stock,
        plan,
        allocation: buildAllocation(state, stock, plan, budget),
      };
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
      const stock = runWrite(
        (draft) => {
          const { assumptionUpdated } = updateStockSettings(draft, symbol, req.body);
          const { stock } = commitResearchChange(draft, symbol);
          return { stock, assumptionUpdated };
        },
        (draft, result) => {
          /** 有正式假设：门槛随假设版本落盘；没有假设：门槛单独落盘，否则重启后回到默认值。 */
          if (result.assumptionUpdated) persistAssumptions(draft);
          else persistSettings(draft);
        },
      ).stock;
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
    const catalog = runWrite(
      (draft) => {
        draft.watchlist.add(symbol);
        return getCatalog(draft);
      },
      persistPortfolio,
    );
    res.json(catalog);
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
    const catalog = runWrite(
      (draft) => {
        draft.watchlist.delete(symbol);
        return getCatalog(draft);
      },
      persistPortfolio,
    );
    res.json(catalog);
  });

  /** 逐条记录人工核验：备注必填、高风险必须留证据、有效期由公开政策决定。 */
  app.post('/api/risk/:id/verify', (req, res) => {
    if (!state.risks.some((item) => item.id === req.params.id)) {
      res.status(404).json({ error: '风险事项不存在' });
      return;
    }
    try {
      const response = runWrite(
        (draft) =>
          buildRiskMutation(
            draft,
            verifyRisk(draft, req.params.id, req.body as RiskVerificationInput),
          ),
        persistRisks,
      );
      res.json(response);
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
      const response = runWrite(
        (draft) => buildRiskMutation(draft, addRiskEvent(draft, req.body as RiskEventInput)),
        persistRisks,
      );
      res.json(response);
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
      const response = runWrite(
        (draft) =>
          buildRiskMutation(
            draft,
            updateRiskSource(draft, req.params.id, req.body as RiskSourcePatch),
          ),
        persistRisks,
      );
      res.json(response);
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
      const response = runWrite(
        (draft) => {
          executeTrade(draft, req.body as TradeRequest);
          /** 现金与持仓已变化：统一重算组合账本与派生快照，响应直接携带最新评分。 */
          const { portfolio, stocks } = commitPortfolioChange(draft);
          return { ...portfolio, stocks } satisfies TradeResponse;
        },
        persistPortfolio,
      );
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

  /** 实时行情只读链路：symbols 必须过滤到观察仓白名单，防止变成任意代码行情代理。 */
  app.get('/api/quotes', async (req, res) => {
    const quoteService = options.quoteService;
    if (!quoteService) {
      res.status(503).json({ error: '行情服务未启用' });
      return;
    }
    const raw = typeof req.query.symbols === 'string' ? req.query.symbols : '';
    const symbols = raw.split(',').map(normalizeSymbol).filter((symbol) => state.stocks.has(symbol));
    if (symbols.length === 0) {
      res.status(400).json({ error: '缺少有效的 symbols' });
      return;
    }
    if (symbols.length > MAX_QUOTE_SYMBOLS) {
      res.status(400).json({ error: `单次最多 ${MAX_QUOTE_SYMBOLS} 只` });
      return;
    }
    try {
      res.json(await quoteService.getSnapshot(symbols));
    } catch {
      res.status(503).json({ error: '行情源暂不可用' });
    }
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
