import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BellRing,
  ChartCandlestick,
  Download,
  FlaskConical,
  Layers3,
  LayoutDashboard,
  Menu,
  Network,
  Radar,
  RefreshCw,
  Search,
  ShieldCheck,
  WalletCards,
  X,
} from 'lucide-react';
import type {
  AssumptionInput,
  AssumptionPreviewResponse,
  DashboardResponse,
  RiskEventInput,
  RiskVerificationInput,
  StockDetailResponse,
  TradeResponse,
} from '../shared/types.ts';
import { api } from './api.ts';
import { useLiveQuotes } from './hooks/useLiveQuotes.ts';
import { ChecklistModal, TradeModal, WatchlistModal } from './components/AppModals.tsx';
import { ErrorScreen, LoadingScreen, Toast } from './components/UI.tsx';
import Dashboard from './pages/Dashboard.tsx';
import StockDetail from './pages/StockDetail.tsx';
import DividendLab from './pages/DividendLab.tsx';
import PlanPage from './pages/PlanPage.tsx';
import RiskPage from './pages/RiskPage.tsx';
import PortfolioPage from './pages/PortfolioPage.tsx';
import BlueprintPage from './pages/BlueprintPage.tsx';

type View = 'dashboard' | 'detail' | 'lab' | 'plan' | 'risk' | 'portfolio' | 'blueprint';
type ModalType = 'watchlist' | 'trade' | 'checklist' | null;

const navigation = [
  { key: 'dashboard', label: '今日机会雷达', short: '雷达', icon: Radar },
  { key: 'detail', label: '个股研究透视', short: '个股', icon: ChartCandlestick },
  { key: 'lab', label: '分红预测实验室', short: '分红', icon: FlaskConical },
  { key: 'plan', label: '分级加仓计划', short: '计划', icon: Layers3 },
  { key: 'risk', label: '资讯与风险哨兵', short: '风险', icon: ShieldCheck },
  { key: 'portfolio', label: '持仓与现金流', short: '持仓', icon: WalletCards },
] as const;

