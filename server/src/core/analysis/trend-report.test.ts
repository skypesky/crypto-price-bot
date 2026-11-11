import { describe, it, expect } from 'vitest';
import { analyzeTrend, type TrendAnalysisInput } from './trend-report.js';
import { calculateMA } from '../indicators/ma.js';
import { calculateTrend } from '../indicators/trend.js';
import type { GateCandle } from '../gate/klines.js';
import type { GateDerivatives, GateDerivativesDay } from '../gate/futures.js';

/** 构造升序 K 线：最后一根是「当前周期」（进行中）。 */
function makeCandles(closes: number[], volumes?: number[], stepSeconds = 86400, startTs = 1700000000): GateCandle[] {
  return closes.map((close, i) => ({
    ts: startTs + i * stepSeconds,
    close,
    high: close * 1.01,
    low: close * 0.99,
    volume: volumes ? volumes[i]! : 100,
  }));
}

/** 生成一段每天按 ratio 变化的收盘价序列。 */
function series(start: number, days: number, ratio: number): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < days; i++) {
    out.push(p);
    p *= ratio;
  }
  return out;
}

/** 构造月线：从 startYear/startMonth 起每月一根（用于年线聚合）。 */
function monthlyCandles(closes: number[], startYear = 2022, startMonth = 0): GateCandle[] {
  return closes.map((close, i) => {
    const ts = Math.floor(Date.UTC(startYear, startMonth + i, 1) / 1000);
    return { ts, close, high: close * 1.01, low: close * 0.99, volume: 100 };
  });
}

/** 构造周线。 */
function weeklyCandles(closes: number[], startTs = Math.floor(Date.UTC(2024, 0, 1) / 1000)): GateCandle[] {
  return makeCandles(closes, undefined, 7 * 86400, startTs);
}

/** 与 buildIndicators 同口径的均线 + 趋势值。 */
function indicatorsOf(closes: number[], current: number) {
  return {
    ma7: calculateMA(closes, 7),
    ma30: calculateMA(closes, 30),
    ma90: calculateMA(closes, 90),
    trend7d: calculateTrend(current, closes[closes.length - 8]),
  };
}

interface Series {
  daily: number[];
  weekly?: number[];
  monthly?: number[];
  /** 月线起始年月（默认 2022-01） */
  startYear?: number;
  startMonth?: number;
}

function analyze(
  current: number,
  s: Series,
  derivatives: GateDerivatives | null = null,
  volumes?: number[],
) {
  const dailyCloses = s.daily;
  const daily = makeCandles(dailyCloses, volumes);
  // 周线：默认跟日线同步（同样的涨跌形态），根数取 60（但不超过日线能支撑的数量）
  const weeklyCount = s.weekly?.length ?? Math.min(60, Math.floor(dailyCloses.length / 7));
  const weeklyCloses = s.weekly ?? series(100, weeklyCount, 1);
  const weekly = weeklyCandles(weeklyCloses);
  // 月线：默认 48 根（4 年），起始 2022-01 → 覆盖 2022~2025 + 进行中的当年
  const monthlyCount = s.monthly?.length ?? Math.min(48, Math.floor(dailyCloses.length / 30));
  const monthlyCloses = s.monthly ?? series(100, monthlyCount, 1);
  const monthly = monthlyCandles(monthlyCloses, s.startYear ?? 2022, s.startMonth ?? 0);

  const input: TrendAnalysisInput = {
    current,
    candles: daily,
    weekly,
    monthly,
    indicators: indicatorsOf(dailyCloses, current),
    derivatives,
  };
  return analyzeTrend(input);
}

/** 合约日频明细的默认值。 */
function day(overrides: Partial<GateDerivativesDay> = {}): GateDerivativesDay {
  return {
    ts: 1700000000,
    lsrAccount: 2.4,
    topLsrAccount: 1.1,
    takerRatio: 1.05,
    longUsers: 2200,
    shortUsers: 1000,
    openInterestUsd: 1_000_000,
    fundingRate: 0.0001,
    longLiquidationUsd: 1_000_000,
    shortLiquidationUsd: 100_000,
    ...overrides,
  };
}

