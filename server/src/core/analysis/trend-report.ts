import type { GateCandle } from '../gate/klines.js';
import type { GateDerivatives, GateDerivativesDay } from '../gate/futures.js';
import {
  aggregateToYearly,
  avgAmplitude,
  changeOver,
  computeMAs,
  consecutiveRun,
  describeDaily,
  describeMonthly,
  describeWeekly,
  describeYearly,
  drawdown,
  grade,
  maAlignment,
  pct,
  pctAbs,
  periodHigh,
  volumeTrend,
  type Dir,
  type TimeframeView,
} from './timeframe.js';

/** 分析所需的输入（全部来自本地已抓取的数据 + 一次合约统计请求）。 */
export interface TrendAnalysisInput {
  /** 当前价（实时 ticker） */
  current: number;
  /** 日线（升序，最后一根是今天 —— 日内进行中） */
  candles: GateCandle[];
  /** 周线（7d 区间，升序，最后一根是本周 —— 进行中） */
  weekly: GateCandle[];
  /** 月线（30d 区间，升序，最后一根是本月 —— 进行中） */
  monthly: GateCandle[];
  /**
   * 日线口径的均线与涨跌幅（只列研判真正用到的字段）。
   * 直接复用 buildIndicators 的结果 —— 研判里的数字与报告里的趋势行天然同源同口径，
   * 数据不够时这些值本身就是 null（不用在这里重新推导）。
   */
  indicators: {
    ma7: number | null; ma30: number | null; ma90: number | null;
    trend7d: number | null;
  };
  /** 合约情绪数据；没有永续合约 / 拉取失败时为 null */
  derivatives: GateDerivatives | null;
}

/** 分析结论（每个字段是一句可直接展示的中文）。 */
export interface TrendAnalysis {
  /** 日线：近几天 */
  daily: string;
  /** 周线：近几周 ~ 几个月 */
  weekly: string;
  /** 月线：近几个月 ~ 一年 */
  monthly: string;
  /** 年线：半年 ~ 几年 */
  yearly: string;
  /** 各周期的一句话解读，与 daily/weekly/monthly/yearly 一一对应（数据不足时为空串） */
  insights: {
    daily: string;
    weekly: string;
    monthly: string;
    yearly: string;
  };
  /** 合约情绪：多空比等关键指标，每个指标一行 */
  sentiment: string[];
  /** 合约资金：资金费率 / 持仓 / 爆仓，每个一行 */
  futures: string[];
  /** 综合结论 */
  summary: string;
  /** 操作建议：买入 / 卖出 / 观望 + 一句理由 */
  advice: string;
}

/** 资金费率年化（Gate 每 8 小时结算一次 → 每天 3 次 → 365 天）。 */
function annualizedFunding(rate: number): number {
  return rate * 3 * 365 * 100;
}

/** 资金费率显示：值很小时用更多小数位，避免出现 "-0.00%" 这种读不出大小的写法。 */
function formatFundingRate(rate: number): string {
  const p = rate * 100;
  return Math.abs(p) < 0.01 ? p.toFixed(4) : p.toFixed(3);
}

