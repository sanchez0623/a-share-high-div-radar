import type {
  DividendQuality,
  DividendQualityCheck,
  DividendQualityStatus,
} from '../shared/types.ts';
import { round } from './numeric.ts';

/** 质量检查所需的原始财务口径；与演示种子解耦，可由真实数据源直接填充。 */
export interface DividendQualityInput {
  sector: string;
  payoutRatio: number;
  operatingCashFlowPerShare: number;
  freeCashFlowPerShare: number;
  profitVolatility: number;
  debtRatio: number;
  oneOff: boolean;
  oneOffNote?: string;
}

/** 金融行业杠杆天然偏高，按行业口径放宽负债率阈值。 */
const FINANCIAL_SECTORS = new Set(['银行', '保险']);

/** 纯函数：派息率、现金流覆盖、利润波动与杠杆质量共同决定分红是否可持续。 */
export function buildDividendQuality(
  input: DividendQualityInput,
  dividendPerShare: number,
): DividendQuality {
  const payoutRatio = input.payoutRatio;
  const operatingCoverage =
    dividendPerShare > 0 ? input.operatingCashFlowPerShare / dividendPerShare : 0;
  const freeCoverage = dividendPerShare > 0 ? input.freeCashFlowPerShare / dividendPerShare : 0;
  const profitVolatility = input.profitVolatility;
  const leverage = input.debtRatio;
  const financial = FINANCIAL_SECTORS.has(input.sector);
  const leveragePass = financial ? 94 : 65;
  const leverageWatch = financial ? 96 : 80;

  const checks: DividendQualityCheck[] = [
    {
      key: 'payout',
      label: '派息率',
      status: payoutRatio <= 70 ? 'pass' : payoutRatio <= 90 ? 'watch' : 'block',
      value: `${payoutRatio.toFixed(0)}%（年报）`,
      detail:
        payoutRatio <= 70
          ? '派息率处于可持续区间'
          : payoutRatio <= 90
            ? '派息率偏高，需要现金流覆盖配合'
            : '派息率超过90%，分红空间有限',
    },
    {
      key: 'cashflow',
      label: '现金流覆盖',
      status: freeCoverage >= 1.2 && operatingCoverage >= 1.5 ? 'pass' : freeCoverage >= 1 && operatingCoverage >= 1.2 ? 'watch' : 'block',
      value: `经营 ${round(operatingCoverage)}× / 自由 ${round(freeCoverage)}×`,
      detail: '经营与自由现金流对年度分红总额的覆盖倍数，低于 1 倍视为不可持续',
    },
    {
      key: 'volatility',
      label: '利润波动',
      status: profitVolatility <= 20 ? 'pass' : profitVolatility <= 40 ? 'watch' : 'block',
      value: `±${profitVolatility.toFixed(0)}%`,
      detail: '近五年净利润同比波动，波动越大分红越容易被下修',
    },
    {
      key: 'leverage',
      label: '杠杆质量',
      status: leverage <= leveragePass ? 'pass' : leverage <= leverageWatch ? 'watch' : 'block',
      value: `资产负债率 ${leverage.toFixed(0)}%`,
      detail: financial
        ? '金融行业按行业口径放宽负债率阈值'
        : '非金融企业负债率越高，分红可持续性越弱',
    },
  ];

  const blocked = checks.some((check) => check.status === 'block');
  const watched = checks.some((check) => check.status === 'watch') || input.oneOff;
  const status: DividendQualityStatus = blocked ? 'fragile' : watched ? 'watch' : 'sustainable';

  const notes: string[] = [];
  if (input.oneOff) {
    notes.push(input.oneOffNote ?? '预测分红包含一次性特别分红，不可线性外推');
  }
  if (blocked) {
    notes.push('至少一项质量检查未通过，研究等级封顶为L1');
  } else if (watched) {
    notes.push('存在需人工复核的质量项，分红可持续性尚不能视为通过');
  }

  return {
    status,
    payoutRatio,
    operatingCashFlowCoverage: round(operatingCoverage),
    freeCashFlowCoverage: round(freeCoverage),
    profitVolatility,
    leverage,
    oneOff: input.oneOff,
    checks,
    notes,
  };
}
