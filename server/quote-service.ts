import type { DataMode } from '../shared/types.ts';
import type {
  Quote,
  QuoteDegraded,
  QuoteProvider,
  QuoteSnapshotResponse,
  QuoteSource,
  RawQuote,
} from '../shared/quote-types.ts';
import { resolveSessionState } from './trading-session.ts';

/** 熔断器：连续失败达到阈值后打开一段时间，期间跳过该源，避免把免费源打到封 IP。 */
class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold: number,
    private readonly openMs: number,
  ) {}

  /** 打开超过 openMs 后视为半开：允许再次尝试，失败会重新打开。 */
  isOpen(): boolean {
    return this.openedAt > 0 && Date.now() - this.openedAt < this.openMs;
  }

  succeed(): void {
    this.failures = 0;
    this.openedAt = 0;
  }

  fail(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openedAt = Date.now();
    }
  }
}

/** 令牌桶：以固定速率补充令牌，突发容量限制瞬时请求。 */
function createTokenBucket(ratePerSecond: number, capacity: number) {
  let tokens = capacity;
  let last = Date.now();
  return async function take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(capacity, tokens + ((now - last) / 1000) * ratePerSecond);
      last = now;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
}

function chunk(items: string[], size: number): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export interface QuoteServiceOptions {
  /**
   * 展示层的数据模式。传函数以动态读取（live 切换发生在启动装配阶段，
   * 晚于 service 构造，静态值会把 demo 快照进响应）。
   */
  dataMode: () => DataMode;
  /** 源降级顺序，第一个为主源。 */
  fallbackOrder: QuoteSource[];
  /** 盘中缓存 TTL；必须小于前端轮询间隔，否则缓存形同虚设。 */
  ttlMs: number;
  /** 收盘后 TTL：行情已定格，可大幅放宽以减少无效请求。 */
  closedTtlMs: number;
  /** 盘中陈旧阈值（距最近一次成功抓取）；收盘/午休由 sessionState 表达，不判 stale。 */
  staleMs: number;
  /** 单次上游请求超时。 */
  requestTimeoutMs: number;
  /** 令牌桶速率（次/秒）与突发容量。 */
  ratePerSecond: number;
  rateCapacity: number;
  /** 熔断阈值（连续失败次数）与打开时长。 */
  breakerThreshold: number;
  breakerOpenMs: number;
  /**
   * 每批快照成功写入缓存后的回调（P1：实时价覆盖当日日线，进入研究派生链）。
   * 回调抛错只记日志，不影响行情缓存。
   */
  onUpdate?: (quotes: RawQuote[]) => void;
  /** 重启预热：把上一次落盘的成功快照注入缓存（立即过期，下次刷新优先拉新，失败则降级读它）。 */
  seed?: { quotes: RawQuote[]; savedAt: number };
}

export interface QuoteService {
  getSnapshot(symbols: string[]): Promise<QuoteSnapshotResponse>;
  /** 供 scheduler 主动预取；失败只记日志，不抛给调用方。 */
  refresh(symbols: string[]): Promise<void>;
}

