import type {
  DividendAssumption,
  DividendRecord,
  PriceBar,
  RiskEventRecord,
  Stock,
  TradeRecord,
} from '../shared/types.ts';
import type { DividendQualityInput } from './dividend-quality.ts';
import type { AdviceNotice } from './reminder.ts';

export interface Holding {
  shares: number;
  cost: number;
  /** 建仓时记录的已保存假设版本，null 表示按默认假设建仓。 */
  assumptionVersion: number | null;
}

/**
 * 演示环境的内存状态，只保存“事实”：
 * 行情、分红记录、用户假设、风险原文、持仓与账本。
 * 等级、评分、信号、风险闸门等派生结论一律由 snapshot.ts 纯计算得出，不在此缓存。
 */
export interface DemoState {
  /** 股票研究口径（预测分红、门槛、质量）；等级/动作/闸门每次读取时重算。 */
  stocks: Map<string, Stock>;
  histories: Map<string, PriceBar[]>;
  dividends: Map<string, DividendRecord[]>;
  /** 已保存的分红假设，按股票代码索引；临时预览不写入这里。 */
  assumptions: Map<string, DividendAssumption>;
  /** 分红质量检查所需的原始财务口径，按股票代码索引。 */
  qualityInputs: Map<string, DividendQualityInput>;
  /** 风险事项的原文与核验记录；核验状态一律派生，不存储。 */
  risks: RiskEventRecord[];
  watchlist: Set<string>;
  cash: number;
  holdings: Map<string, Holding>;
  /** 提醒冷却记录：只影响提醒事件，绝不改变等级、动作与原因。 */
  lastNotices: Map<string, AdviceNotice>;
  /** 模拟交易账本，最新一笔在前。 */
  trades: TradeRecord[];
}
