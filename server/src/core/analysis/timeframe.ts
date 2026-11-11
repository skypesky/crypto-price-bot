import type { GateCandle } from '../gate/klines.js';
import { calculateMA } from '../indicators/ma.js';
import { calculateTrend } from '../indicators/trend.js';

/** 趋势方向。 */
export type Dir = 'up' | 'down' | 'flat';

/** 带符号百分比。 */
export const pct = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

/** 绝对值百分比（用于「跌破 MA7 4.53%」这种正负已由文案表达的场景）。 */
export const pctAbs = (v: number): string => `${v.toFixed(2)}%`;

/** 涨跌定性：|v| < 0.5% 横盘，2% 以上算明确方向，8% 以上算强。 */
export function grade(v: number): { dir: Dir; word: string } {
  if (v >= 8) return { dir: 'up', word: '强势上涨' };
  if (v >= 2) return { dir: 'up', word: '上涨' };
  if (v > 0.5) return { dir: 'up', word: '微涨' };
  if (v <= -8) return { dir: 'down', word: '大幅走弱' };
  if (v <= -2) return { dir: 'down', word: '下跌' };
  if (v < -0.5) return { dir: 'down', word: '微跌' };
  return { dir: 'flat', word: '横盘' };
}

/** 现价相对某条均线的偏离（正=站上，负=跌破）。 */
export function maOffset(current: number, ma: number | null): number | null {
  if (ma === null || ma === 0) return null;
  return ((current - ma) / ma) * 100;
}

/** 一条均线及其相对现价的偏离。 */
export interface MaView {
  /** 均线周期（根数） */
  period: number;
  /** 展示名，例如 MA7 / 3年年均线 */
  label: string;
  /** 均线值 */
  value: number | null;
  /** 偏离百分比（正=站上，负=跌破） */
  offset: number | null;
}

/** 计算若干条均线及其偏离。 */
export function computeMAs(
  candles: GateCandle[],
  current: number,
  specs: { period: number; label: string }[],
): MaView[] {
  const closes = candles.map((c) => c.close);
  return specs.map((s) => {
    const value = calculateMA(closes, s.period);
    return { period: s.period, label: s.label, value, offset: maOffset(current, value) };
  });
}

/** 窗口涨跌幅：当前价相对 n 根之前的收盘价。数据不足返回 null。 */
export function changeOver(candles: GateCandle[], current: number, n: number): number | null {
  const closes = candles.map((c) => c.close);
  const idx = closes.length - 1 - n;
  if (idx < 0) return null;
  return calculateTrend(current, closes[idx]);
}

/** 区间内最高价（用 high，比 close 更能反映真实压力位）。数据不够该区间长度时返回 null。 */
export function periodHigh(candles: GateCandle[], n: number): number | null {
  if (candles.length < n || n <= 0) return null;
  const highs = candles.slice(-n)
    .map((c) => c.high)
    .filter((h) => Number.isFinite(h) && h > 0);
  return highs.length ? Math.max(...highs) : null;
}

/** 距区间高点的回撤（负数；0 表示仍在高位）。 */
export function drawdown(current: number, high: number | null): number | null {
  if (high === null || high <= 0) return null;
  return ((current - high) / high) * 100;
}

/** 连续同向的 K 线根数（从上一根往回数，跳过最后一根进行中的 K 线）。平盘会打断连击。 */
export function consecutiveRun(candles: GateCandle[]): { days: number; up: boolean } {
  let days = 0;
  let up = false;
  for (let i = candles.length - 2; i >= 1; i--) {
    const cur = candles[i]!;
    const prev = candles[i - 1]!;
    const isUp = cur.close > prev.close;
    const isDown = cur.close < prev.close;
    if (i === candles.length - 2) {
      if (isUp) { up = true; days = 1; }
      else if (isDown) { up = false; days = 1; }
      else { up = true; days = 0; } // 平盘：没有连续同向
      continue;
    }
    if ((isUp && up) || (isDown && !up)) days++;
    else break;
  }
  return { days, up };
}

/** 近 n 个完整周期的量能 vs 前 n 个完整周期（排除最后一根进行中的）。 */
export function volumeTrend(candles: GateCandle[], n = 7): number | null {
  const complete = candles.slice(0, -1);
  if (complete.length < n * 2) return null;
  const recent = complete.slice(-n);
  const prev = complete.slice(-n * 2, -n);
  const sum = (arr: GateCandle[]) => arr.reduce((a, c) => a + c.volume, 0);
  const prevSum = sum(prev);
  if (prevSum <= 0) return null;
  return ((sum(recent) - prevSum) / prevSum) * 100;
}

/** 近 n 个完整周期的平均振幅。 */
export function avgAmplitude(candles: GateCandle[], n = 7): number | null {
  const complete = candles.slice(0, -1).slice(-n);
  if (complete.length === 0) return null;
  const amps = complete
    .filter((c) => c.close > 0)
    .map((c) => ((c.high - c.low) / c.close) * 100);
  if (!amps.length) return null;
  return amps.reduce((a, b) => a + b, 0) / amps.length;
}

/** 均线排列（多头排列 / 空头排列 / 纠缠）。数据不足返回空串。 */
export function maAlignment(ma7: number | null, ma30: number | null, ma90: number | null): string {
  if (ma7 === null || ma30 === null || ma90 === null) return '';
  if (ma7 > ma30 && ma30 > ma90) return '均线多头排列';
  if (ma7 < ma30 && ma30 < ma90) return '均线空头排列';
  return '均线纠缠';
}

