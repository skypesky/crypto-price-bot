import type { GateCandle } from '../gate/klines.js';
import type { GateDerivatives } from '../gate/futures.js';
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
  periodHigh,
  volumeTrend,
  type Dir,
  type TimeframeView,
} from './timeframe.js';
import { futuresLines, sentimentLines } from './sentiment.js';
import { dailyRead, monthlyRead, weeklyRead, yearlyRead } from './insights.js';
import { adviceOf, conclusion } from './conclusion.js';

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

/**
 * 合成一个周期的方向：以更近的主周期为准（30 日 / 180 日），
 * 主周期横盘时才参考更长的周期（震荡期里长期方向更有参考价值）。
 */
function combineDir(primary: Dir | null, secondary: Dir | null): Dir {
  if (primary === null) return secondary ?? 'flat';
  if (primary === 'flat' && secondary && secondary !== 'flat') return secondary;
  return primary;
}

/** 日线视图：近 7 日趋势 + MA7/MA30 + 连阳/连阴 + 均线排列。 */
function buildDailyView(
  current: number,
  candles: GateCandle[],
  ma: TrendAnalysisInput['indicators'],
): TimeframeView {
  return {
    current,
    change: ma.trend7d,
    mas: computeMAs(candles, current, [
      { period: 7, label: 'MA7' },
      { period: 30, label: 'MA30' },
    ]),
    drawdown: null,
    run: consecutiveRun(candles),
    align: maAlignment(ma.ma7, ma.ma30, ma.ma90),
  };
}

/** 周线视图：近 4 周趋势 + MA5/MA20 + 13 周回撤。 */
function buildWeeklyView(current: number, weekly: GateCandle[]): TimeframeView {
  return {
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
}

/** 月线视图：近 3 月趋势 + MA3/MA12 + 12 月回撤。 */
function buildMonthlyView(current: number, monthly: GateCandle[]): TimeframeView {
  return {
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
}

/**
 * 年线视图（由月线聚合）。
 * 年均线周期随可用年数收缩：不足 3 年就不叫"3年年均线"，避免名不副实。
 */
function buildYearlyView(
  current: number,
  monthly: GateCandle[],
): { view: TimeframeView; candles: GateCandle[] } {
  const yearlyCandles = aggregateToYearly(monthly);
  const yearlyMaPeriod = Math.min(3, Math.max(1, yearlyCandles.length - 1));
  return {
    candles: yearlyCandles,
    view: {
      current,
      change: changeOver(yearlyCandles, current, 1),
      mas: computeMAs(yearlyCandles, current, [
        { period: yearlyMaPeriod, label: `${yearlyMaPeriod}年年均线` },
      ]),
      drawdown: null,
      run: consecutiveRun(yearlyCandles),
      align: '',
    },
  };
}

/** 各周期视图 + 各自的数据是否够用。 */
interface PeriodViews {
  daily: TimeframeView;
  weekly: TimeframeView;
  monthly: TimeframeView;
  yearly: TimeframeView;
  yearlyCandles: GateCandle[];
  ok: { daily: boolean; weekly: boolean; monthly: boolean; yearly: boolean };
}

/** 构造四个周期的视图，并按各周期所需的最少根数判定数据是否够用。 */
function buildPeriodViews(
  current: number,
  candles: GateCandle[],
  weekly: GateCandle[],
  monthly: GateCandle[],
  ma: TrendAnalysisInput['indicators'],
): PeriodViews {
  const yearly = buildYearlyView(current, monthly);
  return {
    daily: buildDailyView(current, candles, ma),
    weekly: buildWeeklyView(current, weekly),
    monthly: buildMonthlyView(current, monthly),
    yearly: yearly.view,
    yearlyCandles: yearly.candles,
    ok: {
      daily: candles.length >= 30,
      weekly: weekly.length >= 5,
      monthly: monthly.length >= 4,
      yearly: yearly.candles.length >= 2,
    },
  };
}

/** 各周期方向（null = 该周期数据不足）。 */
function buildDirs(
  current: number,
  weekly: GateCandle[],
  monthly: GateCandle[],
  yearlyCandles: GateCandle[],
  ok: PeriodViews['ok'],
  trend7d: number | null,
): (Dir | null)[] {
  const dirOf = (v: number | null): Dir | null => (v === null ? null : grade(v).dir);
  return [
    ok.daily ? dirOf(trend7d) : null,
    ok.weekly ? dirOf(changeOver(weekly, current, 4)) : null,
    ok.monthly
      ? combineDir(dirOf(changeOver(monthly, current, 3)), dirOf(changeOver(monthly, current, 12)))
      : null,
    ok.yearly
      ? combineDir(dirOf(changeOver(yearlyCandles, current, 1)), dirOf(changeOver(yearlyCandles, current, 3)))
      : null,
  ];
}

/** 各周期的一句话描述（数据不足时给出固定提示）。 */
function periodTexts(
  views: PeriodViews,
  candles: GateCandle[],
  monthly: GateCandle[],
): { daily: string; weekly: string; monthly: string; yearly: string } {
  return {
    daily: views.ok.daily ? describeDaily(views.daily, volumeTrend(candles), avgAmplitude(candles)) : '日线：数据不足',
    weekly: views.ok.weekly ? describeWeekly(views.weekly) : '周线：数据不足',
    monthly: views.ok.monthly ? describeMonthly(views.monthly) : '月线：数据不足',
    yearly: views.ok.yearly ? describeYearly(views.yearly, monthly) : '年线：数据不足',
  };
}

/** 各周期的一句话解读（数据不足时为空串）。 */
function periodInsights(
  views: PeriodViews,
  monthly: GateCandle[],
): TrendAnalysis['insights'] {
  return {
    daily: views.ok.daily ? dailyRead(views.daily) : '',
    weekly: views.ok.weekly ? weeklyRead(views.weekly) : '',
    monthly: views.ok.monthly ? monthlyRead(views.monthly) : '',
    yearly: views.ok.yearly ? yearlyRead(views.yearly, monthly) : '',
  };
}

/**
 * 生成趋势研判：日线 / 周线 / 月线 / 年线 + 合约情绪与综合结论。
 * 纯函数，不做 IO，方便单测。
 */
export function analyzeTrend(input: TrendAnalysisInput): TrendAnalysis {
  const { current, candles, weekly, monthly, indicators, derivatives } = input;

  const views = buildPeriodViews(current, candles, weekly, monthly, indicators);
  const dirs = buildDirs(current, weekly, monthly, views.yearlyCandles, views.ok, indicators.trend7d);
  const texts = periodTexts(views, candles, monthly);

  return {
    daily: texts.daily,
    weekly: texts.weekly,
    monthly: texts.monthly,
    yearly: texts.yearly,
    insights: periodInsights(views, monthly),
    sentiment: derivatives ? sentimentLines(derivatives) : [],
    futures: derivatives ? futuresLines(derivatives) : [],
    summary: conclusion(dirs, current, indicators.ma30),
    advice: adviceOf(dirs, current, indicators.ma30, derivatives),
  };
}
