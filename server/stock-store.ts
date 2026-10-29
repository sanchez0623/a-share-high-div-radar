import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PersistenceError } from './errors.ts';

/**
 * 动态添加股票的落盘（server/.data/stocks.json）。
 *
 * 设计约束（见 docs/dynamic-stock-watchlist.md §2.1）：
 * - 只存「代码 → 静态研究口径」与停用状态；行情、日线、风险、假设各有自己的 store。
 * - 启用状态的自定义股票必须落盘（重启后重建研究口径）；
 *   停用的种子股票也落盘（种子本体在代码里，只需记住「谁被停用了」）。
 * - 原子写与 settings-store 同一模式：临时文件 + rename。
 */

/** 记录种类：seed = 内置演示股票（仅停用时落盘）；custom = 用户新增。 */
export type StockKind = 'seed' | 'custom';

export interface PersistedStockRecord {
  /** 统一 601318.SH / 000333.SZ 格式（与 state.stocks 键一致）。 */
  symbol: string;
  name: string;
  kind: StockKind;
  /** 软删除标记：停用的股票从雷达/观察仓/行情中隐藏，可随时恢复。 */
  disabled: boolean;
  sector: string;
  /** 自定义股票的添加日期（YYYY-MM-DD）；种子为空串。 */
  addedAt: string;
  /** 用户录入的预测每股分红；免费源无可靠预测，0 表示未录入。 */
  forecastDividend: number;
  buyThreshold: number;
  /** 添加时行情捎带的估值（腾讯 f39/f46）；缺失为 null，live 模式随行情快照动态更新。 */
  pe: number | null;
  pb: number | null;
  /** 添加时的收盘参考价；日线缓存缺失时用于合成占位序列。 */
  price: number;
}

export interface PersistedStocks {
  version: 1;
  stocks: PersistedStockRecord[];
}

export interface StockStore {
  /** `null` 仅表示文件尚未创建（首次启动）；文件损坏时抛出 PersistenceError，禁止静默降级。 */
  load(): PersistedStocks | null;
  save(data: PersistedStocks): void;
}

/** 新增股票的缺省买入门槛（%）；与种子区间（5–6）一致，用户可显式覆盖。 */
export const DEFAULT_BUY_THRESHOLD = 5;

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 单条记录白名单校验：不合法的记录直接丢弃，不让手改文件污染整个列表。 */
export function parseStockRecord(raw: unknown): PersistedStockRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.symbol !== 'string' || !/^\d{6}\.(SH|SZ)$/.test(record.symbol)) return null;
  if (record.kind !== 'seed' && record.kind !== 'custom') return null;
  const finiteOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    symbol: record.symbol,
    name: typeof record.name === 'string' && record.name.length > 0 ? record.name : record.symbol,
    kind: record.kind,
    disabled: record.disabled === true,
    sector: typeof record.sector === 'string' ? record.sector : '',
    addedAt: typeof record.addedAt === 'string' ? record.addedAt : '',
    forecastDividend: Math.max(0, numberOf(record.forecastDividend, 0)),
    buyThreshold: numberOf(record.buyThreshold, DEFAULT_BUY_THRESHOLD),
    pe: finiteOrNull(record.pe),
    pb: finiteOrNull(record.pb),
    price: Math.max(0, numberOf(record.price, 0)),
  };
}

export function createMemoryStockStore(initial: PersistedStocks | null = null): StockStore {
  let items = initial ? structuredClone(initial) : null;
  return {
    load: () => (items ? structuredClone(items) : null),
    save: (next) => {
      items = structuredClone(next);
    },
  };
}

/** 自定义股票与停用记录落盘，保证重启后研究全集与停用状态不丢。 */
export function createFileStockStore(filePath: string): StockStore {
  return {
    load() {
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch (error) {
        /** 只有文件不存在才是首次启动；其余（权限、磁盘错误等）一律拒绝启动。 */
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new PersistenceError(`无法读取股票列表文件 ${filePath}：${(error as Error).message}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new PersistenceError(`股票列表文件 ${filePath} 的 JSON 解析失败：${(error as Error).message}`);
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PersistenceError(`股票列表文件 ${filePath} 格式无效：根节点必须为 JSON 对象`);
      }
      const stocks = (parsed as { stocks?: unknown }).stocks;
      if (!Array.isArray(stocks)) {
        throw new PersistenceError(`股票列表文件 ${filePath} 格式无效：stocks 必须为数组`);
      }
      const valid = stocks
        .map((item) => parseStockRecord(item))
        .filter((item): item is PersistedStockRecord => item !== null);
      return { version: 1, stocks: valid };
    },
    save(data) {
      mkdirSync(dirname(filePath), { recursive: true });
      // 唯一临时名（pid + 时间戳）：避免 tsx 重启并发窗口下 rename 竞态 ENOENT。
      const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify(data, null, 2), 'utf8');
      renameSync(temporaryPath, filePath);
    },
  };
}
