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

/** 构造月线：逐根指定收盘价与最高价（起始年月默认 2022-01）。 */
function monthlyWith(closes: number[], highs: number[], startYear = 2022, startMonth = 0): GateCandle[] {
  return closes.map((close, i) => ({
    ts: Math.floor(Date.UTC(startYear, startMonth + i, 1) / 1000),
    close,
    high: highs[i]!,
    low: close * 0.99,
    volume: 100,
  }));
}

/**
 * 构造趋势分析输入：三个周期的数据与均线 / 趋势值全部由调用方控制，
 * 便于精确命中某一条判断分支。
 */
function buildInput(o: {
  current: number;
  daily?: number[];
  weekly?: number[];
  monthly?: GateCandle[];
  indicators?: Partial<TrendAnalysisInput['indicators']>;
  derivatives?: GateDerivatives | null;
}): TrendAnalysisInput {
  const daily = o.daily ?? new Array(400).fill(100);
  const weekly = o.weekly ?? new Array(60).fill(100);
  const monthly = o.monthly ?? monthlyCandles(new Array(48).fill(100), 2022, 0);
  return {
    current: o.current,
    candles: makeCandles(daily),
    weekly: weeklyCandles(weekly),
    monthly,
    indicators: {
      ma7: 100,
      ma30: 100,
      ma90: 100,
      trend7d: 0,
      ...o.indicators,
    },
    derivatives: o.derivatives ?? null,
  };
}

/** 构造月线：让 3 个月 / 12 个月变化都为 0（月线方向恒为横盘）。 */
function flatMonthly(current: number): GateCandle[] {
  const closes = new Array(48).fill(100);
  closes[11] = current;
  closes[35] = current;
  closes[44] = current;
  return monthlyCandles(closes, 2022, 0);
}

