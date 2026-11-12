import type { GateDerivatives } from '../gate/futures.js';
import type { Dir } from './timeframe.js';

/** 四个周期的名字，顺序固定：日 / 周 / 月 / 年。 */
const PERIOD_LABELS = ['日线', '周线', '月线', '年线'];

/**
 * 已知周期的方向统计。
 * dirs 里 null = 该周期无数据（拉取失败 / 数据量不足）—— 绝不能当成"横盘"参与方向计数，
 * 否则报告会出现"月线数据不足"却断言"月线持续走弱"的自相矛盾。
 */
function dirStats(dirs: (Dir | null)[]): { text: string; knownCount: number; ups: number; downs: number } {
  const known = dirs.filter((d): d is Dir => d !== null);
  const ups = known.filter((d) => d === 'up').length;
  const downs = known.filter((d) => d === 'down').length;

  let text: string;
  if (known.length === 0) {
    text = '数据不足，暂无法研判';
  } else if (known.length === ups) {
    text = '已知周期一致向上';
  } else if (known.length === downs) {
    text = '已知周期一致走弱';
  } else {
    text = '已知周期方向分化';
  }
  return { text, knownCount: known.length, ups, downs };
}

/** 少数派周期点名：与 dir 方向不同的周期，以及它们是否全部横盘。 */
function oddPeriods(dirs: (Dir | null)[], dir: Dir): { labels: string[]; allFlat: boolean } {
  const oddIdx = dirs.map((d, i) => (d === dir ? -1 : i)).filter((i) => i >= 0);
  return {
    labels: oddIdx.map((i) => PERIOD_LABELS[i]!),
    allFlat: oddIdx.every((i) => dirs[i] === 'flat'),
  };
}

/** 四个周期都有数据时的结论：一致向上 / 一致走弱 / 少数派分化。 */
function fullPeriodText(dirs: (Dir | null)[], stats: { knownCount: number; ups: number; downs: number }): string {
  const { knownCount, ups, downs } = stats;
  if (ups === knownCount) return '日周月年四周期一致向上，趋势健康';
  if (downs === knownCount) return '日周月年四周期一致走弱，下行趋势延续';
  if (ups > downs) {
    // 与多数方向不同的周期单独点名（横盘和回调用不同措辞）
    const odd = oddPeriods(dirs, 'up');
    return odd.allFlat
      ? `${odd.labels.join('/')}横盘整理，其余周期上行趋势未改`
      : `${odd.labels.join('/')}回调，其余周期上行趋势未改`;
  }
  if (downs > ups) {
    const odd = oddPeriods(dirs, 'down');
    return odd.allFlat
      ? `${odd.labels.join('/')}横盘，其余周期持续走弱`
      : `${odd.labels.join('/')}逆势偏强，其余周期仍偏弱，趋势待观察`;
  }
  return ups === 0 ? '各周期横盘，方向未明' : '周期方向分化，趋势待观察';
}

/** 关键位提示：现价相对日线 MA30 的位置。 */
function appendMaHint(text: string, dirs: (Dir | null)[], current: number, ma30: number | null): string {
  if (ma30 === null || ma30 <= 0) return text;
  const off = ((current - ma30) / ma30) * 100;
  if (off < 0 && dirs[0] !== null && dirs[0] !== 'up') return `${text}，站回日线MA30前不宜追多`;
  if (off > 0 && dirs[0] === 'down') return `${text}，但已站上日线MA30，注意回踩确认`;
  return text;
}

/**
 * 四个周期的方向合成一句结论。
 * 缺失的周期会被明说（"月线数据不足，…"），绝不用缺失周期推断方向。
 */
export function conclusion(dirs: (Dir | null)[], current: number, ma30: number | null): string {
  const stats = dirStats(dirs);
  const missing = PERIOD_LABELS.filter((_, i) => dirs[i] === null);

  let text: string;
  if (stats.knownCount === 0) {
    text = stats.text;
  } else if (missing.length > 0) {
    // 只用"确实算出来了"的周期下判断，并把缺失的周期明说出来
    text = `${missing.join('/')}数据不足，${stats.text}`;
  } else {
    text = fullPeriodText(dirs, stats);
  }

  return appendMaHint(text, dirs, current, ma30);
}

/** 主动成交买卖比贡献的盘口偏向（±1）。 */
function takerBias(ratio: number | null): number {
  if (ratio === null || ratio <= 0) return 0;
  if (ratio < 0.95) return -1;
  if (ratio > 1.05) return 1;
  return 0;
}

/** 大户多空比贡献的盘口偏向（±1）。 */
function topLsrBias(ratio: number | null): number {
  if (ratio === null) return 0;
  if (ratio < 0.8) return -1;
  if (ratio > 1.2) return 1;
  return 0;
}

/** 盘口情绪修正：主动买卖 + 大户多空，各贡献 ±1。 */
function sentimentBias(derivatives: GateDerivatives | null): number {
  const last = derivatives?.daily.at(-1);
  if (!last) return 0;
  return takerBias(last.takerRatio) + topLsrBias(last.topLsrAccount);
}

/** 方向性建议：多周期一致且站上/跌破 MA30 才给买卖，其余一律观望。 */
function directionAdvice(ups: number, downs: number, aboveMa30: boolean, bias: number): string {
  if (ups >= 3 && aboveMa30) {
    return bias >= 0
      ? '买入 —— 多周期一致向上且站上日线MA30，可逢回调分批建仓，跌破MA30止损'
      : '观望 —— 多周期向上但盘口偏空，等待情绪修复';
  }
  if (downs >= 3 && !aboveMa30) {
    return bias <= 0
      ? '卖出 —— 多周期一致走弱且跌破日线MA30，建议减仓，站回MA30前不宜抄底'
      : '观望 —— 多周期走弱但盘口出现承接，等待企稳信号';
  }
  if (!aboveMa30) {
    return '观望 —— 现价仍在日线MA30下方，等待站回MA30或明确企稳';
  }
  return '观望 —— 多空信号不一致，等待方向明确';
}

/**
 * 操作建议：综合四周期方向、现价与日线 MA30 的位置、盘口情绪，给出买/卖/观望三选一。
 * 原则：多周期一致且站上/跌破 MA30 才给方向性建议，其余一律观望，避免在震荡里瞎猜。
 */
export function adviceOf(
  dirs: (Dir | null)[],
  current: number,
  ma30: number | null,
  derivatives: GateDerivatives | null,
): string {
  const known = dirs.filter((d): d is Dir => d !== null);
  if (known.length === 0) return '观望 —— 数据不足，暂不操作';
  if (ma30 === null || ma30 <= 0) return '观望 —— 均线数据不足，暂不操作';

  const ups = known.filter((d) => d === 'up').length;
  const downs = known.filter((d) => d === 'down').length;
  const aboveMa30 = current >= ma30;

  return directionAdvice(ups, downs, aboveMa30, sentimentBias(derivatives));
}
