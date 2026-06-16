/**
 * 计算价格变化百分比：(current - past) / past * 100，保留 2 位小数。
 * past 为 0 或 null 返回 null。
 */
export function calculateTrend(current: number, past: number | null | undefined): number | null {
  if (past === null || past === undefined) return null;
  if (past === 0) return null;
  if (!Number.isFinite(current) || !Number.isFinite(past)) return null;
  return Number(((current - past) / past * 100).toFixed(2));
}