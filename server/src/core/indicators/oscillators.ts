/**
 * 日内交易常用的震荡 / 波动指标：BOLL、MACD、RSI、ATR。
 *
 * 全部是纯函数，数据不足返回 null —— 与其他 indicators 保持一致，
 * 调用方（analysis/intraday.ts）负责降级展示，不在这里抛错。
 */

import type { GateCandle } from '../gate/klines.js';

/** 布林带结果。 */
export interface BollResult {
  /** 中轨（period 日均价） */
  mid: number;
  /** 上轨 */
  upper: number;
  /** 下轨 */
  lower: number;
  /** 带宽：(上轨 - 下轨) / 中轨 * 100 */
  bandwidth: number;
  /** %B：基于最后一根收盘价，0 = 下轨，100 = 上轨 */
  percentB: number;
}

/**
 * 布林带 BOLL(period, mult)。
 * 标准差用总体口径（除以 period），与主流行情软件一致。
 */
export function calculateBoll(closes: number[], period = 20, mult = 2): BollResult | null {
  if (period <= 0 || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const width = upper - lower;
  return {
    mid,
    upper,
    lower,
    bandwidth: (width / mid) * 100,
    percentB: width > 0 ? ((slice[slice.length - 1]! - lower) / width) * 100 : 50,
  };
}

/**
 * 当前布林带宽在最近 lookback 根里的百分位（0~100）。
 * 用于判断「收敛（缩口）/ 正常 / 扩张（开口）」：
 * 百分位越低，带宽越窄，越接近变盘。
 */
export function bollBandwidthPercentile(
  closes: number[],
  period = 20,
  mult = 2,
  lookback = 48,
): number | null {
  if (closes.length < period + 4) return null;
  const widths: number[] = [];
  const start = Math.max(period, closes.length - lookback);
  for (let end = start; end <= closes.length; end++) {
    const b = calculateBoll(closes.slice(0, end), period, mult);
    if (b) widths.push(b.bandwidth);
  }
  if (widths.length < 5) return null;
  const latest = widths[widths.length - 1]!;
  // 并列值按一半计入，避免「带宽长期恒定（全是 0）」被算成 100% 扩张。
  const below = widths.filter((w) => w < latest).length;
  const equal = widths.filter((w) => w === latest).length;
  return ((below + equal / 2) / widths.length) * 100;
}

/** 指数移动平均（EMA）；空数组返回空数组。 */
export function emaSeries(values: number[], period: number): number[] {
  if (period <= 0 || values.length === 0) return [];
  const alpha = 2 / (period + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i]! * alpha + out[i - 1]! * (1 - alpha));
  }
  return out;
}

/** MACD 结果（中国行情软件口径：柱 = 2 × (DIF - DEA)）。 */
export interface MacdResult {
  dif: number;
  dea: number;
  /** MACD 柱（红正绿负） */
  hist: number;
  /** 上一根的 DIF / DEA / 柱，用于判断金叉死叉与动能增减 */
  prevDif: number | null;
  prevDea: number | null;
  prevHist: number | null;
}

/**
 * MACD(fast, slow, signal)。
 * 数据不足（< slow + signal 根）返回 null —— 少于这个数量时 DEA 还没稳定。
 */
export function calculateMacd(closes: number[], fast = 12, slow = 26, signal = 9): MacdResult | null {
  if (fast <= 0 || slow <= 0 || signal <= 0 || fast >= slow) return null;
  if (closes.length < slow + signal) return null;
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const difSeries = closes.map((_, i) => emaFast[i]! - emaSlow[i]!);
  const deaSeries = emaSeries(difSeries, signal);
  const n = closes.length - 1;
  const dif = difSeries[n]!;
  const dea = deaSeries[n]!;
  const hist = (dif - dea) * 2;
  const prevDif = n >= 1 ? difSeries[n - 1]! : null;
  const prevDea = n >= 1 ? deaSeries[n - 1]! : null;
  return {
    dif,
    dea,
    hist,
    prevDif,
    prevDea,
    prevHist: prevDif !== null && prevDea !== null ? (prevDif - prevDea) * 2 : null,
  };
}

/**
 * RSI(period)，Wilder 平滑口径。
 * 全涨返回 100，全平/无波动返回 50。
 */
export function calculateRsi(closes: number[], period = 14): number | null {
  if (period <= 0 || closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * ATR(period)，Wilder 平滑口径，返回绝对价格波幅。
 * 需要 period + 1 根 K 线（第一根只用于算真实波幅）。
 */
export function calculateAtr(candles: GateCandle[], period = 14): number | null {
  if (period <= 0 || candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i]!;
    const prev = candles[i - 1]!;
    trs.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }
  return Number.isFinite(atr) ? atr : null;
}
