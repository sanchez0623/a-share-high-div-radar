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

/**
 * 写事务的可变副本：所有写路由先在副本上完成变更，落盘成功后才替换内存。
 * 行情、分红历史与质量输入的「条目」只读，条目内部数据共享引用；
 * 但 Map 本身必须复制：动态添加/停用股票要增删这些 Map 的键，
 * 复制后落盘失败才不会把半成品状态泄漏进当前内存。
 */
export function cloneDemoState(state: DemoState): DemoState {
  return {
    stocks: new Map(
      Array.from(state.stocks, ([symbol, stock]) => [symbol, structuredClone(stock)]),
    ),
    histories: new Map(state.histories),
    dividends: new Map(state.dividends),
    assumptions: new Map(
      Array.from(state.assumptions, ([symbol, item]) => [symbol, structuredClone(item)]),
    ),
    qualityInputs: new Map(state.qualityInputs),
    risks: state.risks.map((record) => structuredClone(record)),
    watchlist: new Set(state.watchlist),
    cash: state.cash,
    holdings: new Map(
      Array.from(state.holdings, ([symbol, holding]) => [symbol, { ...holding }]),
    ),
    lastNotices: new Map(
      Array.from(state.lastNotices, ([symbol, notice]) => [symbol, { ...notice }]),
    ),
    trades: [...state.trades],
  };
}

/** 落盘成功后的唯一提交点：整体替换副本中可变的字段，外部持有的 state 引用依然有效。 */
export function commitDemoState(target: DemoState, draft: DemoState): void {
  target.stocks = draft.stocks;
  target.histories = draft.histories;
  target.dividends = draft.dividends;
  target.qualityInputs = draft.qualityInputs;
  target.assumptions = draft.assumptions;
  target.risks = draft.risks;
  target.watchlist = draft.watchlist;
  target.cash = draft.cash;
  target.holdings = draft.holdings;
  target.lastNotices = draft.lastNotices;
  target.trades = draft.trades;
}