export default function App() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [detail, setDetail] = useState<StockDetailResponse | null>(null);
  const [preview, setPreview] = useState<AssumptionPreviewResponse | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState('601318.SH');
  const [view, setView] = useState<View>('dashboard');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<ModalType>(null);
  const [toast, setToast] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // 请求序列号：只有最新一次请求的响应可以写入状态，避免乱序响应覆盖新数据。
  const dashboardSeq = useRef(0);
  const detailSeq = useRef(0);
  const previewSeq = useRef(0);
  // 最新选中的标的，供异步回调判断自己是否已经过期。
  const latestSymbolRef = useRef(selectedSymbol);

  /**
   * 本地写操作成功后作废此前发出的读取请求。
   * 写响应携带的状态一定比在途 GET 新，否则旧响应会把现金、持仓、门槛或计划回滚到写入前。
   */
  const invalidatePendingReads = useCallback(() => {
    dashboardSeq.current += 1;
    detailSeq.current += 1;
    previewSeq.current += 1;
  }, []);

  useEffect(() => {
    latestSymbolRef.current = selectedSymbol;
  }, [selectedSymbol]);

  // 实时行情轮询：观察仓（含持仓的观察标的）作为 watch 列表；失败不清空旧数据。
  const watchSymbols = useMemo(() => data?.stocks.map((stock) => stock.symbol) ?? [], [data]);
  const liveQuotes = useLiveQuotes(watchSymbols);

  const loadData = useCallback(async () => {
    const seq = ++dashboardSeq.current;
    try {
      const response = await api.dashboard();
      if (seq !== dashboardSeq.current) return;
      setData(response);
      setError('');
    } catch (reason) {
      if (seq !== dashboardSeq.current) return;
      setError((reason as Error).message);
      throw reason;
    }
  }, []);

  useEffect(() => {
    loadData().catch(() => undefined).finally(() => setLoading(false));
  }, [loadData]);

  // 交易响应已携带按新现金与持仓重算的派生快照：就地合并，避免评分停留在交易前。
  const applyTrade = useCallback((result: TradeResponse) => {
    /** 交易响应比任何在途看板/详情请求都新：先作废它们，旧响应不得回滚现金与持仓。 */
    invalidatePendingReads();
    const { stocks, ...portfolio } = result;
    setData((previous) => {
      if (!previous) return previous;
      const fresh = new Map(stocks.map((stock) => [stock.symbol, stock]));
      return {
        ...previous,
        stocks: previous.stocks.map((stock) => fresh.get(stock.symbol) ?? stock),
        tradeStocks: stocks,
        portfolio,
      };
    });
  }, [invalidatePendingReads]);

  useEffect(() => {
    if (!data || !selectedSymbol) return;
    const seq = ++detailSeq.current;
    api.stock(selectedSymbol).then((response) => {
      if (seq !== detailSeq.current) return;
      setDetail(response);
    }).catch((reason: Error) => {
      if (seq === detailSeq.current) setToast(reason.message);
    });
  }, [selectedSymbol, data]);

  useEffect(() => {
    if (data && !data.stocks.some((stock) => stock.symbol === selectedSymbol)) {
      setSelectedSymbol(data.stocks[0]?.symbol ?? '');
    }
  }, [data, selectedSymbol]);

  // 只有与当前选中标的匹配的详情才允许渲染与写入：切换期间旧详情立即失效。
  const activeDetail = detail && detail.stock.symbol === selectedSymbol ? detail : null;

  const navigate = (next: View) => {
    setView(next);
    setMobileNav(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /** target 为切换后停留的页面：页内切换器（个股/分红/计划）传当前视图，其余入口默认进入个股研究透视。 */
  const selectStock = (symbol: string, target: View = 'detail') => {
    previewSeq.current += 1;
    setSelectedSymbol(symbol);
    setPreview(null);
    setSearch('');
    navigate(target);
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadData();
      setToast('已重新读取演示快照，数据日期未变化');
    } catch {
      setToast('连接失败，请确认后端服务正在运行');
    } finally {
      setRefreshing(false);
    }
  };

  /** 导出按钮走 fetch：跨设备部署时导出接口同样需要令牌头。 */
  const exportWatchlist = async () => {
    try {
      await api.exportWatchlist();
      setToast('观察仓 CSV 已开始下载');
    } catch (reason) {
      setToast((reason as Error).message || '导出失败，请稍后重试');
    }
  };

  /** 统一的写操作收口：执行 mutation → 作废在途读取 → 重新拉取看板 → 反馈结果；失败同时提示并抛回给表单。 */
  const runMutation = useCallback(async (action: () => Promise<string | null>) => {
    try {
      const message = await action();
      invalidatePendingReads();
      try {
        await loadData();
      } catch {
        setToast('操作已生效，但重新读取看板失败，请稍后手动刷新');
        return;
      }
      if (message) setToast(message);
    } catch (reason) {
      setToast((reason as Error).message || '操作失败，请稍后重试');
      throw reason;
    }
  }, [invalidatePendingReads, loadData]);

  /** 观察仓变更同样属于本地 mutation：先作废在途读取，再按新列表重新拉取看板。 */
  const reloadAfterMutation = useCallback(() => {
    invalidatePendingReads();
    return loadData();
  }, [invalidatePendingReads, loadData]);

  const saveAssumption = (symbol: string, input: AssumptionInput) => runMutation(async () => {
    const updated = await api.saveAssumption(symbol, input);
    /** 保存响应已是服务端最新状态：先作废保存前发出的详情与预览请求，旧响应不得覆盖保存结果。 */
    invalidatePendingReads();
    // 保存期间可能已切入其他标的：不再回写旧详情，也不跳转。
    if (symbol !== latestSymbolRef.current) {
      return `${updated.stock.name} 的分红假设已保存为 v${updated.assumption.version}，当前已切换到其他标的`;
    }
    setDetail(updated);
    setPreview(null);
    navigate('plan');
    return `分红假设已保存为 v${updated.assumption.version}，计划价格已按该版本重算`;
  });

  const previewAssumption = async (symbol: string, input: AssumptionInput) => {
    /** 预览独立序列：同一标的连续预览时，只有最后一次请求的响应可以写入。 */
    const seq = ++previewSeq.current;
    const result = await api.previewAssumption(symbol, input);
    if (seq !== previewSeq.current) return;
    if (symbol !== latestSymbolRef.current) return;
    setPreview(result);
    setToast(`已生成临时价格阶梯（保存后为 v${result.assumption.version}）`);
    navigate('plan');
  };

  const savePreview = async () => {
    if (!preview) return;
    const { symbol, forecastYear, scenario, requiredYield } = preview.assumption;
    await saveAssumption(symbol, { forecastYear, scenario, requiredYield });
  };

  const verifyRisk = (id: string, input: RiskVerificationInput) => runMutation(async () => {
    const result = await api.verifyRisk(id, input);
    return `核验已记录：${result.risk.statusReason}`;
  });

  const addRisk = (input: RiskEventInput) => runMutation(async () => {
    const result = await api.addRisk(input);
    return result.risk.severity === 'high'
      ? '已登记高风险事项，该股票原有核验全部失效，需重新核验'
      : `已登记风险事项：${result.risk.title}`;
  });

  const refreshRiskSource = (id: string) => runMutation(async () => {
    const result = await api.updateRiskSource(id, {});
    return `原文已更新至 v${result.risk.source.revision}，原核验已失效`;
  });

  const searchResults = useMemo(() => {
    if (!data || !search.trim()) return [];
    const query = search.trim().toLowerCase();
    return data.stocks.filter((stock) => `${stock.name}${stock.symbol}${stock.sector}`.toLowerCase().includes(query));
  }, [data, search]);

  if (loading) return <LoadingScreen />;
  if (!data) return <ErrorScreen message={error || '未收到研究数据'} retry={() => { setLoading(true); loadData().catch(() => undefined).finally(() => setLoading(false)); }} />;

  const currentNav = navigation.find((item) => item.key === view);
  const openRiskCount = data.risks.filter((risk) => risk.status !== 'verified').length;
  const pageTitle = view === 'blueprint' ? '系统架构蓝图' : currentNav?.label ?? '息壤研究台';
  const detailLoading = <div className="inline-loading"><span className="loading-spinner" />正在计算个股研究数据…</div>;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><span>息</span><i /></div>
          <div><strong>息壤</strong><span>DIVIDEND ATLAS</span></div>
          <button className="mobile-close" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={20} /></button>
        </div>
        <div className="sidebar-caption"><span>RESEARCH DESK</span><i>个人研究版</i></div>
        <nav className="main-nav" aria-label="主导航">
          {navigation.map((item, index) => {
            const Icon = item.icon;
            return <button key={item.key} className={view === item.key ? 'active' : ''} onClick={() => navigate(item.key)}><span className="nav-index">0{index + 1}</span><Icon size={18} /><span>{item.label}</span>{item.key === 'risk' && openRiskCount > 0 && <i className="nav-alert" />}</button>;
          })}
        </nav>
        <div className="sidebar-bottom">
          <button className={view === 'blueprint' ? 'blueprint-link active' : 'blueprint-link'} onClick={() => navigate('blueprint')}><Network size={17} /><span>系统架构蓝图</span><span>↗</span></button>
          <div className="sidebar-principle"><LayoutDashboard size={18} /><p>不预测每一次波动，<br />只准备价格到来时的动作。</p></div>
          <div className="system-status"><span className="live-dot" /><div><strong>演示快照已连接</strong><small>数据截至 {data.asOf}</small></div></div>
          <div className="version-line"><span>V0.1 · PERSONAL RESEARCH</span><span>人工决策</span></div>
        </div>
      </aside>
      {mobileNav && <button className="nav-scrim" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-left"><button className="mobile-menu" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={20} /></button><span>息壤研究台</span><i>/</i><strong>{pageTitle}</strong></div>
          <div className="topbar-actions">
            <div className="global-search">
              <Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索观察仓 / 代码" aria-label="搜索观察仓" />
              {search && <div className="search-results">{searchResults.length ? searchResults.map((stock) => <button key={stock.symbol} onClick={() => selectStock(stock.symbol)}><strong>{stock.name}</strong><span>{stock.symbol}</span><em>{stock.dividendYield.toFixed(2)}%</em></button>) : <p>观察仓中没有匹配结果</p>}</div>}
            </div>
            <button className={`icon-button topbar-button ${refreshing ? 'spinning' : ''}`} onClick={refresh} title="重新读取演示快照" aria-label="刷新数据"><RefreshCw size={17} /></button>
            <button className="icon-button topbar-button export-button" onClick={exportWatchlist} title="导出观察仓 CSV" aria-label="导出观察仓"><Download size={17} /></button>
            <button className="notification-button" onClick={() => navigate('risk')} aria-label="查看风险通知"><BellRing size={17} /><span>{openRiskCount}</span></button>
            <div className="research-avatar">研</div>
          </div>
        </header>

        <main className="main-content">
          {view === 'dashboard' && <Dashboard data={data} onSelect={selectStock} onManage={() => setModal('watchlist')} liveQuotes={liveQuotes} />}
          {view === 'detail' && (activeDetail ? <StockDetail detail={activeDetail} stocks={data.stocks} onSelect={(symbol) => selectStock(symbol, 'detail')} onBack={() => navigate('dashboard')} onOpenPlan={() => navigate('plan')} quote={liveQuotes.quotes.get(activeDetail.stock.symbol)} quoteError={liveQuotes.error} /> : detailLoading)}
          {view === 'lab' && (activeDetail ? <DividendLab detail={activeDetail} stocks={data.stocks} onSelect={(symbol) => selectStock(symbol, 'lab')} onSave={(input) => saveAssumption(activeDetail.stock.symbol, input)} onPreview={(input) => previewAssumption(activeDetail.stock.symbol, input)} /> : detailLoading)}
          {view === 'plan' && (activeDetail ? <PlanPage detail={activeDetail} stocks={data.stocks} onSelect={(symbol) => selectStock(symbol, 'plan')} preview={preview} onSavePreview={savePreview} onExitPreview={() => setPreview(null)} onCreateChecklist={() => setModal('checklist')} /> : detailLoading)}
          {view === 'risk' && <RiskPage data={data} onVerify={verifyRisk} onAddRisk={addRisk} onRefreshSource={refreshRiskSource} />}
          {view === 'portfolio' && <PortfolioPage data={data} onTrade={() => setModal('trade')} />}
          {view === 'blueprint' && <BlueprintPage />}
        </main>
      </div>

      {modal === 'watchlist' && <WatchlistModal onClose={() => setModal(null)} onChanged={reloadAfterMutation} />}
      {modal === 'trade' && <TradeModal stocks={data.tradeStocks} initialSymbol={selectedSymbol} onClose={() => setModal(null)} onTraded={async (result) => { applyTrade(result); setToast('模拟交易已记录，组合现金流与评分已更新'); }} />}
      {modal === 'checklist' && activeDetail && <ChecklistModal detail={activeDetail} preview={preview} onClose={() => setModal(null)} onCopied={() => setToast('研究清单已复制到剪贴板')} />}
      {toast && <Toast message={toast} onClose={() => setToast('')} />}
    </div>
  );
}
