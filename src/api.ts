import type {
  AssumptionInput,
  AssumptionPreviewResponse,
  CatalogItem,
  DashboardResponse,
  Portfolio,
  RiskEvent,
  SettingsPatch,
  Stock,
  StockDetailResponse,
  TradeRequest,
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
  acknowledgeRisk: (id: string) =>
    request<RiskEvent>(`/api/risk/${id}/acknowledge`, { method: 'POST' }),
  trade: (trade: TradeRequest) =>
    request<Portfolio>('/api/portfolio/trade', {
      method: 'POST',
      body: JSON.stringify(trade),
    }),
};
