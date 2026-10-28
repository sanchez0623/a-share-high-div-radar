import type { PlanAllocation, PlanAllocationTier, PlanTier } from './types.ts';
import { estimateTradeFees } from './costs.ts';
import { roundTo } from './assumptions.ts';

/** 默认个股权重上限（%）。 */
export const DEFAULT_MAX_STOCK_WEIGHT = 30;
/** 默认行业权重上限（%）。 */
export const DEFAULT_MAX_SECTOR_WEIGHT = 50;
/** 默认最低现金储备比例：已到账现金的 20%。 */
export const MIN_CASH_RESERVE_RATIO = 0.2;

/** 可选的集中度上限，100 表示不设上限。 */
export const STOCK_WEIGHT_OPTIONS = [20, 25, 30, 35, 40, 50, 100];
export const SECTOR_WEIGHT_OPTIONS = [30, 40, 50, 60, 100];

export interface PlanAllocationInput {
  plan: PlanTier[];
  /** 用户设定的本次加仓预算。 */
  budget: number;
  /** 已到账可用现金，不含预计分红与已宣告待收。 */
  availableCash: number;
  minCashReserve: number;
  /** 组合总资产 = 已到账现金 + 持仓市值。 */
  totalAssets: number;
  /** 目标股票当前持仓市值。 */
  stockMarketValue: number;
  /** 目标股票所属行业当前持仓市值。 */
  sectorMarketValue: number;
  /** 行业名称，用于生成可读的超限原因。 */
  sector: string;
  maxStockWeight: number;
  maxSectorWeight: number;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function weightOf(value: number, assets: number): number {
  return assets > 0 ? roundTo((value / assets) * 100) : 0;
}

function formatAmount(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 在允许金额内反推 100 股整数倍、且含费用不超额的买入股数。 */
function affordableShares(price: number, allowed: number, referenceShares: number): number {
  if (!(price > 0) || !(allowed > 0)) return 0;
  let shares = Math.min(referenceShares, Math.floor(allowed / price / 100) * 100);
  while (shares > 0) {
    const gross = roundTo(shares * price);
    if (gross + estimateTradeFees('buy', gross).total <= allowed + 1e-9) break;
    shares -= 100;
  }
  return shares;
}

/**
 * 把三档研究价格转换成真正可执行的资金分配。
 * 各档共享同一笔预算并按档位顺序累计扣减，同时受最低现金储备、
 * 个股与行业集中度约束，受限时给出明确原因。
 */
export function buildPlanAllocation(input: PlanAllocationInput): PlanAllocation {
  const availableCash = Math.max(0, input.availableCash);
  const minCashReserve = Math.min(availableCash, Math.max(0, input.minCashReserve));
  const investableCash = roundTo(availableCash - minCashReserve);
  const requestedBudget = Math.max(0, input.budget);
  const approvedBudget = roundTo(Math.min(requestedBudget, investableCash));
  const totalAssets = Math.max(0, input.totalAssets);
  const maxStockWeight = clampPercent(input.maxStockWeight);
  const maxSectorWeight = clampPercent(input.maxSectorWeight);

  const notes: string[] = [];
  if (requestedBudget > investableCash) {
    notes.push(
      `本次预算 ¥${formatAmount(requestedBudget)} 超过可投入现金 ¥${formatAmount(investableCash)}（已到账 ¥${formatAmount(availableCash)} − 最低储备 ¥${formatAmount(minCashReserve)}），按可投入现金分配。`,
    );
  }
  if (minCashReserve > 0) {
    notes.push(
      `保留最低现金储备 ¥${formatAmount(minCashReserve)}；已宣告待收与预计分红都不计入可用现金。`,
    );
  }

  let remaining = approvedBudget;
  let stockValue = Math.max(0, input.stockMarketValue);
  let sectorValue = Math.max(0, input.sectorMarketValue);
  let cumulativeAmount = 0;
  let totalFees = 0;
  let totalShares = 0;

  const tiers: PlanAllocationTier[] = input.plan.map((tier) => {
    const price = tier.targetPrice ?? 0;
    const referenceShares = tier.shares;
    const blockers: string[] = [];
    let allocatedShares = 0;
    let allocatedAmount = 0;
    let allocatedFee = 0;

    if (!(price > 0)) {
      blockers.push('研究价格缺失，无法计算分配股数');
    } else if (approvedBudget <= 0) {
      blockers.push('本次可投入预算为 0，需先释放现金或调低最低储备');
    } else {
      /** 权重基数扣除已发生费用，保证预览与约束口径一致。 */
      const baseAssets = Math.max(0, totalAssets - totalFees);
      const stockRoom = Math.max(0, roundTo((baseAssets * maxStockWeight) / 100 - stockValue));
      const sectorRoom = Math.max(0, roundTo((baseAssets * maxSectorWeight) / 100 - sectorValue));
      const allowed = Math.min(remaining, stockRoom, sectorRoom);
      allocatedShares = affordableShares(price, allowed, referenceShares);
      const gross = roundTo(allocatedShares * price);
      allocatedFee = estimateTradeFees('buy', gross).total;
      allocatedAmount = roundTo(gross + allocatedFee);

      if (allocatedShares < referenceShares) {
        if (allocatedShares > 0) {
          blockers.push(`约束下最多分配 ${allocatedShares} 股（参考 ${referenceShares} 股）`);
        }
        const budgetBound = remaining <= stockRoom + 1e-9 && remaining <= sectorRoom + 1e-9;
        const stockBound = !budgetBound && stockRoom <= sectorRoom + 1e-9;
        if (budgetBound) {
          blockers.push(`剩余预算 ¥${formatAmount(remaining)} 不足以按 100 股整数倍继续买入`);
        } else if (stockBound) {
          blockers.push(
            `个股加仓后权重将超过 ${maxStockWeight}% 上限（当前 ${weightOf(stockValue, baseAssets)}%）`,
          );
        } else {
          blockers.push(
            `行业「${input.sector}」加仓后权重将超过 ${maxSectorWeight}% 上限（当前 ${weightOf(sectorValue, baseAssets)}%）`,
          );
        }
      }
    }

    remaining = roundTo(remaining - allocatedAmount);
    cumulativeAmount = roundTo(cumulativeAmount + allocatedAmount);
    totalFees = roundTo(totalFees + allocatedFee);
    totalShares += allocatedShares;
    stockValue = roundTo(stockValue + allocatedShares * price);
    sectorValue = roundTo(sectorValue + allocatedShares * price);

    const baseAssets = Math.max(0, totalAssets - totalFees);
    return {
      level: tier.level,
      name: tier.name,
      targetPrice: price,
      referenceShares,
      allocatedShares,
      allocatedAmount,
      cumulativeAmount,
      remainingBudget: remaining,
      stockWeight: weightOf(stockValue, baseAssets),
      sectorWeight: weightOf(sectorValue, baseAssets),
      blockers,
    };
  });

  const baseAssets = Math.max(0, totalAssets - totalFees);
  return {
    requestedBudget,
    approvedBudget,
    investableCash,
    minCashReserve,
    totalAllocated: cumulativeAmount,
    totalFees,
    totalShares,
    unallocated: remaining,
    stockWeightAfter: weightOf(stockValue, baseAssets),
    sectorWeightAfter: weightOf(sectorValue, baseAssets),
    limits: { maxStockWeight, maxSectorWeight },
    tiers,
    notes,
  };
}
