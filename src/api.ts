import type {
  AssumptionInput,
  AssumptionPreviewResponse,
  CatalogItem,
  DashboardResponse,
  Portfolio,
  RiskEventInput,
  RiskMutationResponse,
  RiskSourcePatch,
  RiskVerificationInput,
  SettingsPatch,
  Stock,
  StockDetailResponse,
  TradeRequest,
  TradeReviewResponse,
} from '../shared/types.ts';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  dashboard: () => request<DashboardResponse>('/api/dashboard'),
  catalog: () => request<CatalogItem[]>('/api/catalog'),
  stock: (symbol: string) => request<StockDetailResponse>(`/api/stocks/${symbol}`),
  /** 拉取指定预算下的加仓分配；budget 省略时用组合可投入现金。 */
  stockWithBudget: (symbol: string, budget?: number) =>
    request<StockDetailResponse>(
      `/api/stocks/${symbol}${typeof budget === 'number' && budget >= 0 ? `?budget=${budget}` : ''}`,
    ),
  saveAssumption: (symbol: string, input: AssumptionInput) =>
    request<StockDetailResponse>(`/api/stocks/${symbol}/assumption`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  previewAssumption: (symbol: string, input: AssumptionInput) =>
    request<AssumptionPreviewResponse>(`/api/stocks/${symbol}/assumption/preview`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateSettings: (symbol: string, patch: SettingsPatch) =>
    request<Stock>(`/api/stocks/${symbol}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  addWatchlist: (symbol: string) =>
    request<CatalogItem[]>('/api/watchlist', {
      method: 'POST',
      body: JSON.stringify({ symbol }),
    }),
  removeWatchlist: (symbol: string) =>
    request<CatalogItem[]>(`/api/watchlist/${symbol}`, { method: 'DELETE' }),
  verifyRisk: (id: string, input: RiskVerificationInput) =>
    request<RiskMutationResponse>(`/api/risk/${id}/verify`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  addRisk: (input: RiskEventInput) =>
    request<RiskMutationResponse>('/api/risk', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateRiskSource: (id: string, patch: RiskSourcePatch) =>
    request<RiskMutationResponse>(`/api/risk/${id}/source`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  trade: (trade: TradeRequest) =>
    request<Portfolio>('/api/portfolio/trade', {
      method: 'POST',
      body: JSON.stringify(trade),
    }),
  review: () => request<TradeReviewResponse>('/api/portfolio/review'),
};