/**
 * 把月线聚合成年线（按 UTC 自然年分组）。
 * Gate 没有年线区间，年线只能由月线合成 —— 因此年线口径是「自然年」而不是「365 天」。
 */
export function aggregateToYearly(monthly: GateCandle[]): GateCandle[] {
  const groups = new Map<number, GateCandle[]>();
  for (const c of monthly) {
    const year = new Date(c.ts * 1000).getUTCFullYear();
    const arr = groups.get(year);
    if (arr) arr.push(c);
    else groups.set(year, [c]);
  }
  const out: GateCandle[] = [];
  for (const [year, arr] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const highs = arr.map((c) => c.high).filter((h) => Number.isFinite(h) && h > 0);
    const lows = arr.map((c) => c.low).filter((l) => Number.isFinite(l) && l > 0);
    const close = arr[arr.length - 1]!.close;
    out.push({
      ts: arr[0]!.ts,
      close,
      high: highs.length ? Math.max(...highs) : close,
      low: lows.length ? Math.min(...lows) : close,
      volume: arr.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

/** 一个周期的分析素材。 */
export interface TimeframeView {
  /** 当前价 */
  current: number;
  /** 主窗口涨跌幅 */
  change: number | null;
  /** 均线视图 */
  mas: MaView[];
  /** 距区间高点回撤 */
  drawdown: number | null;
  /** 连续同向 */
  run: { days: number; up: boolean };
  /** 均线排列 */
  align: string;
}

/** 组装均线位置文案（站上 / 跌破）。 */
function maBits(mas: MaView[]): string[] {
  const out: string[] = [];
  for (const ma of mas) {
    if (ma.offset === null) continue;
    out.push(`现价${ma.offset >= 0 ? '站上' : '跌破'}${ma.label} ${pctAbs(Math.abs(ma.offset))}`);
  }
  return out;
}

/**
 * 日线研判：近 7 日涨跌 + 均线位置 + 量能 + 振幅。
 * 量能与振幅是日线口径（周/月/年级看量能意义不大），所以单独传进来。
 */
export function describeDaily(view: TimeframeView, volume: number | null, amplitude: number | null): string {
  const bits: string[] = [];
  if (view.change !== null) {
    const g = grade(view.change);
    bits.push(`${g.word} ${pct(view.change)}`);
  }
  if (view.run.days >= 2) bits.push(`连${view.run.up ? '阳' : '阴'}${view.run.days}根`);
  bits.push(...maBits(view.mas));
  if (view.align) bits.push(view.align);
  if (volume !== null && Math.abs(volume) >= 15) {
    bits.push(`近7日量能${volume >= 0 ? '放大' : '萎缩'}${Math.abs(volume).toFixed(0)}%`);
  }
  if (amplitude !== null) bits.push(`日均振幅${amplitude.toFixed(1)}%`);
  return bits.length ? `日线：${bits.join('，')}` : '日线：数据不足';
}

/** 周线研判：近 4 周涨跌 + 均线位置 + 13 周高点回撤。 */
export function describeWeekly(view: TimeframeView): string {
  const bits: string[] = [];
  if (view.change !== null) {
    const g = grade(view.change);
    bits.push(`${g.word} ${pct(view.change)}`);
  }
  if (view.run.days >= 2) bits.push(`连${view.run.up ? '阳' : '阴'}${view.run.days}周`);
  bits.push(...maBits(view.mas));
  if (view.drawdown !== null && view.drawdown < -1) {
    bits.push(`距13周高点回撤${pctAbs(Math.abs(view.drawdown))}`);
  }
  return bits.length ? `周线：${bits.join('，')}` : '周线：数据不足';
}

/** 月线研判：近 3 月涨跌 + 均线位置 + 12 月高点回撤。 */
export function describeMonthly(view: TimeframeView): string {
  const bits: string[] = [];
  if (view.change !== null) {
    const g = grade(view.change);
    bits.push(`${g.word} ${pct(view.change)}`);
  }
  if (view.run.days >= 2) bits.push(`连${view.run.up ? '阳' : '阴'}${view.run.days}月`);
  bits.push(...maBits(view.mas));
  if (view.drawdown !== null && view.drawdown < -1) {
    bits.push(`距12月高点回撤${pctAbs(Math.abs(view.drawdown))}`);
  }
  return bits.length ? `月线：${bits.join('，')}` : '月线：数据不足';
}

/**
 * 年线研判：近 1 年涨跌 + 3 年均线位置 + 1/3 年高点回撤。
 * 回撤用月线粒度计算 —— 年K 只有几根，用年K 的最高价会把"1 年高点"错算成"近几年高点"。
 */
export function describeYearly(view: TimeframeView, monthly: GateCandle[]): string {
  const bits: string[] = [];
  if (view.change !== null) {
    const g = grade(view.change);
    bits.push(`${g.word} ${pct(view.change)}`);
  }
  if (view.run.days >= 2) bits.push(`连${view.run.up ? '阳' : '阴'}${view.run.days}年`);
  bits.push(...maBits(view.mas));
  const dd1 = drawdown(view.current, periodHigh(monthly, 12));
  const dd3 = drawdown(view.current, periodHigh(monthly, 36));
  if (dd1 !== null && dd1 < -1) bits.push(`距1年高点回撤${pctAbs(Math.abs(dd1))}`);
  if (dd3 !== null && dd3 < -20) bits.push(`距3年高点回撤${pctAbs(Math.abs(dd3))}`);
  return bits.length ? `年线：${bits.join('，')}` : '年线：数据不足';
}
