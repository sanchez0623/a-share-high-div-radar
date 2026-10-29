/** 统一的四舍五入口径：只在展示层调用，决策链一律保留未舍入值。 */
export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * 决策比较容差：仅吸收 IEEE754 浮点表示误差，不代表放宽研究门槛。
 * 所有阈值判断都应使用未舍入值 + 该容差，避免“展示值四舍五入后达标、内部值未达标”。
 */
export const DECISION_EPSILON = 1e-9;

/** 未舍入值的门槛比较：value 达到或超过 threshold。 */
export function reaches(value: number, threshold: number): boolean {
  return value >= threshold - DECISION_EPSILON;
}
