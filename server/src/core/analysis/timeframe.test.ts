import { describe, it, expect } from 'vitest';
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
  maOffset,
  pct,
  pctAbs,
  periodHigh,
  volumeTrend,
  type TimeframeView,
} from './timeframe.js';
import type { GateCandle } from '../gate/klines.js';

const DAY = 86_400;

/** 由收盘价构造升序 K 线（最后一根视为进行中）。 */
function makeCandles(
  closes: number[],
  opts: {
    high?: (close: number, i: number) => number;
    low?: (close: number, i: number) => number;
    volume?: (i: number) => number;
  } = {},
): GateCandle[] {
  return closes.map((close, i) => ({
    ts: 1_700_000_000 + i * DAY,
    close,
    high: opts.high ? opts.high(close, i) : close * 1.01,
    low: opts.low ? opts.low(close, i) : close * 0.99,
    volume: opts.volume ? opts.volume(i) : 100,
  }));
}

/** 等比收盘序列。 */
function series(start: number, n: number, ratio: number): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    out.push(p);
    p *= ratio;
  }
  return out;
}

/** 构造月线（每月一根，用于年线聚合）。 */
function monthlyCandles(specs: { year: number; month: number; close: number; high?: number; low?: number }[]): GateCandle[] {
  return specs.map((s) => ({
    ts: Math.floor(Date.UTC(s.year, s.month, 1) / 1000),
    close: s.close,
    high: s.high ?? s.close * 1.01,
    low: s.low ?? s.close * 0.99,
    volume: 100,
  }));
}

/** 一个「什么都没有」的周期视图，用于验证数据不足的兜底文案。 */
function emptyView(over: Partial<TimeframeView> = {}): TimeframeView {
  return {
    current: 100,
    change: null,
    mas: [],
    drawdown: null,
    run: { days: 0, up: true },
    align: '',
    ...over,
  };
}

describe('pct / pctAbs', () => {
  it('正数带 + 号', () => {
    expect(pct(1.5)).toBe('+1.50%');
  });

  it('负数保留负号', () => {
    expect(pct(-1.5)).toBe('-1.50%');
  });

  it('绝对值百分比只保留小数（符号由调用方处理）', () => {
    expect(pctAbs(1.5)).toBe('1.50%');
  });
});

describe('grade', () => {
  it('涨幅超过 8% 判定为强势上涨', () => {
    expect(grade(9)).toEqual({ dir: 'up', word: '强势上涨' });
  });

  it('涨幅 2%~8% 判定为上涨', () => {
    expect(grade(3)).toEqual({ dir: 'up', word: '上涨' });
  });

  it('涨幅 0.5%~2% 判定为微涨', () => {
    expect(grade(1)).toEqual({ dir: 'up', word: '微涨' });
  });

  it('跌幅超过 8% 判定为大幅走弱', () => {
    expect(grade(-9)).toEqual({ dir: 'down', word: '大幅走弱' });
  });

  it('跌幅 2%~8% 判定为下跌', () => {
    expect(grade(-3)).toEqual({ dir: 'down', word: '下跌' });
  });

  it('跌幅 0.5%~2% 判定为微跌', () => {
    expect(grade(-1)).toEqual({ dir: 'down', word: '微跌' });
  });

  it('涨跌幅在 ±0.5% 以内判定为横盘', () => {
    expect(grade(0.2)).toEqual({ dir: 'flat', word: '横盘' });
  });
});

describe('maOffset', () => {
  it('均线为 null 时无法计算偏离', () => {
    expect(maOffset(100, null)).toBeNull();
  });

  it('均线为 0 时无法计算偏离', () => {
    expect(maOffset(100, 0)).toBeNull();
  });

  it('现价高于均线时偏离为正', () => {
    expect(maOffset(110, 100)).toBeCloseTo(10);
  });

  it('现价低于均线时偏离为负', () => {
    expect(maOffset(90, 100)).toBeCloseTo(-10);
  });
});

describe('computeMAs', () => {
  it('按周期计算均线值与偏离', () => {
    const views = computeMAs(makeCandles(new Array(10).fill(100)), 110, [{ period: 5, label: 'MA5' }]);
    expect(views[0]).toEqual({ period: 5, label: 'MA5', value: 100, offset: 10 });
  });

  it('K 线不足周期时均线值与偏离均为 null', () => {
    const views = computeMAs(makeCandles([100, 101]), 110, [{ period: 5, label: 'MA5' }]);
    expect(views[0]!.value).toBeNull();
    expect(views[0]!.offset).toBeNull();
  });
});

