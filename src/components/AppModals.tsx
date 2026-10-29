import { useEffect, useRef, useState } from 'react';
import { Check, Clipboard, Minus, Plus, Search } from 'lucide-react';
import type {
  AssumptionPreviewResponse,
  CatalogItem,
  ResearchLevel,
  Stock,
  StockDetailResponse,
  StockRegistrationInput,
  TaxBasis,
  TradeResponse,
} from '../../shared/types.ts';
import { normalizeSymbol } from '../../shared/quote-types.ts';
import { forecastSourceLabel, scenarioMeta } from '../../shared/assumptions.ts';
import { MIN_TRADE_PRICE, PRICE_TICK, estimateTradeFees } from '../../shared/costs.ts';
import { api } from '../api.ts';
import { money, number, percent } from '../format.ts';
import { LevelBadge, Modal } from './UI.tsx';

export function WatchlistModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [query, setQuery] = useState('');
  const [code, setCode] = useState('');
  const [forecast, setForecast] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  /** 疑似停牌的待确认请求：保留原输入，用户确认后带 confirmSuspended 重发。 */
  const [pendingConfirm, setPendingConfirm] = useState<{ input: StockRegistrationInput; message: string } | null>(null);
  // 观察仓请求序列号：只接受最新一次请求的列表，避免乱序响应回滚观察仓状态。
  const catalogSeq = useRef(0);

  const load = async () => {
    const seq = ++catalogSeq.current;
    try {
      const result = await api.catalog(true);
      if (seq === catalogSeq.current) setCatalog(result);
    } catch (reason) {
      if (seq === catalogSeq.current) setError((reason as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const refreshAfterChange = async () => {
    await load();
    await onChanged();
  };

  const toggle = async (item: CatalogItem) => {
    const seq = ++catalogSeq.current;
    setBusy(item.symbol);
    setError('');
    setSuccess('');
    try {
      const result = item.inWatchlist ? await api.removeWatchlist(item.symbol) : await api.addWatchlist(item.symbol);
      if (seq === catalogSeq.current) setCatalog(result);
      await onChanged();
    } catch (reason) {
      if (seq === catalogSeq.current) setError((reason as Error).message);
    } finally {
      if (seq === catalogSeq.current) setBusy(null);
    }
  };

  const setStatus = async (item: CatalogItem, enabled: boolean) => {
    const seq = ++catalogSeq.current;
    setBusy(item.symbol);
    setError('');
    setSuccess('');
    try {
      await api.setStockStatus(item.symbol, enabled);
      await refreshAfterChange();
    } catch (reason) {
      if (seq === catalogSeq.current) setError((reason as Error).message);
    } finally {
      if (seq === catalogSeq.current) setBusy(null);
    }
  };

  const submitAdd = async (input: StockRegistrationInput) => {
    setAdding(true);
    setError('');
    setSuccess('');
    try {
      const stock = await api.addStock(input);
      setPendingConfirm(null);
      setCode('');
      setForecast('');
      setSuccess(`已添加 ${stock.name}（${stock.symbol}），历史日线与基础数据已同步`);
      await refreshAfterChange();
    } catch (reason) {
      const stockError = reason as Error & { confirmRequired?: boolean };
      if (stockError.confirmRequired) {
        setPendingConfirm({ input, message: stockError.message });
      } else {
        setError(stockError.message);
      }
    } finally {
      setAdding(false);
    }
  };

  const submit = () => {
    setError('');
    setSuccess('');
    let symbol: string;
    try {
      symbol = normalizeSymbol(code);
    } catch (reason) {
      setError((reason as Error).message);
      return;
    }
    const trimmed = forecast.trim();
    let forecastDividend: number | undefined;
    if (trimmed !== '') {
      const value = Number(trimmed);
      if (!Number.isFinite(value) || value < 0) {
        setError('预测分红必须为非负数字');
        return;
      }
      forecastDividend = value;
    }
    void submitAdd({ symbol, forecastDividend });
  };

  const filtered = catalog.filter((item) => `${item.name}${item.symbol}${item.sector}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <Modal title="管理观察仓" eyebrow="WATCHLIST UNIVERSE" onClose={onClose}>
      <p className="modal-intro">把想长期跟踪的公司放进研究视野，而不是把每一次涨跌都变成行动。</p>
      <div className="add-stock">
        <div className="add-stock-row">
          <label className="modal-search add-stock-code">
            <Search size={17} />
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && !adding && code.trim() && submit()}
              placeholder="输入6位代码添加新股票，如 601288"
              aria-label="新股票代码"
            />
          </label>
          <input
            className="add-stock-forecast"
            value={forecast}
            onChange={(event) => setForecast(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && !adding && code.trim() && submit()}
            placeholder="预测分红/股（选填）"
            inputMode="decimal"
            aria-label="预测每股分红"
          />
          <button className="button button-secondary" disabled={adding || !code.trim()} onClick={submit}>
            {adding ? '同步中…' : '添加'}
          </button>
        </div>
        <small className="add-stock-hint">自动拉取名称、行业与历史日线并加入观察仓；预测分红可稍后在分红实验室调整。</small>
      </div>
      {pendingConfirm && (
        <div className="form-error" role="alert">
          {pendingConfirm.message}
          <div className="confirm-actions">
            <button className="button button-dark" disabled={adding} onClick={() => submitAdd({ ...pendingConfirm.input, confirmSuspended: true })}>仍要添加</button>
            <button className="button button-ghost" disabled={adding} onClick={() => setPendingConfirm(null)}>取消</button>
          </div>
        </div>
      )}
      {success && <p className="form-success">{success}</p>}
      {error && !pendingConfirm && <p className="form-error">{error}</p>}
      <label className="modal-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索公司、代码或行业" /></label>
      <div className="catalog-list">
        {filtered.map((item) => (
          <div className={`catalog-item ${item.enabled ? '' : 'disabled'}`} key={item.symbol}>
            <div><strong>{item.name}</strong><span>{item.symbol} · {item.sector || '未分类'}{item.enabled ? '' : ' · 已停用'}</span></div>
            {item.enabled ? (
              <div className="catalog-actions">
                <button className="button button-ghost" disabled={busy === item.symbol} onClick={() => setStatus(item, false)} title="从研究列表隐藏，可随时恢复">停用</button>
                <button className={`button ${item.inWatchlist ? 'button-ghost' : 'button-secondary'}`} disabled={busy === item.symbol} onClick={() => toggle(item)}>
                  {item.inWatchlist ? <><Minus size={15} />移出</> : <><Plus size={15} />加入</>}
                </button>
              </div>
            ) : (
              <button className="button button-secondary" disabled={busy === item.symbol} onClick={() => setStatus(item, true)}>恢复</button>
            )}
          </div>
        ))}
      </div>
      <div className="modal-footer"><span>{catalog.filter((item) => item.inWatchlist).length} 只正在观察</span><button className="button button-dark" onClick={onClose}>完成</button></div>
    </Modal>
  );
}

export function TradeModal({ stocks, initialSymbol, onClose, onTraded }: { stocks: Stock[]; initialSymbol: string; onClose: () => void; onTraded: (result: TradeResponse) => Promise<void> }) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [shares, setShares] = useState(100);
  const stock = stocks.find((item) => item.symbol === symbol) ?? stocks[0];
  const [price, setPrice] = useState(stock.price);
  const [executedAt, setExecutedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [planLevel, setPlanLevel] = useState<Exclude<ResearchLevel, 'L0'> | ''>('');
  const [taxBasis, setTaxBasis] = useState<TaxBasis>('after_tax');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setPrice(stock.price);
  }, [stock.symbol, stock.price]);

  const gross = shares * price;
  const fees = estimateTradeFees(side, gross);
  const netAmount = side === 'buy' ? gross + fees.total : gross - fees.total;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.trade({
        symbol,
        side,
        shares,
        price,
        executedAt: executedAt || undefined,
        planLevel: planLevel || null,
        taxBasis,
      });
      await onTraded(result);
      onClose();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="记录模拟交易" eyebrow="PAPER LEDGER" onClose={onClose}>
      <div className="paper-trade-note">仅更新本地演示账本，不连接券商、不发出真实委托。</div>
      <div className="form-grid">
        <label className="field field-full"><span>公司</span><select value={symbol} onChange={(event) => setSymbol(event.target.value)}>{stocks.map((item) => <option key={item.symbol} value={item.symbol}>{item.name} · {item.symbol}</option>)}</select></label>
        <div className="field field-full"><span>方向</span><div className="side-tabs"><button className={side === 'buy' ? 'active' : ''} onClick={() => setSide('buy')}>模拟买入</button><button className={side === 'sell' ? 'active' : ''} onClick={() => setSide('sell')}>模拟卖出</button></div></div>
        <label className="field"><span>股数（100 股整数倍）</span><input type="number" min="100" step="100" value={shares} onChange={(event) => setShares(Number(event.target.value))} /></label>
        <label className="field"><span>成交价格（元）</span><input type="number" min={MIN_TRADE_PRICE} step={PRICE_TICK} value={price} onChange={(event) => setPrice(Number(event.target.value))} /></label>
        <label className="field"><span>成交日期</span><input type="date" value={executedAt} onChange={(event) => setExecutedAt(event.target.value)} /></label>
        <label className="field"><span>计划档位（可选）</span><select value={planLevel} onChange={(event) => setPlanLevel(event.target.value as Exclude<ResearchLevel, 'L0'> | '')}><option value="">无计划 · 人工记录</option><option value="L1">L1 第一档</option><option value="L2">L2 第二档</option><option value="L3">L3 第三档</option></select></label>
        <div className="field field-full"><span>记账口径</span><div className="side-tabs"><button className={taxBasis === 'pre_tax' ? 'active' : ''} onClick={() => setTaxBasis('pre_tax')}>税前</button><button className={taxBasis === 'after_tax' ? 'active' : ''} onClick={() => setTaxBasis('after_tax')}>税后</button></div></div>
      </div>
      <div className="trade-summary">
        <span>{taxBasis === 'pre_tax' ? '记账现金影响（税前毛额，费用税费仅展示）' : side === 'buy' ? '预计支付（含费用）' : '收回（扣费用与税）'}</span>
        <strong>{money(taxBasis === 'pre_tax' ? gross : netAmount)}</strong>
      </div>
      <div className="trade-fee-line">
        <span>成交金额 {money(gross)}</span>
        <span>佣金 {money(fees.commission, 2)}</span>
        <span>过户费 {money(fees.transferFee, 2)}</span>
        {fees.stampDuty > 0 && <span>印花税 {money(fees.stampDuty, 2)}</span>}
      </div>
      <div className="assumption-note trade-assumption">
        <span>本笔交易记录的研究假设</span>
        <strong>{stock.assumptionVersion > 0 ? `v${stock.assumptionVersion}` : '默认假设'}</strong>
        <span>要求股息率 {percent(stock.buyThreshold, 1)}</span>
        {planLevel && <span>档位 {planLevel}</span>}
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-footer"><button className="button button-ghost" onClick={onClose}>取消</button><button className="button button-dark" disabled={busy || shares <= 0 || price < MIN_TRADE_PRICE} onClick={submit}>{busy ? '正在校验…' : '确认记录'}</button></div>
    </Modal>
  );
}

export function ChecklistModal({ detail, preview, onClose, onCopied }: { detail: StockDetailResponse; preview: AssumptionPreviewResponse | null; onClose: () => void; onCopied: () => void }) {
  const { stock } = detail;
  const draft = preview?.assumption.symbol === stock.symbol ? preview : null;
  const plan = draft?.plan ?? detail.plan;
  const assumption = draft?.assumption ?? detail.assumption;
  /** 预览清单必须整份引用预览快照，避免把新计划与旧等级、旧闸门拼在一起。 */
  const viewStock = draft?.stock ?? stock;
  const versionLabel = draft
    ? `临时假设（保存后为 v${assumption.version}）`
    : assumption.version > 0
      ? `v${assumption.version}`
      : '默认假设';
  const assumptionLine = `${assumption.forecastYear}年 · ${scenarioMeta(assumption.scenario).label}情景 · 每股分红 ¥${number(assumption.dividendPerShare)} · 要求股息率 ${percent(assumption.requiredYield, 1)}`;
  const traceLine = `预测来源 ${forecastSourceLabel(assumption.source)} · 报告期 ${assumption.reportPeriod} · 公告日期 ${assumption.announcementDate ?? '无'}`;
  const text = [
    `【息壤研究清单】${viewStock.name} ${viewStock.symbol}`,
    `当前：¥${viewStock.price}，预测股息率 ${percent(viewStock.dividendYield)}，%B ${(viewStock.percentB * 100).toFixed(0)}%，等级 ${viewStock.level}`,
    `风险闸门：${viewStock.riskGate.summary}`,
    `允许研究等级：${viewStock.riskGate.allowedLevels.join(' / ') || '无（全部阻断）'}`,
    `研究假设（${versionLabel}）：${assumptionLine}`,
    `${traceLine}`,
    `假设说明：${assumption.hypothesis}`,
    ...plan.flatMap((tier) => [
      `${tier.level} ${tier.name}：研究价 ${money(tier.targetPrice ?? 0)}，门槛 ${percent(tier.yieldThreshold * 100)}，参考 ${tier.shares} 股`,
      ...tier.conditions.map((condition) => `  □ ${condition}`),
    ]),
    '□ 已阅读最新财报与分红公告原文',
    '□ 已检查自由现金流与派息可持续性',
    '□ 已确认本笔操作符合组合现金与仓位约束',
    '说明：研究清单不构成投资建议，不自动生成交易委托。',
  ].join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      onCopied();
      onClose();
    } catch {
      onClose();
    }
  };

  return (
    <Modal title={`${stock.name} · 研究清单`} eyebrow="BEFORE ANY ACTION" onClose={onClose} wide>
      <div className="checklist-preview">
        <div className="checklist-stock"><LevelBadge level={viewStock.level} /><strong>{viewStock.name}</strong><span>当前 {percent(viewStock.dividendYield)} · %B {(viewStock.percentB * 100).toFixed(0)}%</span></div>
        <div className={`checklist-assumption ${draft ? 'draft' : ''}`}><span>{versionLabel}</span><p>{assumptionLine}</p><p>{traceLine}</p><p>假设说明：{assumption.hypothesis}</p></div>
        {plan.map((tier) => <div className="checklist-tier" key={tier.level}><div><LevelBadge level={tier.level} /><strong>{money(tier.targetPrice ?? 0)}</strong><span>{tier.shares} 股参考</span></div>{tier.conditions.map((condition) => <p key={condition}><span className="empty-checkbox" />{condition}</p>)}</div>)}
        <div className="manual-checks"><p><span className="empty-checkbox" />已阅读最新财报与分红公告原文</p><p><span className="empty-checkbox" />已检查自由现金流与派息可持续性</p><p><span className="empty-checkbox" />已确认组合现金与仓位约束</p></div>
      </div>
      <div className="modal-footer"><span>人工决策 · 不自动委托</span><button className="button button-dark" onClick={copy}><Clipboard size={16} />复制完整清单</button></div>
    </Modal>
  );
}
