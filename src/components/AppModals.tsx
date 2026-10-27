import { useEffect, useState } from 'react';
import { Check, Clipboard, Minus, Plus, Search } from 'lucide-react';
import type { CatalogItem, Stock, StockDetailResponse } from '../../shared/types.ts';
import { api } from '../api.ts';
import { money, percent } from '../format.ts';
import { LevelBadge, Modal } from './UI.tsx';

export function WatchlistModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.catalog().then(setCatalog).catch((reason: Error) => setError(reason.message));
  }, []);

  const toggle = async (item: CatalogItem) => {
    setBusy(item.symbol);
    setError('');
    try {
      const result = item.inWatchlist ? await api.removeWatchlist(item.symbol) : await api.addWatchlist(item.symbol);
      setCatalog(result);
      await onChanged();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const filtered = catalog.filter((item) => `${item.name}${item.symbol}${item.sector}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <Modal title="管理观察仓" eyebrow="WATCHLIST UNIVERSE" onClose={onClose}>
      <p className="modal-intro">把想长期跟踪的公司放进研究视野，而不是把每一次涨跌都变成行动。</p>
      <label className="modal-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索公司、代码或行业" /></label>
      {error && <p className="form-error">{error}</p>}
      <div className="catalog-list">
        {filtered.map((item) => (
          <div className="catalog-item" key={item.symbol}>
            <div><strong>{item.name}</strong><span>{item.symbol} · {item.sector}</span></div>
            <button className={`button ${item.inWatchlist ? 'button-ghost' : 'button-secondary'}`} disabled={busy === item.symbol} onClick={() => toggle(item)}>
              {item.inWatchlist ? <><Minus size={15} />移出</> : <><Plus size={15} />加入</>}
            </button>
          </div>
        ))}
      </div>
      <div className="modal-footer"><span>{catalog.filter((item) => item.inWatchlist).length} 只正在观察</span><button className="button button-dark" onClick={onClose}>完成</button></div>
    </Modal>
  );
}

export function TradeModal({ stocks, initialSymbol, onClose, onTraded }: { stocks: Stock[]; initialSymbol: string; onClose: () => void; onTraded: () => Promise<void> }) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [shares, setShares] = useState(100);
  const stock = stocks.find((item) => item.symbol === symbol) ?? stocks[0];
  const [price, setPrice] = useState(stock.price);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setPrice(stock.price);
  }, [stock.symbol, stock.price]);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.trade({ symbol, side, shares, price });
      await onTraded();
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
        <label className="field"><span>成交价格（元）</span><input type="number" min="0.01" step="0.01" value={price} onChange={(event) => setPrice(Number(event.target.value))} /></label>
      </div>
      <div className="trade-summary"><span>预计{side === 'buy' ? '支付' : '收回'}</span><strong>{money(shares * price)}</strong></div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-footer"><button className="button button-ghost" onClick={onClose}>取消</button><button className="button button-dark" disabled={busy || shares <= 0 || price <= 0} onClick={submit}>{busy ? '正在校验…' : '确认记录'}</button></div>
    </Modal>
  );
}

export function ChecklistModal({ detail, onClose, onCopied }: { detail: StockDetailResponse; onClose: () => void; onCopied: () => void }) {
  const { stock, plan } = detail;
  const text = [
    `【息壤研究清单】${stock.name} ${stock.symbol}`,
    `当前：¥${stock.price}，预测股息率 ${percent(stock.dividendYield)}，%B ${(stock.percentB * 100).toFixed(0)}%，等级 ${stock.level}`,
    `风险状态：${stock.riskVerified ? '已人工核验' : '待人工核验'}`,
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
        <div className="checklist-stock"><LevelBadge level={stock.level} /><strong>{stock.name}</strong><span>当前 {percent(stock.dividendYield)} · %B {(stock.percentB * 100).toFixed(0)}%</span></div>
        {plan.map((tier) => <div className="checklist-tier" key={tier.level}><div><LevelBadge level={tier.level} /><strong>{money(tier.targetPrice ?? 0)}</strong><span>{tier.shares} 股参考</span></div>{tier.conditions.map((condition) => <p key={condition}><span className="empty-checkbox" />{condition}</p>)}</div>)}
        <div className="manual-checks"><p><span className="empty-checkbox" />已阅读最新财报与分红公告原文</p><p><span className="empty-checkbox" />已检查自由现金流与派息可持续性</p><p><span className="empty-checkbox" />已确认组合现金与仓位约束</p></div>
      </div>
      <div className="modal-footer"><span>人工决策 · 不自动委托</span><button className="button button-dark" onClick={copy}><Clipboard size={16} />复制完整清单</button></div>
    </Modal>
  );
}
