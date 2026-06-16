/**
 * 简单移动平均线：取最近 period 个价格求平均。
 * 数据不足返回 null。
 */
export function calculateMA(prices: number[], period: number): number | null {
  if (period <= 0) return null;
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  let sum = 0;
  for (const v of slice) sum += v;
  return sum / period;
}