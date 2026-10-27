import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DividendAssumption } from '../shared/types.ts';

export interface AssumptionStore {
  load(): DividendAssumption[];
  save(items: DividendAssumption[]): void;
}

export function createMemoryAssumptionStore(initial: DividendAssumption[] = []): AssumptionStore {
  let items = [...initial];
  return {
    load: () => [...items],
    save: (next) => {
      items = [...next];
    },
  };
}

/** 已保存假设落盘，服务重启后按同一版本恢复。 */
export function createFileAssumptionStore(filePath: string): AssumptionStore {
  return {
    load() {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { items?: unknown };
        return Array.isArray(parsed.items) ? (parsed.items as DividendAssumption[]) : [];
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          console.warn(`读取分红假设文件失败，将使用默认假设：${(error as Error).message}`);
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