describe('analyzeTrend', () => {
  it('持续下跌：四个周期都定性为走弱，结论指向下行趋势', () => {
    const closes = series(100, 400, 0.995); // 每天 -0.5%
    const a = analyze(closes[closes.length - 1]!, { daily: closes });
    expect(a.daily).toContain('日线：');
    expect(a.daily).toContain('下跌');
    expect(a.weekly).toContain('周线：');
    expect(a.monthly).toContain('月线：');
    expect(a.yearly).toContain('年线：');
    expect(a.summary).toContain('一致走弱');
  });

  it('持续上涨：结论指向趋势健康', () => {
    const closes = series(100, 400, 1.005);
    const a = analyze(closes[closes.length - 1]!, { daily: closes });
    expect(a.daily).toContain('涨');
    expect(a.summary).toMatch(/向上|健康|偏强/);
  });

  it('横盘：定性为横盘，结论为方向未明', () => {
    const closes = new Array(400).fill(100);
    const a = analyze(100, { daily: closes });
    expect(a.daily).toContain('横盘');
    expect(a.summary).toContain('方向未明');
  });

  it('日线行给出均线位置与振幅', () => {
    const closes = series(100, 400, 0.995);
    const a = analyze(closes[closes.length - 1]!, { daily: closes });
    expect(a.daily).toContain('MA7');
    expect(a.daily).toContain('MA30');
    expect(a.daily).toContain('日均振幅');
  });

  it('连阴 K 线会被识别', () => {
    // 最后 4 根连跌（今天这根不算，从昨天往回数）
    const closes = [...new Array(396).fill(100), 100, 99, 98, 97];
    const a = analyze(97, { daily: closes });
    expect(a.daily).toContain('连阴');
  });

  it('连阳 K 线会被识别', () => {
    const closes = [...new Array(396).fill(100), 100, 101, 102, 103];
    const a = analyze(103, { daily: closes });
    expect(a.daily).toContain('连阳');
  });

  it('量能萎缩 / 放大会被识别', () => {
    const closes = series(100, 400, 0.995);
    // 近 7 个完整日缩量（最后 7 根量减半）
    const volumes = [...new Array(393).fill(100), ...new Array(7).fill(50)];
    const a = analyze(closes[closes.length - 1]!, { daily: closes }, null, volumes);
    expect(a.daily).toContain('量能萎缩');
  });

  it('周线给出 13 周高点回撤', () => {
    // 先涨到高点再回落（周线）
    const up = series(100, 30, 1.01);
    const down = series(up[up.length - 1]!, 30, 0.99);
    const daily = series(100, 400, 0.999);
    const a = analyze(down[down.length - 1]!, { daily, weekly: [...up, ...down] });
    expect(a.weekly).toContain('距13周高点回撤');
  });

  it('月线给出 12 月高点回撤', () => {
    const up = series(100, 20, 1.02);
    const down = series(up[up.length - 1]!, 20, 0.98);
    const daily = series(100, 400, 0.999);
    const a = analyze(down[down.length - 1]!, { daily, monthly: [...up, ...down] });
    expect(a.monthly).toContain('距12月高点回撤');
  });

  it('年线给出 1 年高点回撤与 3 年均线位置', () => {
    const up = series(100, 20, 1.02);
    const down = series(up[up.length - 1]!, 20, 0.98);
    const daily = series(100, 400, 0.999);
    const a = analyze(down[down.length - 1]!, { daily, monthly: [...up, ...down], startYear: 2022, startMonth: 0 });
    expect(a.yearly).toContain('年线：');
    expect(a.yearly).toContain('年均线');
  });

  it('数据不足时给出"数据不足"而不是瞎编', () => {
    const closes = [100, 101, 102];
    const a = analyze(102, { daily: closes });
    expect(a.daily).toContain('数据不足');
    expect(a.weekly).toContain('数据不足');
    expect(a.monthly).toContain('数据不足');
    expect(a.yearly).toContain('数据不足');
  });

  describe('合约情绪', () => {
    const derivatives: GateDerivatives = {
      fundingRate: 0.0001,
      fundingRateAvg: 0.0001,
      openInterestUsd: 1_000_000,
      openInterestChangePct: 12,
      longLiquidationUsd: 5_000_000,
      shortLiquidationUsd: 1_000_000,
      days: 7,
      daily: [
        day({ lsrAccount: 2.0, topLsrAccount: 0.55, takerRatio: 0.47, longUsers: 2200, shortUsers: 1000 }),
        day({ lsrAccount: 2.1, topLsrAccount: 0.56, takerRatio: 0.9, longUsers: 2100, shortUsers: 1000 }),
        day({ lsrAccount: 2.25, topLsrAccount: 0.56, takerRatio: 0.9, longUsers: 2200, shortUsers: 1000 }),
      ],
    };

    it('多空比 / 持仓 / 爆仓都会被写进情绪与资金行', () => {
      const closes = series(100, 400, 0.995);
      const a = analyze(closes[closes.length - 1]!, { daily: closes }, derivatives);
      expect(a.sentiment.join('\n')).toContain('多空 2.25');
      expect(a.sentiment.join('\n')).toContain('大户 0.56');
      expect(a.sentiment.join('\n')).toContain('主动 ');
      expect(a.sentiment.join('\n')).toContain('多空用户');
      expect(a.futures.join('\n')).toContain('费率 ');
      expect(a.futures.join('\n')).toContain('年化');
      expect(a.futures.join('\n')).toContain('持仓');
      expect(a.futures.join('\n')).toContain('多头爆仓');
    });

    it('散户偏多而大户偏空时给出解读', () => {
      const closes = series(100, 400, 0.995);
      const a = analyze(closes[closes.length - 1]!, { daily: closes }, derivatives);
      expect(a.sentiment.join('\n')).toContain('解读：');
      expect(a.sentiment.join('\n')).toContain('大户偏空');
    });

    it('资金费率为负时提示挤仓风险', () => {
      const closes = series(100, 400, 0.995);
      const a = analyze(closes[closes.length - 1]!, { daily: closes }, {
        ...derivatives,
        fundingRate: -0.0001,
      });
      expect(a.futures.join('\n')).toContain('挤仓风险');
    });

    it('空头爆仓占优时措辞反转', () => {
      const closes = series(100, 400, 0.995);
      const a = analyze(closes[closes.length - 1]!, { daily: closes }, {
        ...derivatives,
        longLiquidationUsd: 1000,
        shortLiquidationUsd: 9_000_000,
      });
      expect(a.futures.join('\n')).toContain('空头爆仓');
    });

    it('没有合约数据时情绪行与资金行为空，只给结论', () => {
      const closes = series(100, 400, 0.995);
      const a = analyze(closes[closes.length - 1]!, { daily: closes }, null);
      expect(a.sentiment).toEqual([]);
      expect(a.futures).toEqual([]);
      expect(a.summary).toContain('一致走弱');
    });
  });

  it('跌破 MA30 时结论提示"站回MA30前不宜追多"', () => {
    const closes = series(100, 400, 0.995);
    const a = analyze(closes[closes.length - 1]!, { daily: closes });
    expect(a.summary).toContain('站回日线MA30前不宜追多');
  });

  it('站上 MA30 时结论不再给出"不宜追多"提示', () => {
    const closes = series(100, 400, 1.005);
    const a = analyze(closes[closes.length - 1]!, { daily: closes });
    expect(a.summary).not.toContain('不宜追多');
  });

  describe('周期解读与操作建议', () => {
    it('每个有数据的周期都给出一句解读', () => {
      const daily = series(100, 400, 0.995);
      const weekly = series(100, 60, 0.98);
      const monthly = series(100, 48, 0.97);
      const a = analyze(daily[daily.length - 1]!, { daily, weekly, monthly });
      expect(a.insights.daily).toContain('短期');
      expect(a.insights.weekly).toContain('中期');
      expect(a.insights.monthly).toContain('长期');
      expect(a.insights.yearly).toContain('长期');
    });

    it('四周期一致上涨且站上 MA30 → 建议买入', () => {
      const daily = series(100, 400, 1.005);
      const weekly = series(100, 60, 1.02);
      const monthly = series(100, 48, 1.03);
      const a = analyze(daily[daily.length - 1]!, { daily, weekly, monthly });
      expect(a.advice).toMatch(/^买入/);
    });

    it('四周期一致下跌且跌破 MA30 → 建议卖出', () => {
      const daily = series(100, 400, 0.995);
      const weekly = series(100, 60, 0.98);
      const monthly = series(100, 48, 0.97);
      const a = analyze(daily[daily.length - 1]!, { daily, weekly, monthly });
      expect(a.advice).toMatch(/^卖出/);
    });

    it('横盘或方向分化 → 建议观望', () => {
      const closes = new Array(400).fill(100);
      const a = analyze(100, { daily: closes });
      expect(a.advice).toMatch(/^观望/);
    });

    it('数据不足时建议观望，且不编造解读', () => {
      const a = analyze(102, { daily: [100, 101, 102] });
      expect(a.advice).toMatch(/^观望/);
      expect(a.insights.daily).toBe('');
      expect(a.insights.weekly).toBe('');
      expect(a.insights.monthly).toBe('');
      expect(a.insights.yearly).toBe('');
    });
  });
});
