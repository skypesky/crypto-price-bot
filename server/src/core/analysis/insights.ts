import type { GateCandle } from '../gate/klines.js';
import { drawdown, grade, periodHigh, type Dir, type TimeframeView } from './timeframe.js';

/** 均线偏离 → 是否站上（null = 数据缺失）。 */
function aboveMa(offset: number | null | undefined): boolean | null {
  return offset === null || offset === undefined ? null : offset >= 0;
}

/** 从 view 里取方向（无涨跌幅时按横盘处理）。 */
function viewDir(view: TimeframeView): Dir {
  return view.change === null ? 'flat' : grade(view.change).dir;
}

/** 日线解读：方向 + MA7/MA30 位置 + 均线排列。 */
export function dailyRead(view: TimeframeView): string {
  const dir = viewDir(view);
  const a7 = aboveMa(view.mas[0]?.offset);
  const a30 = aboveMa(view.mas[1]?.offset);

  if (dir === 'down') {
    if (a7 === false && a30 === false) return '短期空头占优，均线压制，反弹先看能否收复 MA7';
    if (a30 === false) return '短线回升但仍在 MA30 下方，中期压力未解除';
    return '短期偏弱，反弹力度有待确认';
  }
  if (dir === 'up') {
    if (a7 === true && a30 === true) {
      return view.align === '均线多头排列'
        ? '短期多头占优，均线多头排列，回踩不破可续'
        : '短期多头占优，均线支撑有效';
    }
    return '短线反弹，但均线尚未全面转多';
  }
  return view.align === '均线纠缠'
    ? '多空拉锯，方向未明，等待放量选择方向'
    : '横盘整理，等待方向选择';
}

/** 周线解读：方向 + MA5/MA20 位置 + 回撤深度。 */
export function weeklyRead(view: TimeframeView): string {
  const dir = viewDir(view);
  const a5 = aboveMa(view.mas[0]?.offset);
  const a20 = aboveMa(view.mas[1]?.offset);

  if (dir === 'down') {
    if (a20 === true) return '中期回调但 MA20 未破，趋势结构尚在，关注 MA20 支撑';
    if (view.drawdown !== null && view.drawdown < -30) {
      return '中期转弱且回撤较深，修复需要时间，反弹注意均线压力';
    }
    return '中期偏弱，反弹关注均线压力';
  }
  if (dir === 'up') {
    if (a5 === true) return '中期趋势偏多，均线支撑良好';
    return '中期回升但仍在 MA5 下方，需确认突破有效性';
  }
  return '中期横盘整理，方向未明';
}

/** 月线解读：长期方向 + MA3/MA12 位置，区分「强势中的回调」与「趋势转弱」。 */
export function monthlyRead(view: TimeframeView): string {
  const dir = viewDir(view);
  const a3 = aboveMa(view.mas[0]?.offset);
  const a12 = aboveMa(view.mas[1]?.offset);

  if (dir === 'up') {
    if (a3 === false && a12 === true) return '长期强势中的短期回调，MA12 未破前趋势仍属健康';
    if (a3 === true) return '长期趋势向上，价格运行于均线上方';
    return '长期偏多但均线支撑转弱，注意回踩确认';
  }
  if (dir === 'down') {
    if (a12 === false) return '长期趋势转弱且跌破 MA12，需谨慎';
    return '长期回调，关注 MA12 能否形成支撑';
  }
  return '长期横盘，等待方向选择';
}

/** 年线解读：长期方向 + 年均线位置 + 距 3 年高点回撤。 */
export function yearlyRead(view: TimeframeView, monthly: GateCandle[]): string {
  const dir = viewDir(view);
  const aMa = aboveMa(view.mas[0]?.offset);
  const dd3 = drawdown(view.current, periodHigh(monthly, 36));

  if (dir === 'up') {
    if (aMa === true) {
      return dd3 !== null && dd3 < -50
        ? '长期上升趋势未破，但距高点回撤较深，仍处修复期'
        : '长期上升趋势未破，价格运行于年均线上方';
    }
    return '长期仍偏多，但已跌破年均线，趋势强度减弱';
  }
  if (dir === 'down') {
    return aMa === false
      ? '长期趋势转弱且跌破年均线，抄底需谨慎'
      : '长期回调，关注年均线支撑';
  }
  return '长期横盘，趋势方向待确认';
}
