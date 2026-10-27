export const money = (value: number, digits = 2) =>
  new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

export const compactMoney = (value: number) => {
  if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(2)}万`;
  return money(value, 0);
};

export const number = (value: number, digits = 2) =>
  new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

export const percent = (value: number, digits = 2) => `${value.toFixed(digits)}%`;

export const shortSymbol = (symbol: string) => symbol.split('.')[0];