/** 合约资金面描述（资金费率 / 持仓 / 爆仓）—— 多空比归到「日线情绪」行。 */
function futuresLines(d: GateDerivatives): string[] {
  const lines: string[] = [];

  if (d.fundingRate !== null) {
    const ann = annualizedFunding(d.fundingRate);
    let tag = '中性';
    if (ann > 30) tag = '多头成本偏高';
    else if (ann < -3) tag = '空头成本为负(挤仓风险)';
    else if (ann > 10) tag = '多头付费意愿尚可';
    lines.push(`资金费率 ${formatFundingRate(d.fundingRate)}%/8h(年化${ann.toFixed(1)}%,${tag})`);
  }

  if (d.openInterestChangePct !== null) {
    const v = d.openInterestChangePct;
    const tag = v > 5 ? '杠杆资金快速进场' : v < -5 ? '资金明显撤离' : '资金平稳';
    lines.push(`持仓 ${pct(v)}(${tag})`);
  }

  const liqTotal = d.longLiquidationUsd + d.shortLiquidationUsd;
  if (liqTotal > 0) {
    const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`);
    if (d.longLiquidationUsd > d.shortLiquidationUsd * 1.2) {
      lines.push(`近${d.days}日多头爆仓 ${usd(d.longLiquidationUsd)} 占优(多头被清洗)`);
    } else if (d.shortLiquidationUsd > d.longLiquidationUsd * 1.2) {
      lines.push(`近${d.days}日空头爆仓 ${usd(d.shortLiquidationUsd)} 占优(空头被清洗)`);
    } else {
      lines.push(`近${d.days}日多空爆仓相当`);
    }
  }

  return lines;
}

/** 一组数值的平均值（忽略 null）。 */
function avgOf(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** 多空比定性：>2 多头占优，<1 空头占优，其余均衡。 */
function lsrTag(r: number): string {
  if (r > 2) return '多头占优';
  if (r < 1) return '空头占优';
  return '多空均衡';
}

/** 大户多空比定性（阈值比账户多空比更严，因为大户样本少、波动大）。 */
function topLsrTag(r: number): string {
  if (r > 1.2) return '多头占优';
  if (r < 0.8) return '空头占优';
  return '多空均衡';
}

/** 主动成交买卖比定性：>1 主动买盘占优。 */
function takerTag(r: number): string {
  if (r > 1.05) return '买盘主导';
  if (r < 0.95) return '卖盘主导';
  return '基本均衡';
}

/**
 * 日线情绪解读：把多空比组合翻译成一句人话。
 * 关键是看「散户（账户多空比）」和「大户」是否背离，以及主动成交方向。
 */
function sentimentRead(last: GateDerivativesDay): string {
  const bits: string[] = [];
  const acct = last.lsrAccount;
  const top = last.topLsrAccount;
  const taker = last.takerRatio !== null && last.takerRatio > 0 ? last.takerRatio : null;

  if (acct !== null && top !== null) {
    if (acct >= 1.5 && top < 1) bits.push('散户偏多而大户偏空，筹码分歧');
    else if (acct >= 1.5 && top >= 1.5) bits.push('大小资金一致偏多，情绪乐观');
    else if (acct <= 1 && top <= 1) bits.push('大小资金一致偏空，趋势受压');
    else if (acct <= 1 && top >= 1.2) bits.push('大户逆势偏多，存在承接');
    else bits.push('多空分歧，方向未明');
  }

  if (taker !== null) {
    if (taker < 0.95) bits.push('主动卖盘主导，短线抛压明显');
    else if (taker > 1.05) bits.push('主动买盘主导，买盘承接积极');
    else bits.push('主动买卖基本均衡');
  }

  if (acct !== null && acct >= 2) bits.push('多头拥挤，破位易触发连环清算');

  return bits.join('，');
}

/** 日线情绪：最近完整交易日的多空比全景 + 7 日均值 + 解读，每个指标独占一行。 */
function sentimentLines(d: GateDerivatives): string[] {
  const days = d.daily;
  if (days.length === 0) return [];
  const last = days[days.length - 1]!;
  const lines: string[] = [];

  if (last.lsrAccount !== null) {
    const avg = avgOf(days.map((x) => x.lsrAccount));
    const arrow = avg === null ? '' : last.lsrAccount > avg * 1.03 ? '↑' : last.lsrAccount < avg * 0.97 ? '↓' : '→';
    lines.push(
      `账户多空比 ${last.lsrAccount.toFixed(2)}(${lsrTag(last.lsrAccount)}${avg !== null ? `，${days.length}日均 ${avg.toFixed(2)}${arrow}` : ''})`,
    );
  }

  if (last.topLsrAccount !== null) {
    lines.push(`大户账户多空比 ${last.topLsrAccount.toFixed(2)}(${topLsrTag(last.topLsrAccount)})`);
  }

  if (last.takerRatio !== null && last.takerRatio > 0) {
    // lsr_taker 为 0 表示当期几乎没有主动买盘成交（流动性极差），不是"卖盘主导" → 不展示
    lines.push(`主动买卖比 ${last.takerRatio.toFixed(2)}(${takerTag(last.takerRatio)})`);
  }

  if (last.longUsers !== null && last.shortUsers !== null && last.shortUsers > 0) {
    lines.push(`多空用户 ${(last.longUsers / last.shortUsers).toFixed(2)}:1`);
  }

  const read = sentimentRead(last);
  if (read) lines.push(`解读：${read}`);

  return lines;
}

/**
 * 合成一个周期的方向：以更近的主周期为准（30 日 / 180 日），
 * 主周期横盘时才参考更长的周期（震荡期里长期方向更有参考价值）。
 */
function combineDir(primary: Dir | null, secondary: Dir | null): Dir {
  if (primary === null) return secondary ?? 'flat';
  if (primary === 'flat' && secondary && secondary !== 'flat') return secondary;
  return primary;
}

/**
 * 四个周期的方向合成一句结论。
 * dirs 里 null = 该周期无数据（拉取失败 / 数据量不足）—— 绝不能当成"横盘"参与方向计数，
 * 否则报告会出现"月线数据不足"却断言"月线持续走弱"的自相矛盾。
 */
function conclusion(dirs: (Dir | null)[], current: number, ma30: number | null): string {
  const labels = ['日线', '周线', '月线', '年线'];
  const missing = labels.filter((_, i) => dirs[i] === null);
  const known = dirs.filter((d): d is Dir => d !== null);
  const ups = known.filter((d) => d === 'up').length;
  const downs = known.filter((d) => d === 'down').length;

  let text: string;
  if (known.length === 0) {
    text = '数据不足，暂无法研判';
  } else if (missing.length > 0) {
    // 只用"确实算出来了"的周期下判断，并把缺失的周期明说出来
    const knownText = known.length === ups
      ? '已知周期一致向上'
      : known.length === downs
        ? '已知周期一致走弱'
        : '已知周期方向分化';
    text = `${missing.join('/')}数据不足，${knownText}`;
  } else if (ups === known.length) {
    text = '日周月年四周期一致向上，趋势健康';
  } else if (downs === known.length) {
    text = '日周月年四周期一致走弱，下行趋势延续';
  } else if (ups > downs) {
    // 与多数方向不同的周期单独点名（横盘和回调用不同措辞）
    const oddIdx = dirs.map((d, i) => (d === 'up' ? -1 : i)).filter((i) => i >= 0);
    const oddLabels = oddIdx.map((i) => labels[i]!);
    const allFlat = oddIdx.every((i) => dirs[i] === 'flat');
    text = allFlat
      ? `${oddLabels.join('/')}横盘整理，其余周期上行趋势未改`
      : `${oddLabels.join('/')}回调，其余周期上行趋势未改`;
  } else if (downs > ups) {
    const oddIdx = dirs.map((d, i) => (d === 'down' ? -1 : i)).filter((i) => i >= 0);
    const oddLabels = oddIdx.map((i) => labels[i]!);
    const allFlat = oddIdx.every((i) => dirs[i] === 'flat');
    text = allFlat
      ? `${oddLabels.join('/')}横盘，其余周期持续走弱`
      : `${oddLabels.join('/')}逆势偏强，其余周期仍偏弱，趋势待观察`;
  } else {
    text = ups === 0 ? '各周期横盘，方向未明' : '周期方向分化，趋势待观察';
  }

  // 关键位提示：现价相对日线 MA30 的位置
  if (ma30 !== null && ma30 > 0) {
    const off = ((current - ma30) / ma30) * 100;
    if (off < 0 && dirs[0] !== null && dirs[0] !== 'up') text += '，站回日线MA30前不宜追多';
    else if (off > 0 && dirs[0] === 'down') text += '，但已站上日线MA30，注意回踩确认';
  }
  return text;
}

/** 均线偏离 → 是否站上（null = 数据缺失）。 */
function aboveMa(offset: number | null | undefined): boolean | null {
  return offset === null || offset === undefined ? null : offset >= 0;
}

/** 从 view 里取方向（无涨跌幅时按横盘处理）。 */
function viewDir(view: TimeframeView): Dir {
  return view.change === null ? 'flat' : grade(view.change).dir;
}

/** 日线解读：方向 + MA7/MA30 位置 + 均线排列。 */
function dailyRead(view: TimeframeView): string {
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
function weeklyRead(view: TimeframeView): string {
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
function monthlyRead(view: TimeframeView): string {
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
function yearlyRead(view: TimeframeView, monthly: GateCandle[]): string {
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

/**
 * 操作建议：综合四周期方向、现价与日线 MA30 的位置、盘口情绪，给出买/卖/观望三选一。
 * 原则：多周期一致且站上/跌破 MA30 才给方向性建议，其余一律观望，避免在震荡里瞎猜。
 */
function adviceOf(
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

  // 盘口情绪修正：主动买卖 + 大户多空，各贡献 ±1
  let bias = 0;
  const last = derivatives?.daily.at(-1);
  if (last) {
    if (last.takerRatio !== null && last.takerRatio > 0) {
      if (last.takerRatio < 0.95) bias--;
      else if (last.takerRatio > 1.05) bias++;
    }
    if (last.topLsrAccount !== null) {
      if (last.topLsrAccount < 0.8) bias--;
      else if (last.topLsrAccount > 1.2) bias++;
    }
  }

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
 * 生成趋势研判：日线 / 周线 / 月线 / 年线 + 合约情绪与综合结论。
 * 纯函数，不做 IO，方便单测。
 */
export function analyzeTrend(input: TrendAnalysisInput): TrendAnalysis {
  const { current, candles, weekly, monthly, indicators, derivatives } = input;
  const ma = indicators;

  // ---- 日线 ----
  const dailyView: TimeframeView = {
    current,
    change: indicators.trend7d,
    mas: computeMAs(candles, current, [
      { period: 7, label: 'MA7' },
      { period: 30, label: 'MA30' },
    ]),
    drawdown: null,
    run: consecutiveRun(candles),
    align: maAlignment(ma.ma7, ma.ma30, ma.ma90),
  };
  const dailyOk = candles.length >= 30;
  const daily = dailyOk
    ? describeDaily(dailyView, volumeTrend(candles), avgAmplitude(candles))
    : '日线：数据不足';

  // ---- 周线 ----
  const weeklyView: TimeframeView = {
    current,
    change: changeOver(weekly, current, 4),
    mas: computeMAs(weekly, current, [
      { period: 5, label: 'MA5' },
      { period: 20, label: 'MA20' },
    ]),
    drawdown: drawdown(current, periodHigh(weekly, 13)),
    run: consecutiveRun(weekly),
    align: '',
  };
  const weeklyOk = weekly.length >= 5;
  const weeklyText = weeklyOk ? describeWeekly(weeklyView) : '周线：数据不足';

  // ---- 月线 ----
  const monthlyView: TimeframeView = {
    current,
    change: changeOver(monthly, current, 3),
    mas: computeMAs(monthly, current, [
      { period: 3, label: 'MA3' },
      { period: 12, label: 'MA12' },
    ]),
    drawdown: drawdown(current, periodHigh(monthly, 12)),
    run: consecutiveRun(monthly),
    align: '',
  };
  const monthlyOk = monthly.length >= 4;
  const monthlyText = monthlyOk ? describeMonthly(monthlyView) : '月线：数据不足';

  // ---- 年线（由月线聚合）----
  // 年均线周期随可用年数收缩：不足 3 年就不叫"3年年均线"，避免名不副实。
  const yearlyCandles = aggregateToYearly(monthly);
  const yearlyMaPeriod = Math.min(3, Math.max(1, yearlyCandles.length - 1));
  const yearlyView: TimeframeView = {
    current,
    change: changeOver(yearlyCandles, current, 1),
    mas: computeMAs(yearlyCandles, current, [
      { period: yearlyMaPeriod, label: `${yearlyMaPeriod}年年均线` },
    ]),
    drawdown: null,
    run: consecutiveRun(yearlyCandles),
    align: '',
  };
  const yearlyOk = yearlyCandles.length >= 2;
  const yearlyText = yearlyOk ? describeYearly(yearlyView, monthly) : '年线：数据不足';

  // ---- 情绪 + 结论 ----
  const sentiment = derivatives ? sentimentLines(derivatives) : [];
  const futures = derivatives ? futuresLines(derivatives) : [];

  const dirOf = (v: number | null): Dir | null => (v === null ? null : grade(v).dir);
  const dirs: (Dir | null)[] = [
    dailyOk ? dirOf(indicators.trend7d) : null,
    weeklyOk ? dirOf(changeOver(weekly, current, 4)) : null,
    monthlyOk
      ? combineDir(dirOf(changeOver(monthly, current, 3)), dirOf(changeOver(monthly, current, 12)))
      : null,
    yearlyOk
      ? combineDir(dirOf(changeOver(yearlyCandles, current, 1)), dirOf(changeOver(yearlyCandles, current, 3)))
      : null,
  ];
  const concl = conclusion(dirs, current, ma.ma30);

  return {
    daily,
    weekly: weeklyText,
    monthly: monthlyText,
    yearly: yearlyText,
    insights: {
      daily: dailyOk ? dailyRead(dailyView) : '',
      weekly: weeklyOk ? weeklyRead(weeklyView) : '',
      monthly: monthlyOk ? monthlyRead(monthlyView) : '',
      yearly: yearlyOk ? yearlyRead(yearlyView, monthly) : '',
    },
    sentiment,
    futures,
    summary: concl,
    advice: adviceOf(dirs, current, ma.ma30, derivatives),
  };
}
