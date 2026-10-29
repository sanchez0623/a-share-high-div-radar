export type DataMode = 'demo' | 'live';
export type ResearchLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type SignalStatus = 'pass' | 'watch' | 'block' | 'neutral';
export type SignalKey = 'valuation' | 'dividend' | 'technical' | 'trend' | 'risk' | 'budget';
export type DividendScenario = 'conservative' | 'base' | 'optimistic';
/** 分红预测的来源类型：已宣告 / 公司指引 / 历史外推 / 用户假设。 */
export type ForecastSource = 'announced' | 'guidance' | 'extrapolation' | 'assumption';
/** 财务指标口径：年报 / 单季 / TTM。 */
export type StatBasis = 'annual' | 'quarter' | 'ttm';
export type DividendQualityStatus = 'sustainable' | 'watch' | 'fragile';
/** 质量结论口径：matching = 预测年度与质量数据年度一致；base = 仅基期数据参考。 */
export type DividendQualityBasis = 'matching' | 'base';
/** 现金分红所处阶段：已到账 / 已宣告待收 / 预计未宣告。 */
export type DividendStage = 'received' | 'declared' | 'projected';
/** 记账口径：税前 / 税后。 */
export type TaxBasis = 'pre_tax' | 'after_tax';

/** 一笔具体分红事件的除息日、派息日与每股金额。 */
export interface DividendPayment {
  exDate: string;
  payDate: string;
  dividendPerShare: number;
}

/** 一份可追溯的分红预测：数值、来源、公告日期、报告期与假设说明。 */
export interface DividendForecast {
  year: number;
  scenario: DividendScenario;
  dividendPerShare: number;
  source: ForecastSource;
  /** 来源说明，例如“2025年报已宣告每股派息0.32元”。 */
  sourceDetail: string;
  /** 公告日期，历史外推或用户假设时为空。 */
  announcementDate: string | null;
  /** 报告期，例如“2025年报”“2026年中期”。 */
  reportPeriod: string;
  /** 从基准分红推导到预测年度的假设说明。 */
  hypothesis: string;
}

export interface DividendQualityCheck {
  key: 'payout' | 'cashflow' | 'volatility' | 'leverage';
  label: string;
  status: SignalStatus;
  value: string;
  detail: string;
}

/** 可持续分红质量检查：派息率、现金流覆盖、利润波动与杠杆质量。 */
export interface DividendQuality {
  status: DividendQualityStatus;
  /** 质量结论口径：口径与预测年度不一致时仅为基期质量参考，不能视为预测年度质量结论。 */
  basis: DividendQualityBasis;
  /** 质量数据对应的报告年度；null 表示未标注年度归属。 */
  dataYear: number | null;
  payoutRatio: number;
  /** 经营现金流对年度分红的覆盖倍数。 */
  operatingCashFlowCoverage: number;
  /** 自由现金流对年度分红的覆盖倍数。 */
  freeCashFlowCoverage: number;
  /** 近五年净利润同比波动幅度（%）。 */
  profitVolatility: number;
  /** 资产负债率（%）。 */
  leverage: number;
  /** 预测分红是否包含一次性特别分红。 */
  oneOff: boolean;
  checks: DividendQualityCheck[];
  notes: string[];
}

/** 行情时间与技术指标复权口径，真实数据模式下必须显式标注。 */
export interface MarketDataMeta {
  /** 行情时间，例如“2026-10-23 15:00”。 */
  quoteTime: string;
  priceAdjustment: 'forward' | 'none';
  indicatorAdjustment: 'forward' | 'none';
  /** 区间内最近除息日，null 表示未发生除息。 */
  lastExDate: string | null;
}

