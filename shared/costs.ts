import { roundTo } from './assumptions.ts';

/**
 * A 股模拟交易费用与红利税口径。
 * 全部为演示参数，真实交易以券商佣金方案与税务规则为准。
 */
export const COMMISSION_RATE = 0.00025;
export const MIN_COMMISSION = 5;
export const TRANSFER_FEE_RATE = 0.00001;
export const STAMP_DUTY_RATE = 0.0005;
/** 演示口径：持股 1 个月至 1 年的红利税 10%。 */
export const DIVIDEND_TAX_RATE = 0.1;

/** A股最小报价单位（元），成交价格必须是它的整数倍。 */
export const PRICE_TICK = 0.01;
/** 最小有效成交价格（元）；低于它的价格会让成交金额舍入成零，必须拒绝。 */
export const MIN_TRADE_PRICE = 0.01;

export interface TradeFees {
  /** 佣金（不足 5 元按 5 元计）。 */
  commission: number;
  /** 过户费。 */
  transferFee: number;
  /** 卖出印花税；买入为 0。 */
  stampDuty: number;
  /** 费用合计。 */
  total: number;
}

/** 按成交金额估算买入/卖出费用，分配计划与模拟账本共用同一口径。 */
export function estimateTradeFees(side: 'buy' | 'sell', grossAmount: number): TradeFees {
  if (!Number.isFinite(grossAmount) || grossAmount <= 0) {
    return { commission: 0, transferFee: 0, stampDuty: 0, total: 0 };
  }
  const commission = roundTo(Math.max(MIN_COMMISSION, grossAmount * COMMISSION_RATE));
  const transferFee = roundTo(grossAmount * TRANSFER_FEE_RATE);
  const stampDuty = side === 'sell' ? roundTo(grossAmount * STAMP_DUTY_RATE) : 0;
  return {
    commission,
    transferFee,
    stampDuty,
    total: roundTo(commission + transferFee + stampDuty),
  };
}

/** 单笔买入的现金流出：成交金额 + 佣金与过户费。 */
export function buyCashOutflow(grossAmount: number): number {
  const fees = estimateTradeFees('buy', grossAmount);
  return roundTo(grossAmount + fees.total);
}
