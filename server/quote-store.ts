import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RawQuote } from '../shared/quote-types.ts';

/**
 * 最新行情快照持久化（server/.data/quotes-latest.json）。
 *
 * 用途：重启预热——上游暂时不可用时，getSnapshot 仍能返回上一次成功的真实快照
 * （陈旧度由 quote-service 按抓取时间如实标注），而不是空白或演示数据。
 * 盘中逐次快照不落库，只覆盖写“最新一份”。
 */

const FILE_PATH = fileURLToPath(new URL('./.data/quotes-latest.json', import.meta.url));

interface LatestQuotesFile {
  version: number;
  /** 落盘时间（毫秒时间戳）。 */
  savedAt: number;
  quotes: RawQuote[];
}

export interface LatestQuoteSnapshot {
  quotes: RawQuote[];
  savedAt: number;
}

export function loadLatestQuotes(): LatestQuoteSnapshot {
  try {
    const parsed = JSON.parse(readFileSync(FILE_PATH, 'utf8')) as LatestQuotesFile;
    if (parsed.version === 1 && Array.isArray(parsed.quotes)) {
      return { quotes: parsed.quotes, savedAt: parsed.savedAt ?? 0 };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(`读取最新行情快照失败，将忽略预热数据：${(error as Error).message}`);
    }
  }
  return { quotes: [], savedAt: 0 };
}

export function saveLatestQuotes(quotes: RawQuote[]): void {
  mkdirSync(dirname(), { recursive: true });
  const payload: LatestQuotesFile = { version: 1, savedAt: Date.now(), quotes };
  const temporaryPath = `${FILE_PATH}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(temporaryPath, FILE_PATH);
}

function dirname(): string {
  return fileURLToPath(new URL('./.data/', import.meta.url));
}
