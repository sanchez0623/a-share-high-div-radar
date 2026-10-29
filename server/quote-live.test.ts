import assert from 'node:assert/strict';
import test from 'node:test';
import type { RawQuote } from '../shared/quote-types.ts';
import type { PriceBar } from '../shared/types.ts';
import { applyQuoteToHistory, loadAllBars, quoteTradingDate } from './bar-store.ts';

function bar(date: string, close: number): PriceBar {
  return { date, open: close, high: close + 0.5, low: close - 0.5, close, volume: 1_000_000 };
}

function quote(overrides: Partial<RawQuote> = {}): RawQuote {
  return {
    symbol: '601318.SH',
    name: '中国平安',
    price: 53.2,
    prevClose: 52.31,
    open: 52.25,
    high: 53.2,
    low: 51.42,
    volume: 100_009_200,
    amount: 5_262_310_000,
    changePct: 1.7013955266679481,
    quoteTime: '2026-10-29T15:00:21+08:00',
    fetchedAt: '2026-10-29T07:00:21.000Z',
    source: 'tencent',
    quoteTimeReliable: true,
    ...overrides,
  };
}

// 当日日线 high=53.0 / low=51.5：与快照(53.2/51.42)取并集后应得 53.2 / 51.42。
const HISTORY = [
  bar('2026-10-27', 52.62),
  bar('2026-10-28', 52.31),
  { date: '2026-10-29', open: 53.0, high: 53.0, low: 51.5, close: 53.1, volume: 99_000_000 },
];

test('快照日期与最后一根日线相同时覆盖当日 bar，历史序列不受影响', () => {
  const next = applyQuoteToHistory(HISTORY, quote());
  assert.notEqual(next, HISTORY);
  assert.equal(next.length, 3);
  assert.deepEqual(next.slice(0, 2), HISTORY.slice(0, 2));
  assert.equal(next[2].date, '2026-10-29');
  assert.equal(next[2].close, 53.2);
  // high/low 取日线与快照的区间并集；volume 以快照为准。
  assert.equal(next[2].high, 53.2);
  assert.equal(next[2].low, 51.42);
  assert.equal(next[2].volume, 100_009_200);
});

test('快照数据与日线一致时返回同一引用，避免无意义复制', () => {
  const settled = [bar('2026-10-28', 52.31), { date: '2026-10-29', open: 52.25, high: 53.2, low: 51.42, close: 53.2, volume: 100_009_200 }];
  assert.equal(applyQuoteToHistory(settled, quote()), settled);
});

test('快照晚于最后一根日线时追加新交易日（open/high/low 取快照值）', () => {
  const next = applyQuoteToHistory(HISTORY.slice(0, 2), quote());
  assert.equal(next.length, 3);
  const appended = next[2];
  assert.equal(appended.date, '2026-10-29');
  assert.equal(appended.open, 52.25);
  assert.equal(appended.close, 53.2);
  assert.equal(appended.high, 53.2);
  assert.equal(appended.low, 51.42);
});

test('快照早于最后一根日线（停牌残留）或价格为 0 时不回写', () => {
  const stale = quote({ quoteTime: '2026-10-28T15:00:00+08:00' });
  assert.equal(applyQuoteToHistory(HISTORY, stale), HISTORY);
  const halted = quote({ price: 0, quoteTime: '2026-10-30T15:00:00+08:00' });
  assert.equal(applyQuoteToHistory(HISTORY, halted), HISTORY);
  const empty: PriceBar[] = [];
  assert.equal(applyQuoteToHistory(empty, quote()), empty);
});

test('quoteTradingDate 按上海时区取交易日，无论快照时区表述', () => {
  assert.equal(quoteTradingDate(quote()), '2026-10-29');
  // UTC 表述的 2026-10-29T17:00:00Z 对应上海 10-30 凌晨——快照日期以上海日历为准。
  assert.equal(quoteTradingDate(quote({ quoteTime: '2026-10-29T17:00:00.000Z' })), '2026-10-30');
  assert.equal(quoteTradingDate(quote({ quoteTime: 'not-a-date' })), '');
});

test('loadAllBars 对缺失/损坏文件容错返回空集合，不抛错', () => {
  const result = loadAllBars(['000000.XX']);
  assert.equal(result.size, 0);
});
