import type { GateCandle } from '../gate/klines.js';
import {
  bollBandwidthPercentile,
  calculateAtr,
  calculateBoll,
  calculateMacd,
  calculateRsi,
  type MacdResult,
} from '../indicators/oscillators.js';
import { volumeTrend } from './timeframe.js';

/** 箱体回看根数（1h × 48 = 2 天）。 */
const BOX_LOOKBACK_1H = 48;
/** 箱体边缘判定：距上下沿 20% 以内算「上沿 / 下沿」。 */
const BOX_EDGE_PCT = 20;
/** 箱体宽度 ≤ 平均单根振幅 × 该倍数时，视为震荡箱体；否则是宽幅/单边。 */
const RANGE_RATIO = 6;

export interface IntradayInput {
  /** 当前价（实时 ticker） */
  current: number;
  /** 4h K 线（升序，最后一根进行中） */
  candles4h: GateCandle[];
  /** 1h K 线（升序，最后一根进行中） */
  candles1h: GateCandle[];
}

/**
 * 日内分析结果（为压缩消息高度，固定输出 1~3 行指标 + 1 行建议）：
 *   headline  方向 + 箱体位置
 *   h4        4h 指标（布林上中下轨 / MACD / RSI / ATR / 量能）
 *   h1        1h 指标（布林上中下轨 / %B / MACD / RSI）
 *   advice    日内操作建议
 */
export interface IntradayAnalysis {
  headline: string;
  h4: string | null;
  h1: string | null;
  advice: string;
}

interface BoxInfo {
  high: number;
  low: number;
  mid: number;
  /** 箱体宽度 / 中值 × 100 */
  widthPct: number;
  /** 现价在箱体中的位置：0 = 下沿，100 = 上沿，可越界（突破/跌破） */
  posPct: number;
  /** true = 箱体震荡；false = 宽幅/单边 */
  isRange: boolean;
  bars: number;
}

