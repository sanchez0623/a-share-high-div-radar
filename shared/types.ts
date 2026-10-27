export type DataMode = 'demo' | 'live';
export type ResearchLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type SignalStatus = 'pass' | 'watch' | 'block' | 'neutral';
export type SignalKey = 'valuation' | 'technical' | 'trend' | 'risk' | 'budget';
export type DividendScenario = 'conservative' | 'base' | 'optimistic';

/** 一次可复现的分红研究假设，是实验室、计划与交易共用的唯一口径。 */
export interface DividendAssumption {
  symbol: string;
  forecastYear: number;
  scenario: DividendScenario;
  dividendPerShare: number;
  requiredYield: number;
  /** 已保存假设的版本号，0 表示尚未保存。 */
  version: number;
  /** 保存时间；null 表示临时预览或默认假设。 */
  savedAt: string | null;
}

export interface AssumptionInput {
  forecastYear: number;
  scenario: DividendScenario;
  requiredYield: number;
}

export interface Signal {
  key: SignalKey;
  label: string;
  status: SignalStatus;
  value: string;
  description: string;
}

export interface Stock {
  symbol: string;
  name: string;
  market: 'SH' | 'SZ';
  sector: string;
  price: number;
  changePct: number;
  /** 原始预测每股分红，不叠加情景；已保存假设会写入 forecastDividend。 */
  baseDividend: number;
  forecastDividend: number;
  dividendYield: number;
  buyThreshold: number;
  /** 当前生效的已保存假设版本，0 表示默认假设。 */
  assumptionVersion: number;
  payoutRatio: number;
  dividendStreak: number;
  pe: number;
  pb: number;
  roe: number;
  holdingShares: number;
  holdingCost: number;
  updatedAt: string;
  dataMode: DataMode;
  score: number;
  level: ResearchLevel;
  action: string;
  summary: string;
  percentB: number;
  bollUpper: number;
  bollMiddle: number;
  bollLower: number;
  atr: number;
  ma20: number;
  signals: Signal[];
  sparkline: number[];
  riskVerified: boolean;
}

export interface PriceBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DividendRecord {
  year: number;
  dividend: number;
  payoutRatio: number;
  growth: number;
}

export interface PlanTier {
  level: ResearchLevel;
  name: string;
  yieldThreshold: number;
  targetPrice: number | null;
  shares: number;
  estimatedAmount: number;
  conditions: string[];
  unlocked: boolean;
  /** 本档价格所依据的假设版本，0 表示默认假设。 */
  assumptionVersion: number;
}

export interface PortfolioPosition {
  symbol: string;
  name: string;
  shares: number;
  cost: number;
  price: number;
  marketValue: number;
  weight: number;
  yieldOnCost: number;
  annualDividend: number;
  /** 建仓时记录的分红假设版本，null 表示按默认假设建仓。 */
  assumptionVersion: number | null;
}

export interface Portfolio {
  cash: number;
  marketValue: number;
  totalAssets: number;
  annualDividend: number;
  portfolioYield: number;
  positions: PortfolioPosition[];
}

export interface RiskEvent {
  id: string;
  symbol: string;
  title: string;
  type: '公告' | '财务' | '行业' | '数据';
  severity: 'high' | 'medium' | 'low';
  date: string;
  status: 'pending' | 'acknowledged';
  summary: string;
}

export interface DashboardResponse {
  asOf: string;
  dataMode: DataMode;
  stocks: Stock[];
  portfolio: Portfolio;
  risks: RiskEvent[];
  dataNotice: string;
}

export interface StockDetailResponse {
  stock: Stock;
  history: PriceBar[];
  dividends: DividendRecord[];
  plan: PlanTier[];
  /** 当前生效的分红假设（已保存则为其副本，否则为默认假设）。 */
  assumption: DividendAssumption;
  assumptionSaved: boolean;
}

export interface AssumptionPreviewResponse {
  assumption: DividendAssumption;
  plan: PlanTier[];
}

export interface CatalogItem {
  symbol: string;
  name: string;
  sector: string;
  inWatchlist: boolean;
}

export interface SettingsPatch {
  buyThreshold?: number;
  riskVerified?: boolean;
}

export interface TradeRequest {
  symbol: string;
  side: 'buy' | 'sell';
  shares: number;
  price: number;
}
