/**
 * 真实日历日期校验：只接受 YYYY-MM-DD，且年月日必须真实存在。
 * 仅校验字符串形状会放过 2026-02-31、2026-13-01 这类伪日期。
 */
export function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