/** 价格展示：主流币 2 位，小币 6 位。 */
function usd(n: number): string {
  const digits = Math.abs(n) >= 1 ? 2 : 6;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** 布林带宽百分位 → 收敛 / 正常 / 扩张。 */
function squeezeTag(percentile: number | null): string {
  if (percentile === null) return '';
  if (percentile <= 30) return '收敛';
  if (percentile >= 70) return '扩张';
  return '正常';
}

/** MACD 状态：金叉/死叉优先，其次看柱体增减。 */
function macdTag(m: MacdResult): string {
  const golden = m.prevDif !== null && m.prevDea !== null && m.prevDif <= m.prevDea && m.dif > m.dea;
  const dead = m.prevDif !== null && m.prevDea !== null && m.prevDif >= m.prevDea && m.dif < m.dea;
  if (golden) return '刚金叉';
  if (dead) return '刚死叉';

  const expanding = m.prevHist !== null && Math.abs(m.hist) > Math.abs(m.prevHist) * 1.05;
  const shrinking = m.prevHist !== null && Math.abs(m.hist) < Math.abs(m.prevHist) * 0.95;
  if (m.hist > 0) return expanding ? '多头动能增强' : shrinking ? '多头动能减弱' : '多头动能平缓';
  if (m.hist < 0) return expanding ? '空头动能增强' : shrinking ? '空头动能减弱' : '空头动能平缓';
  return '动能中性';
}

/** RSI 定性。 */
function rsiTag(v: number): string {
  if (v >= 70) return '超买';
  if (v <= 30) return '超卖';
  if (v >= 55) return '偏强';
  if (v <= 45) return '偏弱';
  return '中性';
}

/** %B 位置定性。 */
function bandPositionTag(pctB: number): string {
  if (pctB >= 100) return '突破上轨';
  if (pctB >= 80) return '上轨附近';
  if (pctB >= 55) return '中轨上方';
  if (pctB > 45) return '中轨附近';
  if (pctB > 20) return '中轨下方';
  if (pctB > 0) return '下轨附近';
  return '跌破下轨';
}

/** 4h ATR 占现价比例 → 波动高低（4h 单根）。 */
function atrTag(pct: number): string {
  if (pct <= 0.8) return '低波动';
  if (pct <= 2) return '波动中等';
  return '波动偏高';
}

/** 箱体位置定性。 */
function boxPositionTag(posPct: number): string {
  if (posPct > 100) return '已突破上沿';
  if (posPct < 0) return '已跌破下沿';
  if (posPct >= 100 - BOX_EDGE_PCT) return '上沿';
  if (posPct <= BOX_EDGE_PCT) return '下沿';
  return '中部';
}

/** 箱体位置的紧凑写法：中部45%；突破/跌破时不带百分比（会超过 100%）。 */
function boxPosText(box: BoxInfo): string {
  const tag = boxPositionTag(box.posPct);
  return box.posPct > 100 || box.posPct < 0 ? tag : `${tag}${box.posPct.toFixed(0)}%`;
}

/**
 * 识别近 2 天 1h 的箱体：用完整 K 线（剔除进行中的最后一根）的高低点，
 * 并用「箱体宽度 / 平均单根振幅」判断是箱体震荡还是宽幅趋势。
 */
function detectBox(candles1h: GateCandle[], current: number): BoxInfo | null {
  const complete = candles1h.slice(0, -1).slice(-BOX_LOOKBACK_1H);
  if (complete.length < 10) return null;

  const highs = complete.map((c) => c.high).filter((h) => Number.isFinite(h) && h > 0);
  const lows = complete.map((c) => c.low).filter((l) => Number.isFinite(l) && l > 0);
  if (!highs.length || !lows.length) return null;

  const high = Math.max(...highs);
  const low = Math.min(...lows);
  if (high <= low) return null;

  const mid = (high + low) / 2;
  const widthPct = ((high - low) / mid) * 100;
  const posPct = ((current - low) / (high - low)) * 100;
  const avgRangePct = complete.reduce(
    (sum, c) => sum + (c.close > 0 ? ((c.high - c.low) / c.close) * 100 : 0),
    0,
  ) / complete.length;

  return {
    high,
    low,
    mid,
    widthPct,
    posPct,
    isRange: avgRangePct > 0 && widthPct <= avgRangePct * RANGE_RATIO,
    bars: complete.length,
  };
}

/** 日内操作建议：箱体边缘 / 突破 / 趋势跟随三套逻辑（尽量简短）。 */
function adviceOf(ctx: {
  dir: '偏多' | '偏空' | '震荡';
  box: BoxInfo | null;
  macd4: MacdResult | null;
  rsi4: number | null;
  volumeUp: boolean;
  current: number;
}): string {
  const { dir, box, macd4, rsi4, volumeUp, current } = ctx;
  const rsiHot = rsi4 !== null && rsi4 >= 75;
  const rsiCold = rsi4 !== null && rsi4 <= 25;

  if (box) {
    if (current > box.high) {
      return volumeUp && macd4 !== null && macd4.hist > 0
        ? '突破箱顶且量能配合，回踩不破可轻仓跟随，跌回箱内止损'
        : '突破量能/动能不足，防假突破，等回踩确认';
    }
    if (current < box.low) {
      return '跌破箱底，防下探；反抽不过箱底减仓，勿抄底';
    }
    if (box.isRange) {
      if (box.posPct >= 100 - BOX_EDGE_PCT) {
        return rsiHot
          ? '箱体上沿且RSI超买，不追多；持仓可部分止盈，放量站稳再跟'
          : '箱体上沿不追多，持仓可部分止盈，放量站稳再跟';
      }
      if (box.posPct <= BOX_EDGE_PCT) {
        return rsiCold
          ? '箱体下沿且RSI超卖，可轻仓试多，跌破箱底止损'
          : '箱体下沿可轻仓试多，跌破箱底止损';
      }
      return '箱体中部观望，等边缘或放量突破';
    }
  }

  if (dir === '偏多') return '4h偏多，回踩中轨/箱底分批低吸，跌破中轨止损';
  if (dir === '偏空') return '4h偏空，反弹中轨/箱顶承压，勿追多';
  return '方向不明，观望等共振';
}

/**
 * 生成日内交易分析：4h 定方向，1h 找箱体与入场位置。
 * 纯函数，不做 IO；4h / 1h 数据各缺一边时降级为只展示可用的部分。
 */
export function analyzeIntraday(input: IntradayInput): IntradayAnalysis | null {
  const { current, candles4h, candles1h } = input;
  if (!Number.isFinite(current) || current <= 0) return null;

  // 指标一律用「已收盘」的 K 线，避免把进行中的半根当成完整信号。
  const complete4 = candles4h.slice(0, -1);
  const complete1 = candles1h.slice(0, -1);
  const closes4 = complete4.map((c) => c.close);
  const closes1 = complete1.map((c) => c.close);

  const boll4 = calculateBoll(closes4);
  const macd4 = calculateMacd(closes4);
  const rsi4 = calculateRsi(closes4);
  const atr4 = calculateAtr(complete4);
  const bandPct4 = bollBandwidthPercentile(closes4);

  const boll1 = calculateBoll(closes1);
  const macd1 = calculateMacd(closes1);
  const rsi1 = calculateRsi(closes1);
  const bandPct1 = bollBandwidthPercentile(closes1, 20, 2, BOX_LOOKBACK_1H);

  const box = detectBox(candles1h, current);
  const has4 = boll4 !== null || macd4 !== null || rsi4 !== null;
  if (!has4 && !box) return null;

  // ---- 4h 方向评分：布林中轨 + MACD 柱 + RSI 各一票 ----
  let score = 0;
  let votes = 0;
  if (boll4) {
    votes++;
    score += current > boll4.mid ? 1 : current < boll4.mid ? -1 : 0;
  }
  if (macd4) {
    votes++;
    score += macd4.hist > 0 ? 1 : macd4.hist < 0 ? -1 : 0;
  }
  if (rsi4 !== null) {
    votes++;
    score += rsi4 >= 55 ? 1 : rsi4 <= 45 ? -1 : 0;
  }
  const dir: '偏多' | '偏空' | '震荡' =
    votes === 0 || (score > -2 && score < 2) ? '震荡' : score >= 2 ? '偏多' : '偏空';

  // ---- 方向 + 箱体位置（第一行）----
  const dirText = has4 ? `4h ${dir}` : '4h 数据不足';
  const boxText = box
    ? `箱体 ${usd(box.low)}~${usd(box.high)}(${box.widthPct.toFixed(1)}% ${boxPosText(box)})`
    : '';
  const headline = [dirText, boxText].filter(Boolean).join(' · ');

  // ---- 4h 指标（一行）----
  const h4Parts: string[] = [];
  if (boll4) {
    const squeeze = squeezeTag(bandPct4);
    h4Parts.push(
      `BOLL4h 上${usd(boll4.upper)}/中${usd(boll4.mid)}/下${usd(boll4.lower)}` +
      `(带宽${boll4.bandwidth.toFixed(1)}%${squeeze ? ` ${squeeze}` : ''})`,
    );
  }
  if (macd4) h4Parts.push(`MACD${macdTag(macd4)}`);
  if (rsi4 !== null) h4Parts.push(`RSI${rsi4.toFixed(1)}(${rsiTag(rsi4)})`);
  if (atr4 !== null) {
    const atrPct = (atr4 / current) * 100;
    h4Parts.push(`ATR${atrPct.toFixed(2)}%(${atrTag(atrPct)})`);
  }
  const vol = volumeTrend(candles4h, 6);
  const volumeUp = (vol ?? 0) > 0;
  if (vol !== null && Math.abs(vol) >= 10) {
    h4Parts.push(`量能${vol >= 0 ? '+' : ''}${vol.toFixed(0)}%`);
  }

  // ---- 1h 指标（一行）----
  const h1Parts: string[] = [];
  if (boll1) {
    const pctB = boll1.upper > boll1.lower
      ? ((current - boll1.lower) / (boll1.upper - boll1.lower)) * 100
      : 50;
    const squeeze = squeezeTag(bandPct1);
    h1Parts.push(
      `BOLL1h 上${usd(boll1.upper)}/中${usd(boll1.mid)}/下${usd(boll1.lower)}` +
      `(%B${pctB.toFixed(0)}% ${bandPositionTag(pctB)}${squeeze ? ` ${squeeze}` : ''})`,
    );
  }
  if (macd1) h1Parts.push(`MACD${macdTag(macd1)}`);
  if (rsi1 !== null) h1Parts.push(`RSI${rsi1.toFixed(1)}(${rsiTag(rsi1)})`);

  return {
    headline,
    h4: h4Parts.length ? h4Parts.join(' · ') : null,
    h1: h1Parts.length ? h1Parts.join(' · ') : null,
    advice: adviceOf({ dir, box, macd4, rsi4, volumeUp, current }),
  };
}
