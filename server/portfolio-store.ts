import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PersistedPortfolio } from '../shared/types.ts';

export interface PortfolioStore {
  load(): PersistedPortfolio | null;
  save(state: PersistedPortfolio): void;
}

export function createMemoryPortfolioStore(
  initial: PersistedPortfolio | null = null,
): PortfolioStore {
  let items = initial;
  return {
    load: () => (items ? structuredClone(items) : null),
    save: (next) => {
      items = structuredClone(next);
    },
  };
}

/** 观察仓、现金、持仓与交易账本落盘，服务重启后按同一状态恢复。 */
export function createFilePortfolioStore(filePath: string): PortfolioStore {
  return {
    load() {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PersistedPortfolio>;
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed as PersistedPortfolio;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          console.warn(`读取组合状态文件失败，将使用演示初始状态：${(error as Error).message}`);
        }
        return null;
      }
    },
    save(state) {
      mkdirSync(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify({ version: 1, ...state }, null, 2), 'utf8');
      renameSync(temporaryPath, filePath);
    },
  };
}