export interface DataMeta {
  dataMode: DataMode;
  /** 行情时间，例如“2026-10-23 15:00”。 */
  quoteTime: string;
  priceAdjustment: 'forward' | 'none';
  indicatorAdjustment: 'forward' | 'none';
  peBasis: StatBasis;
  roeBasis: StatBasis;
  note: string;
}

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
  source: ForecastSource;
  sourceDetail: string;
  announcementDate: string | null;
  reportPeriod: string;
  hypothesis: string;
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
  /** 由全部风险事件派生的股票级风险闸门，不可直接写入。 */
  riskGate: RiskGate;
  /** 当前生效的分红预测：含来源、公告日期、报告期与假设说明。 */
  dividendForecast: DividendForecast;
  /** 原始预测来源，不随用户假设变化，用于追溯用户假设的基准。 */
  baseForecast: Pick<
    DividendForecast,
    'source' | 'sourceDetail' | 'announcementDate' | 'reportPeriod'
  >;
  /** 可持续分红质量检查结果。 */
  dividendQuality: DividendQuality;
  /** PE 与 ROE 的计算口径。 */
  valuationBasis: { pe: StatBasis; roe: StatBasis };
  /** 行情时间与技术指标复权口径。 */
  marketData: MarketDataMeta;
  /** 最近一笔已到账的现金分红，null 表示区间内未派息。 */
  receivedDividend: DividendPayment | null;
  /** 已宣告但尚未到账的分红，不计入可用现金。 */
  pendingDividend: DividendPayment | null;
  /** 分红历史口径来源：'tencent-fqkline' 表示真实除权数据，null 表示演示种子口径。 */
  dividendHistorySource: 'tencent-fqkline' | null;
  /** 真实分红历史的同步时间（ISO 字符串），仅 source 非空时有意义。 */
  dividendHistorySyncedAt: string | null;
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
  /** 派息率（%）：真实除权数据不携带，无法从免费源可靠推算，未知时为 null。 */
  payoutRatio: number | null;
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
  sector: string;
  shares: number;
  cost: number;
  price: number;
  marketValue: number;
  weight: number;
  yieldOnCost: number;
  annualDividend: number;
  /** 建仓时记录的分红假设版本，null 表示按默认假设建仓。 */
  assumptionVersion: number | null;
  /** 该持仓当前使用的预测年度与每股分红，用于追溯组合现金流的假设。 */
  forecastYear: number;
  forecastDividend: number;
  forecastSource: ForecastSource;
}

/** 一条可追溯的现金分红记录，区分已到账、已宣告待收与预计未宣告。 */
export interface DividendFlow {
  symbol: string;
  name: string;
  sector: string;
  stage: DividendStage;
  /** 年度归属：历史分红按除息日所在年度，预计未宣告按预测年度。 */
  year: number;
  /** 生成该笔流水使用的股数：历史分红为除息日登记在册的权益股数，预计为当前持仓。 */
  shares: number;
  dividendPerShare: number;
  /** 税前金额。 */
  grossAmount: number;
  /** 预估红利税；演示按持股1个月至1年档 10% 估算。 */
  tax: number;
  /** 税后金额。 */
  netAmount: number;
  exDate: string | null;
  payDate: string | null;
  note: string;
}

/** 现金分档：只有已到账现金可用于加仓，预计分红不得重复计入。 */
export interface CashLedger {
  /** 已到账现金余额，可直接用于加仓。 */
  settled: number;
  /** 已宣告待收，尚未到账，不计入可用现金。 */
  declaredReceivable: number;
  /** 预计未宣告分红，仅作现金流参考，不计入可用现金。 */
  projectedDividend: number;
  /** 已到账的分红总额，已包含在 settled 中，不再重复计入。 */
  receivedDividend: number;
  /** 最低现金储备。 */
  minCashReserve: number;
  /** settled − 最低储备，可投入加仓的上限。 */
  investable: number;
}

/** 成交时的风险证据快照：逐条风险的状态与核验证据冻结在交易时刻。 */
export interface TradeRiskSnapshot {
  id: string;
  title: string;
  severity: RiskSeverity;
  status: RiskVerificationStatus;
  statusReason: string;
  /** 核验时留下的证据链接或内部记录编号。 */
  evidenceUrl: string | null;
  verifiedBy: string | null;
}

/** 成交时的研究快照：分红假设、风险证据与决策清单的完整冻结，重启后仍可追溯。 */
export interface TradeResearchSnapshot {
  /** 成交时生效的分红假设。 */
  assumption: DividendAssumption;
  /** 成交时的研究等级。 */
  level: ResearchLevel;
  /** 成交时的预测股息率。 */
  dividendYield: number;
  /** 成交时的布林超跌 %B。 */
  percentB: number;
  /** 成交时的风险闸门摘要。 */
  riskGate: Pick<
    RiskGate,
    | 'status'
    | 'verified'
    | 'totalCount'
    | 'openCount'
    | 'highestOpenSeverity'
    | 'allowedLevels'
    | 'summary'
  >;
  /** 成交时该股票的全部风险事件（含核验状态与证据）。 */
  risks: TradeRiskSnapshot[];
  /** 成交时的研究计划档位。 */
  plan: PlanTier[];
}

