import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DividendEvent } from './providers/tencent-fqkline.ts';

/**
 * 分红事件落盘（server/.data/dividend-events/{SYMBOL}.json）。
 *
 * 数据来自腾讯 fqkline 除权日 bar 捎带的分红 dict（免费路线），
 * 供启动装配把真实分红年度历史接入研究口径（dividend-history.ts）；
 * receivedDividend/pendingDividend 涉及权益股数、税务与预测抵扣规则，仍由业务层另行决策。
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
  // 临时文件名带 pid + 时间戳：tsx watch 重启时新旧进程短暂共存，会并发写同一 symbol；
  // 固定 .tmp 名会被另一方 rename 走，导致 renameSync ENOENT。
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(temporaryPath, path);
}

export interface DividendEventsSnapshot {
  syncedAt: string;
  events: DividendEvent[];
}

/** 读取落盘的分红事件（含同步时间）；文件缺失或损坏返回 null，由调用方回退种子口径。 */
export function loadDividendEventsFile(symbol: string): DividendEventsSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath(symbol), 'utf8')) as DividendEventsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.events)) return null;
    return { syncedAt: parsed.syncedAt, events: parsed.events };
  } catch {
    return null;
  }
}
