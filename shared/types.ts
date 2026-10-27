export type DataMode = 'demo' | 'live';
export type ResearchLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type SignalStatus = 'pass' | 'watch' | 'block' | 'neutral';
export type SignalKey = 'valuation' | 'technical' | 'trend' | 'risk' | 'budget';

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
  forecastDividend: number;
  dividendYield: number;
  buyThreshold: number;
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
