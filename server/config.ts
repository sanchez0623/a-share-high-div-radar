import type { DataMeta } from '../shared/types.ts';

export const AS_OF = '2026-10-23';
export const DATA_NOTICE =
  '演示数据，不构成实时行情或投资建议；行情为前复权收盘价，PE 为 TTM、ROE 为年报口径';

/** 行情时间、复权方式与估值口径；真实数据接入后必须由数据源覆盖。 */
export const DATA_META: DataMeta = {
  dataMode: 'demo',
  quoteTime: `${AS_OF} 15:00`,
  priceAdjustment: 'forward',
  indicatorAdjustment: 'forward',
  peBasis: 'ttm',
  roeBasis: 'annual',
  note: '技术指标基于前复权收盘价，除息缺口已抹平；PE 为 TTM、ROE 为年报口径。',
};
