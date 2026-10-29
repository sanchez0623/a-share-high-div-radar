import { useEffect, useMemo, useRef, useState } from 'react';
import type { Quote, QuoteSnapshotResponse } from '../../shared/quote-types.ts';
import { api } from '../api.ts';

/** 页面可见时的轮询间隔；与后端盘中 TTL（5s）配合，保证每轮都能拿到新数据。 */
const VISIBLE_INTERVAL_MS = 15_000;
/** 页面隐藏时降频，避免后台标签页持续打上游。 */
const HIDDEN_INTERVAL_MS = 60_000;
/** 连续失败时的退避上限。 */
const MAX_INTERVAL_MS = 180_000;

export interface LiveQuotesResult {
  /** 按 symbol 索引的最新行情；请求失败或尚未拿到时对应标的缺失。 */
  quotes: Map<string, Quote>;
  snapshot: QuoteSnapshotResponse | null;
  error: string;
}

/**
 * 实时行情轮询：沿用 App 的「只接受最新响应」思路——
 * 页面隐藏时降频、失败指数退避，失败不清空旧数据（由 QuoteBadge 呈现陈旧状态）。
 */
export function useLiveQuotes(symbols: string[]): LiveQuotesResult {
  const [snapshot, setSnapshot] = useState<QuoteSnapshotResponse | null>(null);
  const [error, setError] = useState('');
  const key = symbols.join(',');
  // tick 闭包始终读取最新列表，避免数组引用变化导致轮询重启。
  const symbolsRef = useRef(symbols);
  symbolsRef.current = symbols;

  useEffect(() => {
    if (symbols.length === 0) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;

    const tick = async () => {
      try {
        const next = await api.quotes(symbolsRef.current);
        if (cancelled) return;
        setSnapshot(next);
        setError('');
        failures = 0;
      } catch (reason) {
        if (cancelled) return;
        failures += 1;
        setError((reason as Error).message);
      } finally {
        if (cancelled) return;
        const base = document.visibilityState === 'visible' ? VISIBLE_INTERVAL_MS : HIDDEN_INTERVAL_MS;
        timer = window.setTimeout(tick, Math.min(base * 2 ** failures, MAX_INTERVAL_MS));
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [key, symbols.length]);

  const quotes = useMemo(
    () => new Map((snapshot?.quotes ?? []).map((quote) => [quote.symbol, quote])),
    [snapshot],
  );
  return { quotes, snapshot, error };
}