/** 一笔模拟成交的完整账本记录，可追溯到当时的研究假设与计划档位。 */
export interface TradeRecord {
  id: string;
  symbol: string;
  name: string;
  side: 'buy' | 'sell';
  shares: number;
  price: number;
  /** 成交金额，不含费用。 */
  grossAmount: number;
  /** 佣金与过户费合计。 */
  fee: number;
  /** 卖出印花税；买入为 0。 */
  tax: number;
  /** 记账现金影响：买入为支出，卖出为收回；税前口径为成交金额毛额，税后口径含费用与印花税。 */
  netAmount: number;
  executedAt: string;
  /** 记账口径：税前=按成交金额毛额记账（费用税费仅展示）；税后=按扣除费用与印花税后的净额记账，缺省为税后。 */
  taxBasis: TaxBasis;
  /** 成交时生效的已保存假设版本，null 表示按默认假设。 */
  assumptionVersion: number | null;
  /** 对应的计划档位，null 表示无计划的人工记录。 */
  planLevel: Exclude<ResearchLevel, 'L0'> | null;
  /** 该档位当时的研究价格，用于追溯计划与成交的偏差。 */
  planTargetPrice: number | null;
  /** 成交时的完整研究快照；旧记录或手动导入可能为 null。 */
  researchContext: TradeResearchSnapshot | null;
}

/** 组合加仓分配的单档结果：预算、股数与超限原因。 */
export interface PlanAllocationTier {
  level: ResearchLevel;
  name: string;
  targetPrice: number;
  /** 计划参考股数（100/200/300），仅作研究口径。 */
  referenceShares: number;
  /** 在预算、储备与集中度约束下可分配的股数。 */
  allocatedShares: number;
  /** 本档金额（含买入费用）。 */
  allocatedAmount: number;
  /** 含本档在内的累计占用预算。 */
  cumulativeAmount: number;
  /** 本档分配后剩余预算。 */
  remainingBudget: number;
  /** 本档分配后的个股与行业权重预览（%）。 */
  stockWeight: number;
  sectorWeight: number;
  /** 本档受限的明确原因；空数组表示可按参考股数完整执行。 */
  blockers: string[];
}

/** 一次加仓计划的可执行分配结果。 */
export interface PlanAllocation {
  requestedBudget: number;
  approvedBudget: number;
  investableCash: number;
  minCashReserve: number;
  totalAllocated: number;
  totalFees: number;
  totalShares: number;
  unallocated: number;
  stockWeightAfter: number;
  sectorWeightAfter: number;
  limits: { maxStockWeight: number; maxSectorWeight: number };
  tiers: PlanAllocationTier[];
  notes: string[];
}

export interface Portfolio {
  cash: number;
  marketValue: number;
  totalAssets: number;
  /** 预测年度分红：各持仓按其预测年度假设折算，不等于未来 12 个月到账口径。 */
  annualDividend: number;
  /** 税后口径的预测年度分红（演示按 10% 红利税估算）。 */
  annualDividendAfterTax: number;
  /** 未来 12 个月预计到账分红（税后）：已宣告待收 + 归属当前年度的预计未宣告，不含已到账。 */
  nextTwelveMonthDividendAfterTax: number;
  portfolioYield: number;
  positions: PortfolioPosition[];
  /** 分档现金流：已到账 / 已宣告待收 / 预计未宣告。 */
  cashLedger: CashLedger;
  dividendFlows: DividendFlow[];
  /** 模拟交易账本，按时间倒序。 */
  trades: TradeRecord[];
}

/** 交易写操作的统一返回：最新组合账本 + 按新现金与持仓重算的派生快照。 */
export interface TradeResponse extends Portfolio {
  /** 现金或持仓变化后重新派生的股票快照（观察仓 + 全部现有持仓）。 */
  stocks: Stock[];
}

export type RiskType = '公告' | '财务' | '行业' | '数据';
export type RiskSeverity = 'high' | 'medium' | 'low';
/** 核验状态一律派生，不在存储中写入。 */
export type RiskVerificationStatus = 'pending' | 'verified' | 'expired' | 'invalidated';

/** 风险原文与来源：每一次核验都必须能指回具体材料。 */
export interface RiskSource {
  /** 发布方，例如“上交所公告”或“演示数据”。 */
  publisher: string;
  /** 原文链接；演示环境未接入原文时为 null，以摘录为准。 */
  url: string | null;
  /** 原文摘录，供无法跳转时核对。 */
  excerpt: string;
  /** 原文发布日期。 */
  publishedAt: string;
  /** 原文版本，原文更新即递增；旧核验随之失效。 */
  revision: number;
}

/** 一次人工核验记录：谁、何时、依据什么、有效期到何时。 */
export interface RiskVerification {
  verifiedAt: string;
  verifiedBy: string;
  note: string;
  /** 证据链接或内部记录编号；每次核验必填，L3 放行据此追溯。 */
  evidenceUrl: string | null;
  /** 该核验针对的原文版本。 */
  revision: number;
  /** 核验时生效的严重度快照。 */
  severity: RiskSeverity;
  /** 有效期截止时间（含当日）。 */
  expiresAt: string;
}

