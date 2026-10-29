import type {
  ComplianceCheck,
  ResearchLevel,
  TradeClassification,
  TradePairedSell,
  TradeRecord,
  TradeReviewItem,
  TradeReviewResponse,
  TradeReviewSummary,
} from '../shared/types.ts';
import { round } from './numeric.ts';
import type { DemoState } from './state.ts';

/**
 * 复盘：对每笔买入做 FIFO 配对、规则合规检查与盈亏分类。
 * 纯函数，只读取账本；目标是区分"按规则执行但结果亏损"与"未按规则执行"。
 */
export function reviewTrades(state: DemoState): TradeReviewResponse {
  const levelRank: Record<ResearchLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

  // 交易账本最新在前；按时间升序处理以便 FIFO 配对（同日按插入顺序倒排）。
  const ordered = state.trades
    .map((trade, index) => ({ trade, index }))
    .sort((a, b) => {
      const byDate = a.trade.executedAt.localeCompare(b.trade.executedAt);
      return byDate !== 0 ? byDate : b.index - a.index;
    });

  interface BuyLot {
    trade: TradeRecord;
    remaining: number;
    sellTradeIds: string[];
    soldShares: number;
    sellProceeds: number;
  }

  // 按 symbol 分组，标准 FIFO：卖出从最早未平仓买入开始扣减。
  const queue = new Map<string, BuyLot[]>();
  const lots = new Map<string, BuyLot[]>();

  for (const { trade } of ordered) {
    if (trade.side === 'buy') {
      const lot: BuyLot = {
        trade,
        remaining: trade.shares,
        sellTradeIds: [],
        soldShares: 0,
        sellProceeds: 0,
      };
      if (!queue.has(trade.symbol)) queue.set(trade.symbol, []);
      queue.get(trade.symbol)!.push(lot);
      if (!lots.has(trade.symbol)) lots.set(trade.symbol, []);
      lots.get(trade.symbol)!.push(lot);
    } else {
      const buyQueue = queue.get(trade.symbol);
      if (!buyQueue || buyQueue.length === 0) continue;
      let remainingSell = trade.shares;
      while (remainingSell > 0 && buyQueue.length > 0) {
        const lot = buyQueue[0];
        const matched = Math.min(lot.remaining, remainingSell);
        lot.remaining -= matched;
        lot.soldShares += matched;
        lot.sellProceeds += matched * trade.price;
        lot.sellTradeIds.push(trade.id);
        remainingSell -= matched;
        if (lot.remaining === 0) buyQueue.shift();
      }
    }
  }

  // 逐笔买入生成复盘条目（按时间升序）。
  const items: TradeReviewItem[] = [];
  for (const { trade } of ordered) {
    if (trade.side !== 'buy') continue;
    const lot = lots.get(trade.symbol)!.find((l) => l.trade.id === trade.id)!;
    const fullyClosed = lot.soldShares >= trade.shares;

    const context = trade.researchContext;
    const planLevel = trade.planLevel;
    const complianceChecks: ComplianceCheck[] = [];
    let ruleCompliant = false;
    let classification: TradeClassification;

    if (!context) {
      classification = 'no_snapshot';
    } else if (!planLevel) {
      classification = 'no_plan';
    } else {
      const targetTier = context.plan.find((tier) => tier.level === planLevel);
      const targetPrice = targetTier?.targetPrice ?? trade.planTargetPrice;
      const levelOk = levelRank[context.level] >= levelRank[planLevel];
      complianceChecks.push({
        rule: 'research_level',
        passed: levelOk,
        detail: `成交时研究等级 ${context.level}${levelOk ? '达到' : '未达到'} ${planLevel} 档要求`,
      });
      const gateOk = context.riskGate.allowedLevels.includes(planLevel);
      complianceChecks.push({
        rule: 'risk_gate',
        passed: gateOk,
        detail: gateOk
          ? `成交时风险闸门允许 ${planLevel} 档`
          : `成交时风险闸门不允许 ${planLevel} 档（未关闭风险 ${context.riskGate.openCount} 项）`,
      });
      const priceOk =
        targetPrice === null || targetPrice === undefined || trade.price <= targetPrice;
      complianceChecks.push({
        rule: 'price_discipline',
        passed: priceOk,
        detail: priceOk
          ? `成交价 ${trade.price} 不高于 ${planLevel} 目标价 ${targetPrice ?? '—'}`
          : `成交价 ${trade.price} 高于 ${planLevel} 目标价 ${targetPrice}`,
      });
      ruleCompliant = complianceChecks.every((check) => check.passed);
      const avgSellPrice = lot.soldShares > 0 ? lot.sellProceeds / lot.soldShares : trade.price;
      classification = ruleCompliant
        ? fullyClosed
          ? avgSellPrice >= trade.price
            ? 'rule_compliant_profit'
            : 'rule_compliant_loss'
          : 'open_position'
        : 'rule_violation';
    }

    let pairedSell: TradePairedSell | null = null;
    if (lot.soldShares > 0) {
      const avgSellPrice = lot.sellProceeds / lot.soldShares;
      const buyAmount = trade.price * lot.soldShares;
      const pnl = lot.sellProceeds - buyAmount;
      pairedSell = {
        sellTradeIds: lot.sellTradeIds,
        soldShares: lot.soldShares,
        avgSellPrice: round(avgSellPrice, 4),
        buyPrice: trade.price,
        pnl: round(pnl),
        pnlPct: round(buyAmount > 0 ? (pnl / buyAmount) * 100 : 0, 2),
        fullyClosed,
      };
    }

    items.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      name: trade.name,
      executedAt: trade.executedAt,
      shares: trade.shares,
      buyPrice: trade.price,
      planLevel,
      complianceChecks,
      ruleCompliant,
      pairedSell,
      classification,
    });
  }

  const summary: TradeReviewSummary = {
    totalBuys: items.length,
    ruleCompliantProfit: 0,
    ruleCompliantLoss: 0,
    ruleViolation: 0,
    openPosition: 0,
    noPlan: 0,
    noSnapshot: 0,
    totalPnl: 0,
  };
  for (const item of items) {
    switch (item.classification) {
      case 'rule_compliant_profit':
        summary.ruleCompliantProfit += 1;
        break;
      case 'rule_compliant_loss':
        summary.ruleCompliantLoss += 1;
        break;
      case 'rule_violation':
        summary.ruleViolation += 1;
        break;
      case 'open_position':
        summary.openPosition += 1;
        break;
      case 'no_plan':
        summary.noPlan += 1;
        break;
      case 'no_snapshot':
        summary.noSnapshot += 1;
        break;
    }
    if (item.pairedSell?.fullyClosed) {
      summary.totalPnl += item.pairedSell.pnl;
    }
  }
  summary.totalPnl = round(summary.totalPnl);

  return { items, summary };
}
