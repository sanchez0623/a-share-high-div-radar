import type { DataMeta } from '../shared/types.ts';

export const AS_OF = '2026-10-23';
export const DATA_NOTICE =
  '演示数据，不构成实时行情或投资建议；行情为前复权收盘价，PE 为 TTM、ROE 为年报口径';
export const LIVE_DATA_NOTICE =
  '真实行情（交易所前复权日线 + 盘中快照），研究口径为用户假设，不构成投资建议；PE 为 TTM、ROE 为年报口径';

/** 行情时间、复权方式与估值口径；真实数据接入后由 activateLiveMeta 就地切换（引用不变）。 */
export const DATA_META: DataMeta = {
  dataMode: 'demo',
  quoteTime: `${AS_OF} 15:00`,
  priceAdjustment: 'forward',
  indicatorAdjustment: 'forward',
  peBasis: 'ttm',
  roeBasis: 'annual',
  note: '技术指标基于前复权收盘价，除息缺口已抹平；PE 为 TTM、ROE 为年报口径。',
};

/**
 * 启动装配成功拉到真实日线后调用：就地切换 meta（app.ts 持有同一引用，无需重新注入）。
 * quoteTime 取日线最后一根的日期；复权口径不变（kline 源即前复权）。
 */
export function activateLiveMeta(quoteTime: string): void {
  DATA_META.dataMode = 'live';
  DATA_META.quoteTime = quoteTime;
  DATA_META.note =
    '技术指标基于交易所前复权日线（东方财富），除息缺口已抹平；PE 为 TTM、ROE 为年报口径；研究结论随盘中价格重算。';
}

/** 数据声明随模式切换：demo 用演示文案，live 用真实行情文案。 */
export function getDataNotice(): string {
  return DATA_META.dataMode === 'live' ? LIVE_DATA_NOTICE : DATA_NOTICE;
}
