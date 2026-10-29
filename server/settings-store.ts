import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PersistedSettings>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const thresholds = parsed.buyThresholds;
        if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) return null;
        return { buyThresholds: thresholds as Record<string, number> };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          console.warn(`读取设置文件失败，将使用演示默认门槛：${(error as Error).message}`);
        }
        return null;
      }
    },
    save(settings) {
      mkdirSync(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify({ version: 1, ...settings }, null, 2), 'utf8');
      renameSync(temporaryPath, filePath);
    },
  };
}
