import { useCallback, useEffect, useMemo, useState } from 'react';
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
import type { DashboardResponse, StockDetailResponse } from '../shared/types.ts';
import { api } from './api.ts';
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
  const [selectedSymbol, setSelectedSymbol] = useState('601318.SH');
  const [view, setView] = useState<View>('dashboard');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<ModalType>(null);
  const [toast, setToast] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const response = await api.dashboard();
      setData(response);
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
      throw reason;
    }
  }, []);

  useEffect(() => {
    loadData().catch(() => undefined).finally(() => setLoading(false));
  }, [loadData]);

  useEffect(() => {
    if (!data || !selectedSymbol) return;
    let active = true;
    api.stock(selectedSymbol).then((response) => {
      if (active) setDetail(response);
    }).catch((reason: Error) => setToast(reason.message));
    return () => { active = false; };
  }, [selectedSymbol, data]);

  useEffect(() => {
    if (data && !data.stocks.some((stock) => stock.symbol === selectedSymbol)) {
      setSelectedSymbol(data.stocks[0]?.symbol ?? '');
    }
  }, [data, selectedSymbol]);

  const navigate = (next: View) => {
    setView(next);
    setMobileNav(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const selectStock = (symbol: string) => {
    setSelectedSymbol(symbol);
    setSearch('');
    navigate('detail');
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

  const saveThreshold = async (threshold: number) => {
    await api.updateSettings(selectedSymbol, { buyThreshold: threshold });
    await loadData();
    setToast(`研究门槛已保存为 ${threshold.toFixed(1)}%`);
  };

  const acknowledgeRisk = async (id: string) => {
    await api.acknowledgeRisk(id);
    await loadData();
    setToast('人工复核状态已记录，研究信号已重新计算');
  };

  const searchResults = useMemo(() => {
    if (!data || !search.trim()) return [];
    const query = search.trim().toLowerCase();
    return data.stocks.filter((stock) => `${stock.name}${stock.symbol}${stock.sector}`.toLowerCase().includes(query));
  }, [data, search]);

  if (loading) return <LoadingScreen />;
  if (!data) return <ErrorScreen message={error || '未收到研究数据'} retry={() => { setLoading(true); loadData().catch(() => undefined).finally(() => setLoading(false)); }} />;

  const currentNav = navigation.find((item) => item.key === view);
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
            return <button key={item.key} className={view === item.key ? 'active' : ''} onClick={() => navigate(item.key)}><span className="nav-index">0{index + 1}</span><Icon size={18} /><span>{item.label}</span>{item.key === 'risk' && data.risks.some((risk) => risk.status === 'pending') && <i className="nav-alert" />}</button>;
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
            <a className="icon-button topbar-button export-button" href="/api/export/watchlist" download title="导出观察仓 CSV" aria-label="导出观察仓"><Download size={17} /></a>
            <button className="notification-button" onClick={() => navigate('risk')} aria-label="查看风险通知"><BellRing size={17} /><span>{data.risks.filter((risk) => risk.status === 'pending').length}</span></button>
            <div className="research-avatar">研</div>
          </div>
        </header>

        <main className="main-content">
          {view === 'dashboard' && <Dashboard data={data} onSelect={selectStock} onManage={() => setModal('watchlist')} />}
          {view === 'detail' && (detail ? <StockDetail detail={detail} stocks={data.stocks} onSelect={selectStock} onBack={() => navigate('dashboard')} onOpenPlan={() => navigate('plan')} /> : detailLoading)}
          {view === 'lab' && (detail ? <DividendLab detail={detail} stocks={data.stocks} onSelect={selectStock} onSave={saveThreshold} onOpenPlan={() => navigate('plan')} /> : detailLoading)}
          {view === 'plan' && (detail ? <PlanPage detail={detail} stocks={data.stocks} onSelect={selectStock} onCreateChecklist={() => setModal('checklist')} /> : detailLoading)}
          {view === 'risk' && <RiskPage data={data} onAcknowledge={acknowledgeRisk} />}
          {view === 'portfolio' && <PortfolioPage data={data} onTrade={() => setModal('trade')} />}
          {view === 'blueprint' && <BlueprintPage />}
        </main>
      </div>

      {modal === 'watchlist' && <WatchlistModal onClose={() => setModal(null)} onChanged={loadData} />}
      {modal === 'trade' && <TradeModal stocks={data.stocks} initialSymbol={selectedSymbol} onClose={() => setModal(null)} onTraded={async () => { await loadData(); setToast('模拟交易已记录，组合现金流已更新'); }} />}
      {modal === 'checklist' && detail && <ChecklistModal detail={detail} onClose={() => setModal(null)} onCopied={() => setToast('研究清单已复制到剪贴板')} />}
      {toast && <Toast message={toast} onClose={() => setToast('')} />}
    </div>
  );
}
