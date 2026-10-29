import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DividendEvent } from './providers/tencent-fqkline.ts';

/**
 * 分红事件落盘（server/.data/dividend-events/{SYMBOL}.json）。
 *
 * 数据来自腾讯 fqkline 除权日 bar 捎带的分红 dict（免费路线），
 * 仅做原始事件缓存；是否接入研究口径（receivedDividend/dividends）由业务层另行决策，
 * 因为涉及权益股数、税务与预测抵扣规则。
 */

const FILE_PATH_TEMPLATE = fileURLToPath(new URL('./.data/dividend-events/x.json', import.meta.url));

interface DividendEventsFile {
  version: 1;
  symbol: string;
  syncedAt: string;
  events: DividendEvent[];
}

function filePath(symbol: string): string {
  return FILE_PATH_TEMPLATE.replace('x.json', `${symbol}.json`);
}

export function saveDividendEvents(symbol: string, events: DividendEvent[]): void {
  const path = filePath(symbol);
  mkdirSync(fileURLToPath(new URL('./.data/dividend-events/', import.meta.url)), { recursive: true });
  const payload: DividendEventsFile = { version: 1, symbol, syncedAt: new Date().toISOString(), events };
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(temporaryPath, path);
}

export function loadDividendEvents(symbol: string): DividendEvent[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath(symbol), 'utf8')) as DividendEventsFile;
    return parsed.version === 1 && Array.isArray(parsed.events) ? parsed.events : [];
  } catch {
    return [];
  }
}
