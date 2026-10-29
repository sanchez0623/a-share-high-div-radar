import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PersistedPortfolio } from '../shared/types.ts';
import { PersistenceError } from './errors.ts';

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
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch (error) {
        /** 只有文件不存在才是首次启动；其余（权限、磁盘错误等）一律拒绝启动。 */
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new PersistenceError(
          `无法读取组合状态文件 ${filePath}：${(error as Error).message}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new PersistenceError(
          `组合状态文件 ${filePath} 的 JSON 解析失败：${(error as Error).message}`,
        );
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PersistenceError(
          `组合状态文件 ${filePath} 格式无效：根节点必须为 JSON 对象`,
        );
      }
      /** 记录级合法性（观察仓、持仓、交易）由 hydratePortfolio 统一校验。 */
      return parsed as PersistedPortfolio;
    },
    save(state) {
      mkdirSync(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify({ version: 1, ...state }, null, 2), 'utf8');
      renameSync(temporaryPath, filePath);
    },
  };
}
