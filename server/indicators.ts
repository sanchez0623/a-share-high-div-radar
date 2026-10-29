import type { PriceBar } from '../shared/types.ts';

/** 技术指标结果：全部为未舍入值，阈值判断与展示格式化分别在下游处理。 */
export interface IndicatorResult {
  ma20: number;
  bollUpper: number;
  bollMiddle: number;
  bollLower: number;
  percentB: number;
  atr: number;
}

/** 纯函数：只根据 K 线计算 20 日布林与 14 日 ATR，不读写任何状态，也不做舍入。 */
export function calculateIndicators(history: PriceBar[]): IndicatorResult {
  if (history.length < 20) {
    throw new Error('计算布林指标至少需要20根K线');
  }

  const recentCloses = history.slice(-20).map((bar) => bar.close);
  const middle = recentCloses.reduce((sum, close) => sum + close, 0) / 20;
  const variance =
    recentCloses.reduce((sum, close) => sum + (close - middle) ** 2, 0) / 20;
  const standardDeviation = Math.sqrt(variance);
  const upper = middle + 2 * standardDeviation;
  const lower = middle - 2 * standardDeviation;
  const latestClose = history[history.length - 1].close;
  const percentB = upper === lower ? 0.5 : (latestClose - lower) / (upper - lower);

  const trueRanges = history.slice(-14).map((bar, index) => {
    const historyIndex = history.length - 14 + index;
    if (historyIndex === 0) return bar.high - bar.low;
    const previousClose = history[historyIndex - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  });
  const atr = trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length;

  return {
    ma20: middle,
    bollUpper: upper,
    bollMiddle: middle,
    bollLower: lower,
    percentB,
    atr,
  };
}