describe('changeOver', () => {
  it('K 线数量不足以回看 n 根时返回 null', () => {
    expect(changeOver(makeCandles([100, 101]), 110, 3)).toBeNull();
  });

  it('计算现价相对 n 根之前的涨跌幅', () => {
    expect(changeOver(makeCandles([100, 110]), 121, 1)).toBeCloseTo(21);
  });
});

describe('periodHigh', () => {
  it('K 线数量少于区间长度时返回 null', () => {
    expect(periodHigh(makeCandles([100]), 5)).toBeNull();
  });

  it('区间长度为 0 时返回 null', () => {
    expect(periodHigh(makeCandles([100]), 0)).toBeNull();
  });

  it('区间内高点全部无效时返回 null', () => {
    expect(periodHigh(makeCandles([100, 101], { high: () => 0 }), 2)).toBeNull();
  });

  it('返回区间内最高价', () => {
    expect(periodHigh(makeCandles([100, 110, 120]), 3)).toBeCloseTo(121.2);
  });
});

describe('drawdown', () => {
  it('高点为 null 时无法计算回撤', () => {
    expect(drawdown(100, null)).toBeNull();
  });

  it('高点非正数时无法计算回撤', () => {
    expect(drawdown(100, 0)).toBeNull();
  });

  it('现价低于高点时回撤为负值', () => {
    expect(drawdown(90, 100)).toBeCloseTo(-10);
  });

  it('现价仍在高点时回撤为 0', () => {
    expect(drawdown(100, 100)).toBeCloseTo(0);
  });
});

describe('consecutiveRun', () => {
  it('连续上涨时统计连阳根数', () => {
    expect(consecutiveRun(makeCandles([100, 101, 102, 103]))).toEqual({ days: 2, up: true });
  });

  it('连续下跌时统计连阴根数', () => {
    expect(consecutiveRun(makeCandles([103, 102, 101, 100]))).toEqual({ days: 2, up: false });
  });

  it('平盘打断连击，连击根数为 0', () => {
    expect(consecutiveRun(makeCandles([100, 100, 100, 101]))).toEqual({ days: 0, up: true });
  });

  it('方向中途反转时连击立即中断', () => {
    expect(consecutiveRun(makeCandles([100, 102, 101, 103]))).toEqual({ days: 1, up: false });
  });
});

describe('volumeTrend', () => {
  it('完整 K 线不足两个周期时返回 null', () => {
    expect(volumeTrend(makeCandles(new Array(10).fill(100)), 7)).toBeNull();
  });

  it('前期量能为 0 时返回 null', () => {
    const cs = makeCandles(new Array(20).fill(100), { volume: (i) => (i >= 12 ? 100 : 0) });
    expect(volumeTrend(cs, 7)).toBeNull();
  });

  it('量能放大时返回正百分比', () => {
    const cs = makeCandles(new Array(20).fill(100), { volume: (i) => (i >= 12 ? 200 : 100) });
    expect(volumeTrend(cs, 7)).toBeCloseTo(100);
  });

  it('量能萎缩时返回负百分比', () => {
    const cs = makeCandles(new Array(20).fill(100), { volume: (i) => (i >= 12 ? 50 : 100) });
    expect(volumeTrend(cs, 7)).toBeCloseTo(-50);
  });
});

describe('avgAmplitude', () => {
  it('没有完整 K 线时返回 null', () => {
    expect(avgAmplitude([])).toBeNull();
  });

  it('收盘价全部非正数时返回 null', () => {
    expect(avgAmplitude(makeCandles([0, 0, 0], { high: () => 0, low: () => 0 }))).toBeNull();
  });

  it('计算完整周期的平均振幅', () => {
    expect(avgAmplitude(makeCandles([100, 100], { high: () => 102, low: () => 98 }))).toBeCloseTo(4);
  });
});

describe('maAlignment', () => {
  it('任一均线缺失时返回空串', () => {
    expect(maAlignment(null, 30, 90)).toBe('');
  });

  it('ma7 > ma30 > ma90 时为多头排列', () => {
    expect(maAlignment(10, 8, 6)).toBe('均线多头排列');
  });

  it('ma7 < ma30 < ma90 时为空头排列', () => {
    expect(maAlignment(6, 8, 10)).toBe('均线空头排列');
  });

  it('其余情况为均线纠缠', () => {
    expect(maAlignment(10, 8, 9)).toBe('均线纠缠');
  });
});

