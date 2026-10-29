import type { DemoState } from './state.ts';
import type { ResearchLevel, Stock } from '../shared/types.ts';

/** 提醒冷却窗口：同一等级、同一假设与同一风险签名在窗口内只提醒一次。 */
export const ADVICE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** 已发送的提醒记录，仅用于抑制重复通知，不参与研究结论计算。 */
export interface AdviceNotice {
  level: ResearchLevel;
  /** 提醒发送时生效的假设版本；假设变化即重新评估提醒资格。 */
  assumptionVersion: number;
  /** 提醒发送时的股票级风险签名；任一条风险状态变化即重新评估。 */
  riskSignature: string;
  at: number;
}

export interface ReminderDecision {
  notify: boolean;
  reason: string;
}

/**
 * 提醒资格：只回答“这次要不要发提醒”，不改变等级、动作与原因。
 * 分红假设或风险状态变化时，视为新的提醒场景重新评估。
 */
export function evaluateReminder(
  state: DemoState,
  stock: Stock,
  now = Date.now(),
): ReminderDecision {
  if (stock.level === 'L0') {
    return { notify: false, reason: '当前为L0，不产生提醒' };
  }

  const previous = state.lastNotices.get(stock.symbol);
  if (!previous) {
    return { notify: true, reason: '首次触发该等级的研究提醒' };
  }

  const changed =
    previous.level !== stock.level ||
    previous.assumptionVersion !== stock.assumptionVersion ||
    previous.riskSignature !== stock.riskGate.signature;
  if (changed) {
    return { notify: true, reason: '研究等级、分红假设或风险核验状态变化，重新评估提醒' };
  }

  if (now < previous.at || now - previous.at >= ADVICE_COOLDOWN_MS) {
    return { notify: true, reason: '已超出24小时冷却期，重新发送提醒' };
  }

  return { notify: false, reason: '同一等级与假设处于24小时冷却期，仅抑制重复提醒' };
}

/** 状态变更事件（保存假设、更新门槛、人工核验）触发；GET 路由不得调用。 */
export function dispatchReminder(
  state: DemoState,
  stock: Stock,
  now = Date.now(),
): ReminderDecision {
  if (stock.level === 'L0') {
    state.lastNotices.delete(stock.symbol);
    return { notify: false, reason: '当前为L0，不产生提醒' };
  }

  const decision = evaluateReminder(state, stock, now);
  if (decision.notify) {
    state.lastNotices.set(stock.symbol, {
      level: stock.level,
      assumptionVersion: stock.assumptionVersion,
      riskSignature: stock.riskGate.signature,
      at: now,
    });
  }
  return decision;
}
