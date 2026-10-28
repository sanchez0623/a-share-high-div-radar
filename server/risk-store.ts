import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RiskEventRecord } from '../shared/types.ts';

export interface RiskStore {
  load(): RiskEventRecord[];
  save(items: RiskEventRecord[]): void;
}

export function createMemoryRiskStore(initial: RiskEventRecord[] = []): RiskStore {
  let items = [...initial];
  return {
    load: () => [...items],
    save: (next) => {
      items = [...next];
    },
  };
}

/** 风险原文与核验记录落盘，保证核验可跨重启追溯。 */
export function createFileRiskStore(filePath: string): RiskStore {
  return {
    load() {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { items?: unknown };
        return Array.isArray(parsed.items) ? (parsed.items as RiskEventRecord[]) : [];
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          console.warn(`读取风险核验文件失败，将使用演示种子：${(error as Error).message}`);
        }
        return [];
      }
    },
    save(items) {
      mkdirSync(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
      renameSync(temporaryPath, filePath);
    },
  };
}
