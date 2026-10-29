import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RiskEventRecord } from '../shared/types.ts';
import { RiskPersistenceError } from './errors.ts';

export interface RiskStore {
  /**
   * 读取已落盘的风险记录。
   * `null` 仅表示文件尚未创建（首次启动，可以使用演示种子）；
   * 空数组表示文件存在且确实是空记录，不能再回退演示种子。
   * 文件存在但损坏或不可读时必须抛出错误，禁止静默降级。
   */
  load(): RiskEventRecord[] | null;
  save(items: RiskEventRecord[]): void;
}

export function createMemoryRiskStore(initial: RiskEventRecord[] | null = null): RiskStore {
  let items = initial === null ? null : [...initial];
  return {
    load: () => (items === null ? null : [...items]),
    save: (next) => {
      items = [...next];
    },
  };
}

/** 风险原文与核验记录落盘，保证核验可跨重启追溯。 */
export function createFileRiskStore(filePath: string): RiskStore {
  return {
    load() {
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch (error) {
        /** 只有文件不存在才是首次启动；其余（权限、磁盘错误等）一律拒绝启动。 */
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new RiskPersistenceError(
          `无法读取风险核验文件 ${filePath}：${(error as Error).message}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new RiskPersistenceError(
          `风险核验文件 ${filePath} 的 JSON 解析失败：${(error as Error).message}`,
        );
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new RiskPersistenceError(
          `风险核验文件 ${filePath} 格式无效：根节点必须为 JSON 对象`,
        );
      }
      const items = (parsed as { items?: unknown }).items;
      if (!Array.isArray(items)) {
        throw new RiskPersistenceError(
          `风险核验文件 ${filePath} 格式无效：items 必须为数组`,
        );
      }
      /** 单条记录的结构校验由 hydrateRisks 统一完成，任何一条不合法都会阻止启动。 */
      return items as RiskEventRecord[];
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
