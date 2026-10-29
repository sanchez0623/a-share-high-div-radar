import type {
  DividendQuality,
  DividendQualityBasis,
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
  /** 财务口径对应的报告年度；缺省表示未标注年度，无法与预测年度对齐。 */
  dataYear?: number;
}

/** 金融行业杠杆天然偏高，按行业口径放宽负债率阈值。 */
const FINANCIAL_SECTORS = new Set(['银行', '保险']);

/** 纯函数：派息率、现金流覆盖、利润波动与杠杆质量共同决定分红是否可持续。
 *  forecastYear 指明质量结论服务的预测年度：仅当与质量数据年度一致时，
 *  结论才可视为该年度的质量结论，否则降级为“基期质量参考”并显式标注。 */
export function buildDividendQuality(
  input: DividendQualityInput,
  dividendPerShare: number,
  forecastYear?: number,
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
  const dataYear = typeof input.dataYear === 'number' ? input.dataYear : null;
  /** 对应年度 EPS、现金流与一次性分红组成齐备才算口径一致；否则只能作为基期参考。 */
  const basis: DividendQualityBasis =
    dataYear !== null && forecastYear !== undefined && dataYear === forecastYear
      ? 'matching'
      : 'base';

  const checks: DividendQualityCheck[] = [
    {
      key: 'payout',
      label: '派息率',
      status: payoutRatio <= 70 ? 'pass' : payoutRatio <= 90 ? 'watch' : 'block',
      value: `${payoutRatio.toFixed(0)}%（${dataYear ?? ''}年报）`,
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
  if (basis === 'base') {
    const sourceYear = dataYear !== null ? `${dataYear}年` : '基期';
    const targetYear = forecastYear !== undefined ? `${forecastYear}年` : '预测';
    notes.push(
      `基期质量参考：派息率、现金流与一次性分红标记均取自${sourceYear}基期数据，仅现金流覆盖按新预测重算；${targetYear}尚缺对应 EPS、现金流与一次性分红组成，本结论不能直接视为${targetYear}度质量结论`,
    );
  }
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
    basis,
    dataYear,
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
