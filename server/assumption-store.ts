import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DividendAssumption } from '../shared/types.ts';
import { PersistenceError } from './errors.ts';

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
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch (error) {
        /** 只有文件不存在才是首次启动；其余（权限、磁盘错误等）一律拒绝启动。 */
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw new PersistenceError(
          `无法读取分红假设文件 ${filePath}：${(error as Error).message}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new PersistenceError(
          `分红假设文件 ${filePath} 的 JSON 解析失败：${(error as Error).message}`,
        );
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PersistenceError(
          `分红假设文件 ${filePath} 格式无效：根节点必须为 JSON 对象`,
        );
      }
      const items = (parsed as { items?: unknown }).items;
      if (!Array.isArray(items)) {
        throw new PersistenceError(
          `分红假设文件 ${filePath} 格式无效：items 必须为数组`,
        );
      }
      return items as DividendAssumption[];
    },
    save(items) {
      mkdirSync(dirname(filePath), { recursive: true });
      // 唯一临时名（pid + 时间戳）：避免 tsx 重启并发窗口下 rename 竞态 ENOENT。
      const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
      renameSync(temporaryPath, filePath);
    },
  };
}
