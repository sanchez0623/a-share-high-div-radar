import type { SettingsPatch } from '../shared/types.ts';
import { REQUIRE_YIELD_MAX, REQUIRE_YIELD_MIN } from '../shared/assumptions.ts';
import { saveAssumption } from './assumptions.ts';
import { SettingsError } from './errors.ts';
import type { PersistedSettings } from './settings-store.ts';
import type { DemoState } from './state.ts';

/** 设置项白名单：请求体里只允许出现这些字段，其余键一律拒绝而不是静默忽略。 */
const SETTINGS_KEYS = ['buyThreshold'] as const;

/**
 * 校验并白名单化客户端提交的设置项。
 * 这是批量赋值的防线：请求体永远不会被整体展开进 Stock，
 * 代码、预测分红、持仓股数等字段既不在白名单内，也无法通过多余键写入。
 */
function parseSettingsPatch(body: unknown): Required<SettingsPatch> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SettingsError('请求体必须为JSON对象');
  }
  const payload = body as Record<string, unknown>;
  if (Object.hasOwn(payload, 'riskVerified')) {
    throw new SettingsError('风险状态由风险事件核验派生，请在风险哨兵中逐条核验');
  }

  const keys = Object.keys(payload);
  const unknownKeys = keys.filter((key) => !(SETTINGS_KEYS as readonly string[]).includes(key));
  if (unknownKeys.length > 0) {
    throw new SettingsError(`不支持修改的字段：${unknownKeys.join('、')}`);
  }
  if (keys.length === 0) {
    throw new SettingsError(`没有可写入的设置项，允许修改：${SETTINGS_KEYS.join('、')}`);
  }

  const buyThreshold = payload.buyThreshold;
  if (
    typeof buyThreshold !== 'number' ||
    !Number.isFinite(buyThreshold) ||
    buyThreshold < REQUIRE_YIELD_MIN ||
    buyThreshold > REQUIRE_YIELD_MAX
  ) {
    throw new SettingsError(`buyThreshold必须在${REQUIRE_YIELD_MIN}到${REQUIRE_YIELD_MAX}之间`);
  }
  return { buyThreshold };
}

export interface SettingsMutationResult {
  /** 已保存假设随研究门槛同步升版，调用方需要落盘。 */
  assumptionUpdated: boolean;
}

/**
 * 服务启动时套用已落盘的买入门槛。
 * 必须在假设恢复之前调用：已保存假设的 requiredYield 才是最终口径，
 * 假设恢复会覆盖同一标的的门槛，因此这里只负责“没有正式假设”的那部分。
 */
export function hydrateSettings(state: DemoState, settings: PersistedSettings | null): void {
  if (!settings) return;
  for (const [symbol, threshold] of Object.entries(settings.buyThresholds)) {
    const stock = state.stocks.get(symbol);
    if (!stock) continue;
    if (
      typeof threshold !== 'number' ||
      !Number.isFinite(threshold) ||
      threshold < REQUIRE_YIELD_MIN ||
      threshold > REQUIRE_YIELD_MAX
    ) {
      continue;
    }
    state.stocks.set(symbol, { ...stock, buyThreshold: threshold });
  }
}

/**
 * 需要落盘的门槛快照：只收集没有正式假设的标的。
 * 有正式假设时门槛已随假设版本落盘，再写一份会造成两处真相。
 */
export function collectSettings(state: DemoState): PersistedSettings {
  const buyThresholds: Record<string, number> = {};
  for (const [symbol, stock] of state.stocks) {
    if (state.assumptions.has(symbol)) continue;
    buyThresholds[symbol] = stock.buyThreshold;
  }
  return { buyThresholds };
}

/**
 * 设置写操作的唯一入口：DTO 校验 → 白名单更新 → 假设同步。
 * 结论重算与提醒由 state-change.ts 统一处理，这里不返回派生快照。
 */
export function updateStockSettings(
  state: DemoState,
  symbol: string,
  body: unknown,
  now = Date.now(),
): SettingsMutationResult {
  const { buyThreshold } = parseSettingsPatch(body);
  const current = state.stocks.get(symbol);
  if (!current) throw new SettingsError('未知股票代码');

  /** 只写入白名单字段，价格、预测分红、持仓股数等派生或风控字段保持服务端口径。 */
  state.stocks.set(symbol, { ...current, buyThreshold });

  const saved = state.assumptions.get(symbol);
  if (!saved) return { assumptionUpdated: false };

  saveAssumption(
    state,
    symbol,
    { forecastYear: saved.forecastYear, scenario: saved.scenario, requiredYield: buyThreshold },
    now,
  );
  return { assumptionUpdated: true };
}
