import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PersistenceError } from './errors.ts';

/**
 * 尚未形成正式假设时的用户设置。
 * 买入门槛既是研究口径也是计划价格的计算依据，只写内存会让重启后的门槛回到演示默认值。
 */
export interface PersistedSettings {
  /** 股票代码 → 买入门槛（百分比）；仅保存没有正式假设的标的。 */
  buyThresholds: Record<string, number>;
}

export interface SettingsStore {
  load(): PersistedSettings | null;
  save(settings: PersistedSettings): void;
}

export function createMemorySettingsStore(initial: PersistedSettings | null = null): SettingsStore {
  let items = initial ? structuredClone(initial) : null;
  return {
    load: () => (items ? structuredClone(items) : null),
    save: (next) => {
      items = structuredClone(next);
    },
  };
}

/** 门槛设置落盘，保证没有正式假设时重启后仍沿用用户设定。 */
export function createFileSettingsStore(filePath: string): SettingsStore {
  return {
    load() {
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch (error) {
        /** 只有文件不存在才是首次启动；其余（权限、磁盘错误等）一律拒绝启动。 */
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new PersistenceError(
          `无法读取设置文件 ${filePath}：${(error as Error).message}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new PersistenceError(
          `设置文件 ${filePath} 的 JSON 解析失败：${(error as Error).message}`,
        );
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PersistenceError(
          `设置文件 ${filePath} 格式无效：根节点必须为 JSON 对象`,
        );
      }
      const thresholds = (parsed as { buyThresholds?: unknown }).buyThresholds;
      if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
        throw new PersistenceError(
          `设置文件 ${filePath} 格式无效：buyThresholds 必须为对象`,
        );
      }
      return { buyThresholds: thresholds as Record<string, number> };
    },
    save(settings) {
      mkdirSync(dirname(filePath), { recursive: true });
      // 唯一临时名（pid + 时间戳）：避免 tsx 重启并发窗口下 rename 竞态 ENOENT。
      const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify({ version: 1, ...settings }, null, 2), 'utf8');
      renameSync(temporaryPath, filePath);
    },
  };
}