/** 落盘态：核验状态由核验记录与当前时间派生，不写盘。 */
export interface RiskEventRecord {
  id: string;
  symbol: string;
  title: string;
  type: RiskType;
  severity: RiskSeverity;
  date: string;
  summary: string;
  source: RiskSource;
  /** 最近一次核验记录；失效后仍保留，用于审计追溯。 */
  verification: RiskVerification | null;
  /** 最近一次作废时间，null 表示从未作废。 */
  invalidatedAt: string | null;
  /** 作废原因，例如“新增高风险事项”或“原文更新”。 */
  invalidatedReason: string | null;
}

export interface RiskEvent extends RiskEventRecord {
  status: RiskVerificationStatus;
  /** 状态说明，解释为什么是待核验 / 已过期 / 已作废。 */
  statusReason: string;
  /** 有效核验的剩余天数；无有效核验为 null。 */
  daysRemaining: number | null;
}

/** 严重度 × L1–L3 的公开阻断规则。 */
export interface RiskGateRule {
  /** 触发条件说明。 */
  condition: string;
  /** 该条件下仍放行的研究等级；空数组表示全部阻断。 */
  allowedLevels: ResearchLevel[];
}

/** 风险政策：有效期与阻断矩阵的唯一公开口径。 */
export interface RiskPolicy {
  /** 各严重度的核验有效期（天）。 */
  validityDays: Record<RiskSeverity, number>;
  rules: RiskGateRule[];
  note: string;
}

/** 股票级风险状态：由风险事件唯一派生，展示层不得依据单个布尔字段重新推断。 */
export type RiskGateStatus = 'clear' | 'verified' | 'review' | 'blocked';

/** 股票级风险闸门：由该股票全部风险事件派生，不可直接写入。 */
export interface RiskGate {
  /** 唯一的股票级状态：未登记 / 全部有效 / 部分未关闭 / 高风险阻断。 */
  status: RiskGateStatus;
  /** 全部风险事件都有有效核验；未登记风险时为 false，此时放行口径见 status。 */
  verified: boolean;
  totalCount: number;
  openCount: number;
  pendingCount: number;
  expiredCount: number;
  invalidatedCount: number;
  /** 未关闭风险中的最高严重度。 */
  highestOpenSeverity: RiskSeverity | null;
  /** 当前允许进入的最高等级集合。 */
  allowedLevels: ResearchLevel[];
  /** 被阻断的等级。 */
  blockedLevels: ResearchLevel[];
  /** 全部风险状态的稳定签名，用于提醒重评估。 */
  signature: string;
  summary: string;
}

export interface RiskVerificationInput {
  note: string;
  evidenceUrl?: string;
  verifiedBy?: string;
}

export interface RiskEventInput {
  symbol: string;
  title: string;
  type: RiskType;
  severity: RiskSeverity;
  summary: string;
  source: {
    publisher: string;
    url?: string;
    excerpt: string;
    publishedAt: string;
  };
}

export interface RiskSourcePatch {
  publisher?: string;
  url?: string | null;
  excerpt?: string;
  publishedAt?: string;
}

/** 风险写操作的统一返回：更新后的风险事件与重算后的股票闸门。 */
export interface RiskMutationResponse {
  risk: RiskEvent;
  stock: Stock;
}

export interface DashboardResponse {
  asOf: string;
  dataMode: DataMode;
  stocks: Stock[];
  /** 交易候选：观察仓 + 全部现有持仓，含已移出观察仓但仍持有的股票。 */
  tradeStocks: Stock[];
  portfolio: Portfolio;
  risks: RiskEvent[];
  /** 风险有效期与严重度阻断矩阵。 */
  riskPolicy: RiskPolicy;
  dataNotice: string;
  /** 行情时间、复权方式与 PE/ROE 口径。 */
  dataMeta: DataMeta;
}

export interface StockDetailResponse {
  stock: Stock;
  history: PriceBar[];
  dividends: DividendRecord[];
  plan: PlanTier[];
  /** 当前生效的分红假设（已保存则为其副本，否则为默认假设）。 */
  assumption: DividendAssumption;
  assumptionSaved: boolean;
  /** 以组合已到账现金、最低储备与集中度约束计算的默认分配。 */
  allocation: PlanAllocation;
}

