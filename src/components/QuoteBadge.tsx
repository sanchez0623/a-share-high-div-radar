import type { Quote, QuoteSnapshotResponse, SessionState } from '../../shared/quote-types.ts';

/** 数据源快照时间 → Asia/Shanghai 时钟；解析失败显示占位符。 */
function formatQuoteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

const SESSION_LABEL: Record<SessionState, string> = {
  'pre-open': '未开盘',
  open: '盘中',
  'lunch-break': '午间休市',
  closed: '已收盘',
  'non-trading-day': '非交易日',
};

function Dot({ tone }: { tone: 'live' | 'stale' | 'error' }) {
  return <span className={`quote-dot quote-dot--${tone}`} />;
}

interface QuoteBadgeProps {
  quote?: Quote;
  /** 行情请求失败信息；有值且无行情时优先展示失败状态。 */
  error?: string;
}

/** 单只实时行情徽章：A 股习惯红涨绿跌（沿用全局 up/down 类），失败与陈旧态不清零价格。 */
export function QuoteBadge({ quote, error }: QuoteBadgeProps) {
  if (!quote) {
    return (
      <span className="quote-badge" title={error ?? '暂无实时行情'}>
        <Dot tone={error ? 'error' : 'live'} />
        <span className="quote-session">{error ? '行情不可用' : '等待行情'}</span>
      </span>
    );
  }
  const staleLabel = quote.stale && quote.staleSeconds > 0 ? ` · 延迟 ${quote.staleSeconds}s` : '';
  return (
    <span className="quote-badge" title={error ?? (quote.stale ? '行情已延迟，显示最后成功快照' : undefined)}>
      <Dot tone={quote.stale ? 'stale' : 'live'} />
      <span className="quote-session">
        {SESSION_LABEL[quote.sessionState]}{staleLabel}
      </span>
      <strong>¥{quote.price.toFixed(2)}</strong>
      <small className={quote.changePct >= 0 ? 'up' : 'down'}>
        {quote.changePct >= 0 ? '+' : ''}{quote.changePct.toFixed(2)}%
      </small>
      <span className="quote-time">{formatQuoteTime(quote.quoteTime)} · {quote.source}</span>
    </span>
  );
}

interface QuoteStatusBadgeProps {
  snapshot: QuoteSnapshotResponse | null;
  error?: string;
}

/** 观察仓级行情摘要：时段 + 最近快照时间 + 主源/备用源 + 陈旧数量。 */
export function QuoteStatusBadge({ snapshot, error }: QuoteStatusBadgeProps) {
  const quotes = snapshot?.quotes ?? [];
  if (quotes.length === 0) {
    return (
      <span className="quote-badge" title={error ?? '暂无实时行情'}>
        <Dot tone={error ? 'error' : 'live'} />
        <span className="quote-session">{error ? '行情不可用' : '等待行情'}</span>
      </span>
    );
  }

  const staleCount = quotes.filter((quote) => quote.stale).length;
  /** 仓级时间取最新一条快照时间；来源取第一条（同一批请求来源一致）。 */
  const latestTime = quotes.reduce(
    (latest, quote) => (quote.quoteTime > latest ? quote.quoteTime : latest),
    quotes[0].quoteTime,
  );
  const degradedLabel = snapshot?.degraded ? ` · 备用源 ${snapshot.degraded.to}` : '';
  const staleLabel = staleCount > 0 ? ` · 延迟 ${staleCount} 只` : '';
  return (
    <span className="quote-badge" title={snapshot?.degraded?.reason ?? error}>
      <Dot tone={staleCount > 0 ? 'stale' : 'live'} />
      <span className="quote-session">
        {SESSION_LABEL[snapshot!.sessionState]}{staleLabel}
      </span>
      <span className="quote-time">
        {formatQuoteTime(latestTime)} · {quotes[0].source}{degradedLabel}
      </span>
    </span>
  );
}
