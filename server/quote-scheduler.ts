import type { QuoteService } from './quote-service.ts';
import { resolveSessionState } from './trading-session.ts';

/**
 * 盘中行情轮询：仅交易时段按固定间隔预取观察仓/持仓行情。
 *
 * - 防重入：上一轮未结束时跳过本轮，避免请求堆积。
 * - unref：不阻塞进程退出；停服时先 stop() 再关 HTTP server。
 * - onSessionClosed：从 open 切到非 open 的边沿触发一次（P1：收盘固化当日日线）。
 */
export function startQuoteScheduler(
  service: QuoteService,
  collectSymbols: () => string[],
  intervalMs: number,
  onSessionClosed?: () => void | Promise<void>,
): () => void {
  let running = false;
  let lastSession: ReturnType<typeof resolveSessionState> | null = null;
  const timer = setInterval(() => {
    const session = resolveSessionState();
    const previous = lastSession;
    lastSession = session;
    // 收盘边沿：上一 tick 还是 open，本 tick 已收盘 → 触发一次固化回调。
    if (previous === 'open' && session !== 'open' && onSessionClosed) {
      void Promise.resolve()
        .then(onSessionClosed)
        .catch((reason: unknown) => {
          console.error(`[quote] 收盘固化失败：${(reason as Error).message}`);
        });
    }
    if (running) return;
    // 非交易时段不轮询；收盘后的按需刷新由 /api/quotes 的 TTL 缓存兜底。
    if (session !== 'open') return;
    running = true;
    service
      .refresh(collectSymbols())
      .catch((reason: unknown) => {
        console.error(`[quote] 预取失败：${(reason as Error).message}`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