/** 临时预览快照：假设、重算后的股票结论、价格阶梯与资金分配必须整份使用。 */
export interface AssumptionPreviewResponse {
  assumption: DividendAssumption;
  /** 按预览假设重算的股票快照（等级、股息率、质量检查均来自预览口径）。 */
  stock: Stock;
  plan: PlanTier[];
  /** 按预览价格阶梯计算的资金分配，避免新计划搭配旧股数与旧费用。 */
  allocation: PlanAllocation;
}

export interface CatalogItem {
  symbol: string;
  name: string;
  sector: string;
  inWatchlist: boolean;
  /** 停用的股票不出现在雷达与观察仓，仅在管理弹窗（includeDisabled）中可见。 */
  enabled: boolean;
}

/** 动态添加股票的请求体；名称、行业与日线由服务端从免费行情源拉取。 */
export interface StockRegistrationInput {
  /** 6 位代码或带 .SH/.SZ 后缀；服务端归一化为 601318.SH 格式。 */
  symbol: string;
  /** 行业覆盖；缺省时从东财 f100 自动获取。 */
  sector?: string;
  /** 用户录入的预测每股分红；免费源无可靠预测，缺省为 0（来源标注为用户假设）。 */
  forecastDividend?: number;
  /** 买入门槛（要求股息率%），缺省为 5。 */
  buyThreshold?: number;
  /** 日线长期未更新（疑似停牌）时，二次确认后仍允许加入。 */
  confirmSuspended?: boolean;
}

/** 设置项契约：服务端只接受这里声明的字段，其余字段一律拒绝。 */
export interface SettingsPatch {
  buyThreshold?: number;
}

export interface TradeRequest {
  symbol: string;
  side: 'buy' | 'sell';
  shares: number;
  price: number;
  /** 成交日期（YYYY-MM-DD），缺省使用演示行情日。 */
  executedAt?: string;
  /** 对应计划档位，缺省或 null 表示无计划的人工记录。 */
  planLevel?: Exclude<ResearchLevel, 'L0'> | null;
  /** 记账口径：税前 / 税后，缺省为税后。 */
  taxBasis?: TaxBasis;
}

// ─── 复盘 ───────────────────────────────────────────────────────────

/** 单条规则合规检查结果。 */
export interface ComplianceCheck {
  rule: string;
  passed: boolean;
  detail: string;
}

/** 复盘分类：区分"按规则执行但亏损"与"未按规则执行"。 */
export type TradeClassification =
  | 'rule_compliant_profit'
  | 'rule_compliant_loss'
  | 'rule_violation'
  | 'open_position'
  | 'no_plan'
  | 'no_snapshot';

/** FIFO 配对的卖出汇总。 */
export interface TradePairedSell {
  /** 配对卖出的交易 ID 列表（可能多笔部分成交）。 */
  sellTradeIds: string[];
  /** 已卖出股数。 */
  soldShares: number;
  /** 加权平均卖出价。 */
  avgSellPrice: number;
  /** 买入价。 */
  buyPrice: number;
  /** 盈亏金额（不含费用）。 */
  pnl: number;
  /** 盈亏百分比。 */
  pnlPct: number;
  /** 是否全部卖出。 */
  fullyClosed: boolean;
}

/** 单笔买入的复盘条目。 */
export interface TradeReviewItem {
  tradeId: string;
  symbol: string;
  name: string;
  executedAt: string;
  shares: number;
  buyPrice: number;
  planLevel: Exclude<ResearchLevel, 'L0'> | null;
  /** 规则合规检查明细。 */
  complianceChecks: ComplianceCheck[];
  /** 是否按规则执行。 */
  ruleCompliant: boolean;
  /** FIFO 配对的卖出汇总；null 表示尚未卖出。 */
  pairedSell: TradePairedSell | null;
  classification: TradeClassification;
}

/** 复盘汇总。 */
export interface TradeReviewSummary {
  totalBuys: number;
  ruleCompliantProfit: number;
  ruleCompliantLoss: number;
  ruleViolation: number;
  openPosition: number;
  noPlan: number;
  noSnapshot: number;
  /** 已平仓总盈亏（不含费用）。 */
  totalPnl: number;
}

export interface TradeReviewResponse {
  items: TradeReviewItem[];
  summary: TradeReviewSummary;
}

// ─── 持久化 ─────────────────────────────────────────────────────────

/** 落盘的持仓记录。 */
export interface PersistedHolding {
  symbol: string;
  shares: number;
  cost: number;
  assumptionVersion: number | null;
}

/** 组合状态落盘格式：观察仓、现金、持仓与交易账本。 */
export interface PersistedPortfolio {
  watchlist: string[];
  cash: number;
  holdings: PersistedHolding[];
  trades: TradeRecord[];
}