export function createQuoteService(
  providers: Map<QuoteSource, QuoteProvider>,
  options: QuoteServiceOptions,
): QuoteService {
  interface CacheEntry {
    quote: Quote;
    expiresAt: number;
    /** 最近一次成功抓取时间：陈旧度只看它，不看数据源自带的快照时间（见报告 §5.5）。 */
    lastSuccessAt: number;
  }

  const cache = new Map<string, CacheEntry>();
  /** 同一批标的的并发请求只打一次上游（多标签页同时刷新时尤其重要）。 */
  const inflight = new Map<string, Promise<void>>();
  const breakers = new Map<QuoteSource, CircuitBreaker>();
  const take = createTokenBucket(options.ratePerSecond, options.rateCapacity);
  /** 最近一次主源失败降级记录；成功走主源时清除。 */
  let lastDegraded: QuoteDegraded | null = null;

  for (const source of options.fallbackOrder) {
    if (!providers.has(source)) {
      throw new Error(`fallbackOrder 中的行情源未注册：${source}`);
    }
    breakers.set(source, new CircuitBreaker(options.breakerThreshold, options.breakerOpenMs));
  }

  // 重启预热：注入上一次落盘的快照；expiresAt=0 让下次刷新优先拉新，上游失败时降级读它。
  if (options.seed && options.seed.quotes.length > 0) {
    for (const raw of options.seed.quotes) {
      cache.set(raw.symbol, {
        quote: { ...raw, sessionState: 'closed', stale: false, staleSeconds: 0 },
        expiresAt: 0,
        lastSuccessAt: options.seed.savedAt,
      });
    }
    console.log(`行情缓存已预热：${options.seed.quotes.length} 只（快照落盘于 ${new Date(options.seed.savedAt).toISOString()}）`);
  }

  /** 单批大小：取降级链上所有源的 maxBatch 最小值，保证切源后批次仍然有效。 */
  const batchSize = Math.min(
    ...options.fallbackOrder.map((source) => providers.get(source)!.maxBatch),
  );

  async function loadBatch(
    batch: string[],
  ): Promise<{ quotes: RawQuote[]; degraded: QuoteDegraded | null }> {
    const errors: string[] = [];
    /** 降级永远相对于配置的主源：主源熔断跳过同样算降级，必须如实透传给前端。 */
    const primary = options.fallbackOrder[0];

    for (const source of options.fallbackOrder) {
      const provider = providers.get(source)!;
      const breaker = breakers.get(source)!;
      if (breaker.isOpen()) {
        errors.push(`${source}: 熔断中`);
        continue;
      }
      try {
        const quotes = await provider.fetchQuotes(
          batch,
          AbortSignal.timeout(options.requestTimeoutMs),
        );
        breaker.succeed();
        const degraded =
          source !== primary ? { from: primary, to: source, reason: errors.join('；') } : null;
        return { quotes, degraded };
      } catch (reason) {
        breaker.fail();
        errors.push(`${source}: ${(reason as Error).message}`);
      }
    }
    throw new Error(`全部行情源失败：${errors.join('；')}`);
  }

  async function refresh(symbols: string[]): Promise<void> {
    if (symbols.length === 0) return;
    const key = [...symbols].sort().join(',');
    const running = inflight.get(key);
    if (running) return running;

    const task = (async () => {
      const session = resolveSessionState();
      const ttl = session === 'open' ? options.ttlMs : options.closedTtlMs;
      const now = Date.now();
      const missing = symbols.filter((symbol) => {
        const entry = cache.get(symbol);
        return !entry || entry.expiresAt <= now;
      });
      if (missing.length === 0) return;

      for (const batch of chunk(missing, batchSize)) {
        await take();
        const { quotes, degraded } = await loadBatch(batch);
        if (degraded) lastDegraded = degraded;
        else lastDegraded = null;

        const fetchedAt = Date.now();
        for (const raw of quotes) {
          cache.set(raw.symbol, {
            quote: { ...raw, sessionState: session, stale: false, staleSeconds: 0 },
            expiresAt: fetchedAt + ttl,
            lastSuccessAt: fetchedAt,
          });
        }
        if (options.onUpdate) {
          try {
            options.onUpdate(quotes);
          } catch (reason) {
            console.error(`[quote] onUpdate 回调失败：${(reason as Error).message}`);
          }
        }
      }
    })().finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
  }

  async function getSnapshot(symbols: string[]): Promise<QuoteSnapshotResponse> {
    // 上游失败时降级返回上一次成功的快照（带陈旧标记），绝不返回空数组让前端显示 0。
    try {
      await refresh(symbols);
    } catch (reason) {
      console.error(`[quote] 刷新失败，降级返回缓存：${(reason as Error).message}`);
    }

    const session = resolveSessionState();
    const now = Date.now();
    const quotes = symbols
      .map((symbol) => cache.get(symbol))
      .filter((entry): entry is CacheEntry => Boolean(entry))
      .map(({ quote, lastSuccessAt }) => {
        const staleSeconds = Math.max(0, Math.round((now - lastSuccessAt) / 1000));
        return {
          ...quote,
          sessionState: session,
          stale: session === 'open' && now - lastSuccessAt > options.staleMs,
          staleSeconds,
        };
      });

    return { dataMode: options.dataMode(), sessionState: session, quotes, degraded: lastDegraded };
  }

  return { getSnapshot, refresh };
}