describe('aggregateToYearly', () => {
  it('按自然年聚合月线并输出年线', () => {
    const out = aggregateToYearly(
      monthlyCandles([
        { year: 2022, month: 0, close: 100, high: 110, low: 90 },
        { year: 2022, month: 1, close: 120, high: 130, low: 100 },
        { year: 2023, month: 0, close: 150, high: 160, low: 140 },
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.close).toBe(120);
    expect(out[0]!.high).toBe(130);
    expect(out[0]!.low).toBe(90);
    expect(out[0]!.volume).toBe(200);
    expect(out[1]!.close).toBe(150);
    expect(out[1]!.high).toBe(160);
    expect(out[1]!.low).toBe(140);
  });

  it('年线时间戳取该年第一根月线', () => {
    const monthly = monthlyCandles([
      { year: 2022, month: 5, close: 100 },
      { year: 2023, month: 0, close: 120 },
    ]);
    const out = aggregateToYearly(monthly);
    expect(out[0]!.ts).toBe(monthly[0]!.ts);
    expect(out[1]!.ts).toBe(monthly[1]!.ts);
  });

  it('高点全部无效时用收盘价兜底', () => {
    const out = aggregateToYearly(monthlyCandles([{ year: 2022, month: 0, close: 100, high: 0 }]));
    expect(out[0]!.high).toBe(100);
  });

  it('低点全部无效时用收盘价兜底', () => {
    const out = aggregateToYearly(monthlyCandles([{ year: 2022, month: 0, close: 100, low: 0 }]));
    expect(out[0]!.low).toBe(100);
  });

  it('空月线聚合出空数组', () => {
    expect(aggregateToYearly([])).toEqual([]);
  });
});

describe('describeDaily', () => {
  it('汇总涨跌定性、连阳、均线位置、量能与振幅', () => {
    const s = describeDaily(
      emptyView({
        change: 3,
        mas: [{ period: 7, label: 'MA7', value: 90, offset: 11.11 }],
        run: { days: 3, up: true },
        align: '均线多头排列',
      }),
      20,
      1.5,
    );
    expect(s).toContain('日线：');
    expect(s).toContain('上涨');
    expect(s).toContain('连阳3根');
    expect(s).toContain('站上MA7');
    expect(s).toContain('均线多头排列');
    expect(s).toContain('近7日量能放大20%');
    expect(s).toContain('日均振幅1.5%');
  });

  it('连阴时文案为「连阴」', () => {
    const s = describeDaily(emptyView({ run: { days: 4, up: false } }), null, null);
    expect(s).toContain('连阴4根');
  });

  it('跌破均线时文案为「跌破」', () => {
    const s = describeDaily(
      emptyView({ mas: [{ period: 7, label: 'MA7', value: 110, offset: -9.09 }] }),
      null,
      null,
    );
    expect(s).toContain('跌破MA7');
  });

  it('偏离为 null 的均线不参与展示', () => {
    const s = describeDaily(
      emptyView({
        mas: [
          { period: 7, label: 'MA7', value: null, offset: null },
          { period: 30, label: 'MA30', value: 90, offset: 11.11 },
        ],
      }),
      null,
      null,
    );
    expect(s).toContain('站上MA30');
    expect(s).not.toContain('MA7');
  });

  it('量能萎缩时文案为「萎缩」', () => {
    const s = describeDaily(emptyView({ change: 1 }), -20, null);
    expect(s).toContain('近7日量能萎缩20%');
  });

  it('量能变化不足 15% 时不展示量能', () => {
    const s = describeDaily(emptyView({ change: 1 }), 5, null);
    expect(s).not.toContain('量能');
  });

  it('没有任何可用信息时返回「数据不足」', () => {
    expect(describeDaily(emptyView(), null, null)).toBe('日线：数据不足');
  });
});

describe('describeWeekly', () => {
  it('汇总涨跌定性、连周与均线位置', () => {
    const s = describeWeekly(
      emptyView({
        change: -3,
        mas: [{ period: 5, label: 'MA5', value: 110, offset: -9.09 }],
        run: { days: 3, up: false },
      }),
    );
    expect(s).toContain('周线：');
    expect(s).toContain('下跌');
    expect(s).toContain('连阴3周');
    expect(s).toContain('跌破MA5');
  });

  it('连阳时文案为「连阳」', () => {
    expect(describeWeekly(emptyView({ run: { days: 3, up: true } }))).toContain('连阳3周');
  });

  it('回撤超过 1% 时提示距 13 周高点回撤', () => {
    const s = describeWeekly(emptyView({ change: -3, drawdown: -5 }));
    expect(s).toContain('距13周高点回撤5.00%');
  });

  it('回撤不足 1% 时不提示回撤', () => {
    const s = describeWeekly(emptyView({ change: -3, drawdown: -0.5 }));
    expect(s).not.toContain('回撤');
  });

  it('没有任何可用信息时返回「数据不足」', () => {
    expect(describeWeekly(emptyView())).toBe('周线：数据不足');
  });
});

describe('describeMonthly', () => {
  it('汇总涨跌定性、连月与均线位置', () => {
    const s = describeMonthly(
      emptyView({
        change: 3,
        mas: [{ period: 3, label: 'MA3', value: 90, offset: 11.11 }],
        run: { days: 3, up: true },
      }),
    );
    expect(s).toContain('月线：');
    expect(s).toContain('上涨');
    expect(s).toContain('连阳3月');
    expect(s).toContain('站上MA3');
  });

  it('连阴时文案为「连阴」', () => {
    expect(describeMonthly(emptyView({ run: { days: 3, up: false } }))).toContain('连阴3月');
  });

  it('回撤超过 1% 时提示距 12 月高点回撤', () => {
    const s = describeMonthly(emptyView({ change: -3, drawdown: -5 }));
    expect(s).toContain('距12月高点回撤5.00%');
  });

  it('回撤不足 1% 时不提示回撤', () => {
    const s = describeMonthly(emptyView({ change: -3, drawdown: -0.5 }));
    expect(s).not.toContain('回撤');
  });

  it('没有任何可用信息时返回「数据不足」', () => {
    expect(describeMonthly(emptyView())).toBe('月线：数据不足');
  });
});

describe('describeYearly', () => {
  /** 36 根月线：前 24 根高点 100，后 12 根高点 300。 */
  const monthly = monthlyCandles([
    ...Array.from({ length: 24 }, (_, i) => ({
      year: 2022,
      month: i,
      close: 100,
      high: 100,
      low: 100,
    })),
    ...Array.from({ length: 12 }, (_, i) => ({
      year: 2023 + Math.floor(i / 12),
      month: i % 12,
      close: 200,
      high: 300,
      low: 200,
    })),
  ]);

  it('汇总涨跌定性、连年与均线位置', () => {
    const s = describeYearly(
      emptyView({
        change: 3,
        mas: [{ period: 3, label: '3年年均线', value: 90, offset: 11.11 }],
        run: { days: 2, up: true },
      }),
      monthly,
    );
    expect(s).toContain('年线：');
    expect(s).toContain('上涨');
    expect(s).toContain('连阳2年');
    expect(s).toContain('站上3年年均线');
  });

  it('连阴时文案为「连阴」', () => {
    expect(describeYearly(emptyView({ run: { days: 2, up: false } }), monthly)).toContain('连阴2年');
  });

  it('同时提示 1 年与 3 年高点回撤', () => {
    const s = describeYearly(emptyView({ current: 100, change: -3 }), monthly);
    expect(s).toContain('距1年高点回撤66.67%');
    expect(s).toContain('距3年高点回撤66.67%');
  });

  it('3 年回撤不足 20% 时只提示 1 年回撤', () => {
    const mild = monthlyCandles(
      Array.from({ length: 36 }, (_, i) => ({
        year: 2022 + Math.floor(i / 12),
        month: i % 12,
        close: 100,
        high: i >= 24 ? 110 : 100,
        low: 100,
      })),
    );
    const s = describeYearly(emptyView({ current: 100, change: -3 }), mild);
    expect(s).toContain('距1年高点回撤');
    expect(s).not.toContain('距3年高点回撤');
  });

  it('月线不足 12 根时没有高点回撤信息', () => {
    const short = monthlyCandles(
      Array.from({ length: 6 }, (_, i) => ({ year: 2022, month: i, close: 100, high: 200, low: 100 })),
    );
    const s = describeYearly(emptyView({ current: 100, change: -3 }), short);
    expect(s).not.toContain('回撤');
  });

  it('没有任何可用信息时返回「数据不足」', () => {
    expect(describeYearly(emptyView(), [])).toBe('年线：数据不足');
  });
});
