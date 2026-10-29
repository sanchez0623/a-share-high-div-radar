/**
 * 行情源探测脚本（示例，未接入主流程）。
 *
 * 用途：直接调用 server/providers/ 下的真实 provider（腾讯/新浪/东财），
 * 验证本机网络连通性、字段口径与 provider 解析逻辑，作为 P0 接入的端到端冒烟工具。
 *
 * 运行：
 *   npx tsx scripts/live-quote-probe.ts
 *   npx tsx scripts/live-quote-probe.ts 601318.SH 600941.SH --source=sina
 *
 * 注意：
 *   - 仅用于本机研究；免费接口没有面向商用的公开授权，不要对外提供再分发服务。
 *   - 新浪接口必须带 Referer，缺省会被拒绝；腾讯/东财不要高频轮询。
 *   - 输出里的 STALE/FRESH 基于数据源快照时间，仅供探测参考——
 *     生产环境的陈旧判定用「最近一次成功抓取时间 + 交易时段」（docs/live-data-integration.md §5.5）。
 */

import { eastmoneyProvider } from '../server/providers/eastmoney.ts';
import { sinaProvider } from '../server/providers/sina.ts';
import { tencentProvider } from '../server/providers/tencent.ts';
import type { QuoteProvider, RawQuote } from '../shared/quote-types.ts';

const DEFAULT_SYMBOLS = ['601318.SH', '600941.SH', '000333.SZ'];

const providers: Record<string, QuoteProvider> = {
  tencent: tencentProvider,
  sina: sinaProvider,
  eastmoney: eastmoneyProvider,
};

/** 仅供探测参考：把数据源快照时间与阈值比较（生产环境不要这样做，理由见文件头注释）。 */
function withStaleness(quote: RawQuote, staleMs: number): RawQuote & { stale: boolean; quoteTimeAgeMs: number } {
  const quoteTimeAgeMs = Date.now() - Date.parse(quote.quoteTime);
  return { ...quote, stale: quoteTimeAgeMs > staleMs, quoteTimeAgeMs };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sourceArg = args.find((arg) => arg.startsWith('--source='))?.split('=')[1];
  const source = sourceArg ?? 'tencent';
  const symbols = args.filter((arg) => !arg.startsWith('--'));
  const watchlist = symbols.length > 0 ? symbols : DEFAULT_SYMBOLS;

  const provider = providers[source];
  if (!provider) {
    throw new Error(`未知行情源：${source}（可选 ${Object.keys(providers).join('/')}）`);
  }

  const startedAt = Date.now();
  const quotes = (await provider.fetchQuotes(watchlist)).map((quote) =>
    withStaleness(quote, Number(process.env.QUOTE_STALE_MS) || 60_000),
  );

  console.log(
    `source=${source} 请求耗时=${Date.now() - startedAt}ms 条数=${quotes.length}` +
      ` quoteTimeReliable=${provider.quoteTimeReliable}`,
  );
  for (const quote of quotes) {
    console.log(
      [
        quote.symbol,
        quote.name,
        `price=${quote.price}`,
        `changePct=${quote.changePct.toFixed(2)}%`,
        `volume=${quote.volume}`,
        `quoteTime=${quote.quoteTime}`,
        `quoteTimeAgeMs=${quote.quoteTimeAgeMs}`,
        quote.stale ? 'STALE' : 'FRESH',
      ].join(' | '),
    );
  }
  console.log(JSON.stringify(quotes, null, 2));
}

const invokedDirectly = process.argv[1]?.endsWith('live-quote-probe.ts') ?? false;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('行情探测失败：', (error as Error).message);
    process.exitCode = 1;
  });
}