/** 只有一天数据的合约情绪（用于精确控制盘口偏向）。 */
function oneDay(overrides: Partial<GateDerivativesDay> = {}): GateDerivatives {
  return {
    fundingRate: 0.0001,
    fundingRateAvg: 0.0001,
    openInterestUsd: 1_000_000,
    openInterestChangePct: 0,
    longLiquidationUsd: 0,
    shortLiquidationUsd: 0,
    days: 7,
    daily: [day({ longLiquidationUsd: 0, shortLiquidationUsd: 0, ...overrides })],
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
      expect(a.sentiment.join('\n')).toContain('多空：2.25');
      expect(a.sentiment.join('\n')).toContain('大户：0.56');
      expect(a.sentiment.join('\n')).toContain('主动：');
      expect(a.sentiment.join('\n')).toContain('多空用户：');
      expect(a.futures.join('\n')).toContain('费率：');
      expect(a.futures.join('\n')).toContain('年化');
      expect(a.futures.join('\n')).toContain('持仓：');
      expect(a.futures.join('\n')).toContain('多头爆仓：');
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

  describe('合约情绪多空比定性', () => {
    const sentimentOf = (overrides: Partial<GateDerivativesDay>) =>
      analyzeTrend(buildInput({ current: 100, derivatives: oneDay(overrides) })).sentiment.join('\n');

    it('账户多空比大于 2 判定为「多头占优」', () => {
      expect(sentimentOf({ lsrAccount: 2.5 })).toContain('多空：2.50(多头占优');
    });

    it('账户多空比小于 1 判定为「空头占优」', () => {
      expect(sentimentOf({ lsrAccount: 0.8 })).toContain('多空：0.80(空头占优');
    });

    it('账户多空比在 1~2 之间判定为「多空均衡」', () => {
      expect(sentimentOf({ lsrAccount: 1.5 })).toContain('多空：1.50(多空均衡');
    });

    it('账户多空比缺失时不输出多空行', () => {
      expect(sentimentOf({ lsrAccount: null })).not.toContain('多空：');
    });

    it('大户多空比大于 1.2 判定为「多头占优」', () => {
      expect(sentimentOf({ topLsrAccount: 1.3 })).toContain('大户：1.30(多头占优');
    });

    it('大户多空比小于 0.8 判定为「空头占优」', () => {
      expect(sentimentOf({ topLsrAccount: 0.7 })).toContain('大户：0.70(空头占优');
    });

    it('大户多空比在 0.8~1.2 之间判定为「多空均衡」', () => {
      expect(sentimentOf({ topLsrAccount: 1.0 })).toContain('大户：1.00(多空均衡');
    });

    it('大户多空比缺失时不输出大户行', () => {
      expect(sentimentOf({ topLsrAccount: null })).not.toContain('大户：');
    });

    it('主动买卖比大于 1.05 判定为「买盘主导」', () => {
      expect(sentimentOf({ takerRatio: 1.1 })).toContain('主动：1.10(买盘主导');
    });

    it('主动买卖比小于 0.95 判定为「卖盘主导」', () => {
      expect(sentimentOf({ takerRatio: 0.9 })).toContain('主动：0.90(卖盘主导');
    });

    it('主动买卖比在 0.95~1.05 之间判定为「基本均衡」', () => {
      expect(sentimentOf({ takerRatio: 1.0 })).toContain('主动：1.00(基本均衡');
    });

    it('主动买卖比为 0（几乎没有买盘）时不展示主动行', () => {
      expect(sentimentOf({ takerRatio: 0 })).not.toContain('主动：');
    });

    it('多空用户数给出比例', () => {
      expect(sentimentOf({ longUsers: 2200, shortUsers: 1000 })).toContain('多空用户：2.20:1');
    });

    it('空头用户数为 0 时不输出多空用户行', () => {
      expect(sentimentOf({ longUsers: 2200, shortUsers: 0 })).not.toContain('多空用户');
    });
  });

  describe('合约情绪解读', () => {
    const readOf = (overrides: Partial<GateDerivativesDay>) =>
      analyzeTrend(buildInput({ current: 100, derivatives: oneDay(overrides) })).sentiment.join('\n');

    it('散户与大户一致偏多时给出乐观解读', () => {
      expect(readOf({ lsrAccount: 1.6, topLsrAccount: 1.6 })).toContain('大小资金一致偏多');
    });

    it('散户与大户一致偏空时给出受压解读', () => {
      expect(readOf({ lsrAccount: 0.9, topLsrAccount: 0.9 })).toContain('大小资金一致偏空');
    });

    it('散户偏空而大户偏多时指出存在承接', () => {
      expect(readOf({ lsrAccount: 0.9, topLsrAccount: 1.3 })).toContain('大户逆势偏多');
    });

    it('多空比既不极端也不背离时给出分歧解读', () => {
      expect(readOf({ lsrAccount: 1.2, topLsrAccount: 1.0 })).toContain('多空分歧，方向未明');
    });

    it('主动卖盘主导时指出短线抛压', () => {
      expect(readOf({ takerRatio: 0.9 })).toContain('主动卖盘主导');
    });

    it('主动买盘主导时指出买盘承接', () => {
      expect(readOf({ takerRatio: 1.1 })).toContain('主动买盘主导');
    });

    it('主动买卖均衡时给出均衡解读', () => {
      expect(readOf({ takerRatio: 1.0 })).toContain('主动买卖基本均衡');
    });

    it('账户多空比达到 2 时提示多头拥挤', () => {
      expect(readOf({ lsrAccount: 2.5 })).toContain('多头拥挤');
    });
  });

  describe('合约情绪均值与箭头', () => {
    /** 构造多日情绪：最后一天的值决定箭头方向。 */
    const days = (values: number[]) => ({
      fundingRate: 0.0001,
      fundingRateAvg: 0.0001,
      openInterestUsd: 1_000_000,
      openInterestChangePct: 0,
      longLiquidationUsd: 0,
      shortLiquidationUsd: 0,
      days: 7,
      daily: values.map((v, i) => day({ lsrAccount: v, ts: 1700000000 + i * 86400 })),
    });

    it('最新值高于均值 3% 时向上箭头', () => {
      const a = analyzeTrend(
        buildInput({ current: 100, derivatives: days([2.0, 2.1, 2.25]) }),
      );
      expect(a.sentiment.join('\n')).toContain('↑');
    });

    it('最新值低于均值 3% 时向下箭头', () => {
      const a = analyzeTrend(
        buildInput({ current: 100, derivatives: days([2.0, 2.1, 1.5]) }),
      );
      expect(a.sentiment.join('\n')).toContain('↓');
    });

    it('最新值与均值接近时为平箭头', () => {
      const a = analyzeTrend(
        buildInput({ current: 100, derivatives: days([2.0, 2.0, 2.0]) }),
      );
      expect(a.sentiment.join('\n')).toContain('→');
    });

    it('所有多空比都无效时算不出均值，不展示均值行', () => {
      const a = analyzeTrend(
        buildInput({
          current: 100,
          derivatives: {
            ...oneDay(),
            daily: [day({ lsrAccount: Number.NaN })],
          },
        }),
      );
      expect(a.sentiment.join('\n')).toContain('多空：NaN');
      expect(a.sentiment.join('\n')).not.toContain('日均');
    });

    it('没有日频数据时情绪行为空', () => {
      const a = analyzeTrend(
        buildInput({
          current: 100,
          derivatives: { ...oneDay(), daily: [] },
        }),
      );
      expect(a.sentiment).toEqual([]);
    });
  });

  describe('合约资金面', () => {
    const futuresOf = (over: Partial<GateDerivatives>) =>
      analyzeTrend(buildInput({ current: 100, derivatives: { ...oneDay(), ...over } })).futures.join('\n');

    it('资金费率年化超过 30% 时提示多头成本偏高', () => {
      expect(futuresOf({ fundingRate: 0.001 })).toContain('多头成本偏高');
    });

    it('资金费率年化为负时提示挤仓风险', () => {
      expect(futuresOf({ fundingRate: -0.0001 })).toContain('空头成本为负(挤仓风险)');
    });

    it('资金费率很小时保留更多小数位', () => {
      expect(futuresOf({ fundingRate: 0.00005 })).toContain('0.0050%');
    });

    it('持仓变化超过 5% 时提示杠杆资金进场', () => {
      expect(futuresOf({ openInterestChangePct: 20 })).toContain('杠杆资金快速进场');
    });

    it('持仓下降超过 5% 时提示资金撤离', () => {
      expect(futuresOf({ openInterestChangePct: -20 })).toContain('资金明显撤离');
    });

    it('持仓变化不大时提示资金平稳', () => {
      expect(futuresOf({ openInterestChangePct: 1 })).toContain('资金平稳');
    });

    it('多空爆仓金额相近时给出「多空爆仓相当」', () => {
      expect(
        futuresOf({ longLiquidationUsd: 1_000_000, shortLiquidationUsd: 900_000 }),
      ).toContain('多空爆仓相当');
    });

    it('爆仓金额不足百万时用 K 为单位', () => {
      expect(
        futuresOf({ longLiquidationUsd: 500_000, shortLiquidationUsd: 100_000 }),
      ).toContain('$500K');
    });

    it('没有爆仓数据时不输出爆仓行', () => {
      const text = futuresOf({ longLiquidationUsd: 0, shortLiquidationUsd: 0 });
      expect(text).not.toContain('爆仓');
    });
  });

  describe('综合结论：周期缺失', () => {
    it('已知周期一致向上时明确说明', () => {
      const a = analyzeTrend(
        buildInput({
          current: 110,
          weekly: [100, 100, 100, 100],
          indicators: { trend7d: 5 },
        }),
      );
      expect(a.summary).toContain('周线数据不足');
      expect(a.summary).toContain('已知周期一致向上');
    });

    it('已知周期一致走弱时明确说明', () => {
      const a = analyzeTrend(
        buildInput({
          current: 90,
          weekly: [100, 100, 100, 100],
          indicators: { trend7d: -5 },
        }),
      );
      expect(a.summary).toContain('周线数据不足');
      expect(a.summary).toContain('已知周期一致走弱');
    });

    it('已知周期方向分化时明确说明', () => {
      const a = analyzeTrend(
        buildInput({
          current: 90,
          weekly: [100, 100, 100, 100],
          indicators: { trend7d: 5 },
        }),
      );
      expect(a.summary).toContain('已知周期方向分化');
    });
  });

  describe('综合结论：方向分化', () => {
    it('多数周期向上、个别横盘时提示横盘整理', () => {
      // 月线 3 个月变化 ≈ 0、12 个月变化很大 → 月线取「更长的周期」方向
      const monthlyCloses = [...new Array(9).fill(100), 100, 50, ...new Array(33).fill(100)];
      const a = analyzeTrend(
        buildInput({
          current: 100.5,
          monthly: monthlyCandles(monthlyCloses, 2022, 0),
          indicators: { trend7d: 5 },
        }),
      );
      expect(a.summary).toContain('横盘整理，其余周期上行趋势未改');
    });

    it('多数周期向上、个别回调时点名回调周期', () => {
      // 2024 年最后收盘 200 > 现价 → 年线走弱
      const closes = new Array(48).fill(100);
      closes[35] = 200;
      closes[44] = 50;
      const a = analyzeTrend(
        buildInput({
          current: 110,
          monthly: monthlyCandles(closes, 2022, 0),
          indicators: { trend7d: 5 },
        }),
      );
      expect(a.summary).toContain('回调，其余周期上行趋势未改');
    });

    it('多数周期走弱、个别横盘时提示横盘', () => {
      const closes = new Array(48).fill(100);
      closes[35] = 90;
      closes[44] = 90;
      const a = analyzeTrend(
        buildInput({
          current: 90,
          monthly: monthlyCandles(closes, 2022, 0),
          indicators: { trend7d: -5 },
        }),
      );
      expect(a.summary).toContain('横盘，其余周期持续走弱');
    });

    it('多数周期走弱、个别逆势偏强时点名该周期', () => {
      const closes = new Array(48).fill(100);
      closes[11] = 120;
      closes[35] = 50;
      const a = analyzeTrend(
        buildInput({
          current: 90,
          monthly: monthlyCandles(closes, 2022, 0),
          indicators: { trend7d: -5 },
        }),
      );
      expect(a.summary).toContain('逆势偏强，其余周期仍偏弱');
    });

    it('涨跌周期数量相当时给出方向分化', () => {
      const a = analyzeTrend(
        buildInput({
          current: 110,
          weekly: new Array(60).fill(150),
          monthly: flatMonthly(110),
          indicators: { trend7d: 5 },
        }),
      );
      expect(a.summary).toContain('周期方向分化，趋势待观察');
    });

    it('站上日线 MA30 但日线走弱时提示回踩确认', () => {
      const a = analyzeTrend(
        buildInput({
          current: 90,
          indicators: { trend7d: -5, ma30: 50 },
        }),
      );
      expect(a.summary).toContain('但已站上日线MA30');
    });
  });

  describe('周期解读：日线', () => {
    it('跌破 MA7 与 MA30 时判定为空头占优', () => {
      const daily = series(100, 400, 0.995);
      const a = analyzeTrend(
        buildInput({
          current: daily[daily.length - 1]!,
          daily,
          indicators: { trend7d: -5 },
        }),
      );
      expect(a.insights.daily).toContain('短期空头占优');
    });

    it('收复 MA7 但仍在 MA30 下方时提示中期压力', () => {
      const daily = [...new Array(370).fill(200), 100, 100, 100, 100, 100, 100, 110];
      const a = analyzeTrend(buildInput({ current: 110, daily, indicators: { trend7d: -5 } }));
      expect(a.insights.daily).toContain('仍在 MA30 下方');
    });

    it('站上 MA30 但方向仍偏弱时提示反弹力度不足', () => {
      const daily = [...new Array(370).fill(200), 100, 100, 100, 100, 100, 100, 210];
      const a = analyzeTrend(buildInput({ current: 210, daily, indicators: { trend7d: -5 } }));
      expect(a.insights.daily).toContain('短期偏弱');
    });

    it('均线多头排列且站上均线时给出续涨解读', () => {
      const daily = [...new Array(370).fill(100), 110, 110, 110, 110, 110, 110, 120];
      const a = analyzeTrend(
        buildInput({
          current: 120,
          daily,
          indicators: { trend7d: 5, ma7: 110, ma30: 100, ma90: 90 },
        }),
      );
      expect(a.insights.daily).toContain('均线多头排列');
    });

    it('站上均线但不是多头排列时给出支撑解读', () => {
      const daily = [...new Array(370).fill(100), 110, 110, 110, 110, 110, 110, 120];
      const a = analyzeTrend(
        buildInput({
          current: 120,
          daily,
          indicators: { trend7d: 5, ma7: 90, ma30: 100, ma90: 110 },
        }),
      );
      expect(a.insights.daily).toContain('短期多头占优，均线支撑有效');
    });

    it('尚未全面站上均线时提示均线未转多', () => {
      const daily = [...new Array(370).fill(200), 100, 100, 100, 100, 100, 100, 110];
      const a = analyzeTrend(buildInput({ current: 110, daily, indicators: { trend7d: 5 } }));
      expect(a.insights.daily).toContain('均线尚未全面转多');
    });

    it('横盘且均线纠缠时提示等待放量选择方向', () => {
      const a = analyzeTrend(
        buildInput({ current: 100, indicators: { trend7d: 0, ma7: 100, ma30: 100, ma90: 100 } }),
      );
      expect(a.insights.daily).toContain('多空拉锯');
    });

    it('横盘且均线非纠缠时提示横盘整理', () => {
      const a = analyzeTrend(
        buildInput({ current: 100, indicators: { trend7d: 0, ma7: 90, ma30: 100, ma90: 110 } }),
      );
      expect(a.insights.daily).toContain('横盘整理，等待方向选择');
    });

    it('日线涨跌幅缺失时按横盘解读', () => {
      const a = analyzeTrend(
        buildInput({
          current: 100,
          indicators: { trend7d: null, ma7: 100, ma30: 100, ma90: 100 },
        }),
      );
      expect(a.insights.daily).toContain('多空拉锯');
    });
  });

  describe('周期解读：周线', () => {
    it('周线走弱但 MA20 未破时提示趋势结构尚在', () => {
      const weekly = [...new Array(15).fill(50), 200, 50, 50, 50, 100];
      const a = analyzeTrend(buildInput({ current: 100, weekly }));
      expect(a.insights.weekly).toContain('MA20 未破');
    });

    it('周线走弱且回撤超过 30% 时提示修复需要时间', () => {
      const weekly = [...new Array(20).fill(200), 100];
      const a = analyzeTrend(buildInput({ current: 100, weekly }));
      expect(a.insights.weekly).toContain('回撤较深');
    });

    it('周线走弱且回撤不深时提示关注均线压力', () => {
      const weekly = [...new Array(20).fill(200), 190];
      const a = analyzeTrend(buildInput({ current: 190, weekly }));
      expect(a.insights.weekly).toContain('中期偏弱');
    });

    it('周线走强且站上 MA5 时提示均线支撑良好', () => {
      const weekly = [...new Array(20).fill(50), 100];
      const a = analyzeTrend(buildInput({ current: 100, weekly }));
      expect(a.insights.weekly).toContain('中期趋势偏多');
    });

    it('周线走强但仍在 MA5 下方时提示需确认突破', () => {
      const weekly = [...new Array(15).fill(200), 50, 200, 200, 200, 110];
      const a = analyzeTrend(buildInput({ current: 110, weekly }));
      expect(a.insights.weekly).toContain('仍在 MA5 下方');
    });

    it('周线横盘时提示方向未明', () => {
      const a = analyzeTrend(buildInput({ current: 100, weekly: new Array(60).fill(100) }));
      expect(a.insights.weekly).toContain('中期横盘整理');
    });
  });

  describe('周期解读：月线', () => {
    it('长期强势中的短期回调给出 MA12 支撑解读', () => {
      const closes = [...new Array(36).fill(50), 400, 400, 400];
      const a = analyzeTrend(
        buildInput({ current: 200, monthly: monthlyCandles(closes, 2022, 0) }),
      );
      expect(a.insights.monthly).toContain('长期强势中的短期回调');
    });

    it('价格运行于均线上方时给出长期向上解读', () => {
      const a = analyzeTrend(buildInput({ current: 110 }));
      expect(a.insights.monthly).toContain('长期趋势向上');
    });

    it('均线数据缺失时提示均线支撑转弱', () => {
      // 最后 3 根收盘为 0 → MA3 = 0 → 偏离无法计算
      const a = analyzeTrend(
        buildInput({ current: 110, monthly: monthlyCandles([100, 0, 0, 0], 2022, 0) }),
      );
      expect(a.insights.monthly).toContain('均线支撑转弱');
    });

    it('跌破 MA12 时提示趋势转弱', () => {
      const a = analyzeTrend(buildInput({ current: 90 }));
      expect(a.insights.monthly).toContain('跌破 MA12');
    });

    it('回调但 MA12 未破时提示关注 MA12 支撑', () => {
      const closes = [...new Array(45).fill(10), 400, 50, 50, 50];
      const a = analyzeTrend(
        buildInput({ current: 100, monthly: monthlyCandles(closes, 2022, 0) }),
      );
      expect(a.insights.monthly).toContain('关注 MA12 能否形成支撑');
    });

    it('月线 3 个月前收盘价为 0 时方向退化为横盘', () => {
      const a = analyzeTrend(
        buildInput({ current: 110, monthly: monthlyCandles([0, 100, 100, 100], 2022, 0) }),
      );
      expect(a.insights.monthly).toContain('长期横盘');
    });

    it('月线 3 个月前收盘价为 0 而 12 个月前有效时方向退化为长期方向', () => {
      const closes = new Array(13).fill(100);
      closes[9] = 0;
      closes[11] = 110;
      const a = analyzeTrend(
        buildInput({
          current: 110,
          weekly: new Array(60).fill(110),
          monthly: monthlyCandles(closes, 2022, 0),
        }),
      );
      expect(a.insights.monthly).toContain('长期横盘');
      // 月线方向取自 12 个月变化 → 唯一向上的周期
      expect(a.summary).toContain('日线/周线/年线横盘整理，其余周期上行趋势未改');
    });
  });

  describe('周期解读：年线', () => {
    it('年线向上且距 3 年高点回撤超过 50% 时提示仍处修复期', () => {
      const closes = new Array(48).fill(100);
      const highs = new Array(48).fill(200);
      for (let i = 12; i < 48; i++) highs[i] = 1000;
      const a = analyzeTrend(
        buildInput({
          current: 150,
          monthly: monthlyWith(closes, highs, 2022, 0),
        }),
      );
      expect(a.insights.yearly).toContain('距高点回撤较深');
    });

    it('年线向上但已跌破年均线时提示趋势强度减弱', () => {
      const closes = new Array(48).fill(100);
      closes[11] = 100;
      closes[23] = 300;
      closes[35] = 200;
      closes[47] = 300;
      const a = analyzeTrend(
        buildInput({ current: 250, monthly: monthlyWith(closes, closes.map((c) => c * 1.01), 2022, 0) }),
      );
      expect(a.insights.yearly).toContain('已跌破年均线');
    });

    it('年线走弱且跌破年均线时提示抄底需谨慎', () => {
      const closes = new Array(48).fill(100);
      closes[11] = 300;
      closes[23] = 300;
      closes[35] = 300;
      const a = analyzeTrend(
        buildInput({ current: 150, monthly: monthlyWith(closes, closes.map((c) => c * 1.01), 2022, 0) }),
      );
      expect(a.insights.yearly).toContain('抄底需谨慎');
    });

    it('年线回调但仍站上年均线时提示关注年均线支撑', () => {
      const closes = new Array(48).fill(100);
      closes[11] = 100;
      closes[23] = 100;
      closes[35] = 300;
      closes[47] = 300;
      const a = analyzeTrend(
        buildInput({ current: 250, monthly: monthlyWith(closes, closes.map((c) => c * 1.01), 2022, 0) }),
      );
      expect(a.insights.yearly).toContain('关注年均线支撑');
    });
  });

  describe('操作建议：盘口修正', () => {
    it('均线数据缺失时一律观望', () => {
      const a = analyzeTrend(
        buildInput({
          current: 110,
          indicators: { trend7d: 5, ma30: null },
        }),
      );
      expect(a.advice).toContain('均线数据不足');
    });

    it('多周期向上但盘口偏空时改为观望', () => {
      const a = analyzeTrend(
        buildInput({
          current: 110,
          indicators: { trend7d: 5, ma30: 100 },
          derivatives: oneDay({ takerRatio: 0.9, topLsrAccount: 1.0 }),
        }),
      );
      expect(a.advice).toContain('多周期向上但盘口偏空');
    });

    it('多周期走弱但盘口出现承接时改为观望', () => {
      const a = analyzeTrend(
        buildInput({
          current: 90,
          indicators: { trend7d: -5, ma30: 100 },
          derivatives: oneDay({ takerRatio: 1.1, topLsrAccount: 1.3 }),
        }),
      );
      expect(a.advice).toContain('多周期走弱但盘口出现承接');
    });

    it('现价仍在 MA30 下方且方向不明确时观望', () => {
      const a = analyzeTrend(
        buildInput({
          current: 90,
          weekly: new Array(60).fill(90),
          monthly: flatMonthly(90),
          indicators: { trend7d: 0, ma30: 100 },
        }),
      );
      expect(a.advice).toContain('现价仍在日线MA30下方');
    });

    it('现价站上 MA30 但多空信号不一致时观望', () => {
      const a = analyzeTrend(
        buildInput({
          current: 110,
          weekly: new Array(60).fill(150),
          monthly: flatMonthly(110),
          indicators: { trend7d: 5, ma30: 100 },
        }),
      );
      expect(a.advice).toContain('多空信号不一致');
    });
  });
});
