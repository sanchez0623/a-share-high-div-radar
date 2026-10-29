import type {
  AssumptionInput,
  AssumptionPreviewResponse,
  CatalogItem,
  DashboardResponse,
  RiskEventInput,
  RiskMutationResponse,
  RiskSourcePatch,
  RiskVerificationInput,
  SettingsPatch,
  Stock,
  StockDetailResponse,
  StockRegistrationInput,
  TradeRequest,
  TradeResponse,
  TradeReviewResponse,
} from '../shared/types.ts';
import type { QuoteSnapshotResponse } from '../shared/quote-types.ts';

/** 跨设备部署时后端会要求访问令牌；回环部署无需设置，取不到就按同源匿名请求。 */
const ACCESS_TOKEN_KEY = 'dividend-atlas.access-token';

function tokenHeaders(): Record<string, string> {
  const token = typeof localStorage === 'undefined' ? null : localStorage.getItem(ACCESS_TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...tokenHeaders(),
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
  catalog: (includeDisabled = false) =>
    request<CatalogItem[]>(includeDisabled ? '/api/catalog?includeDisabled=1' : '/api/catalog'),
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
  previewAssumption: (symbol: string, input: AssumptionInput, budget?: number) =>
    request<AssumptionPreviewResponse>(
      `/api/stocks/${symbol}/assumption/preview${typeof budget === 'number' && budget >= 0 ? `?budget=${budget}` : ''}`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
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
  /**
   * 动态添加股票：需要透出 confirmRequired 标记（疑似停牌的二次确认），
   * 因此不走通用 request，直接解析响应体的附加字段。
   */
  addStock: async (input: StockRegistrationInput): Promise<Stock> => {
    const response = await fetch('/api/stocks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...tokenHeaders() },
      body: JSON.stringify(input),
    });
    const body = (await response.json().catch(() => null)) as
      | (Partial<Stock> & { error?: string; confirmRequired?: boolean })
      | { error?: string; confirmRequired?: boolean }
      | null;
    if (!response.ok) {
      const error = new Error(
        body?.error ?? `请求失败（${response.status}）`,
      ) as Error & { confirmRequired?: boolean };
      if (body?.confirmRequired) error.confirmRequired = true;
      throw error;
    }
    return body as Stock;
  },
  setStockStatus: (symbol: string, enabled: boolean) =>
    request<CatalogItem[]>(`/api/stocks/${symbol}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
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
    request<TradeResponse>('/api/portfolio/trade', {
      method: 'POST',
      body: JSON.stringify(trade),
    }),
  review: () => request<TradeReviewResponse>('/api/portfolio/review'),
  /** 实时行情快照：仅接受观察仓内的标的，服务端会做白名单过滤。 */
  quotes: (symbols: string[]) =>
    request<QuoteSnapshotResponse>(`/api/quotes?symbols=${encodeURIComponent(symbols.join(','))}`),
  /** CSV 导出同样需要令牌头，所以走 fetch 而不是 <a href> 直连。 */
  async exportWatchlist(): Promise<void> {
    const response = await fetch('/api/export/watchlist', { headers: tokenHeaders() });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `导出失败（${response.status}）`);
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'watchlist.csv';
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  },
};
