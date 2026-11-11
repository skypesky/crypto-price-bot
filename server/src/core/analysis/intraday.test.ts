import { describe, it, expect } from 'vitest';
import { analyzeIntraday, type IntradayInput } from './intraday.js';
import type { GateCandle } from '../gate/klines.js';

const STEP = 3600;

/** 横盘 K 线：收盘恒为 price，高低点固定 ±rangePct。 */
function flat(n: number, price: number, rangePct = 0.01): GateCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: 1_700_000_000 + i * STEP,
    close: price,
    high: price * (1 + rangePct),
    low: price * (1 - rangePct),
    volume: 100,
  }));
}

/** 箱体 K 线：所有完整 K 线都在 low ~ high 之间。 */
function range(n: number, low: number, high: number): GateCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: 1_700_000_000 + i * STEP,
    close: (low + high) / 2,
    high,
    low,
    volume: 100,
  }));
}

/** 单边上涨 K 线（close 从 start 起每根 +1）。 */
function uptrend(n: number, start = 100): GateCandle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = start + i;
    return {
      ts: 1_700_000_000 + i * STEP,
      close,
      high: close * 1.005,
      low: close * 0.995,
      volume: 100,
    };
  });
}

/** 4h 横盘（价格 105），1h 箱体 100~110。 */
function baseInput(current: number): IntradayInput {
  return {
    current,
    candles4h: flat(61, 105),
    candles1h: range(49, 100, 110),
  };
}

describe('analyzeIntraday', () => {
  it('4h / 1h 都没数据 → null', () => {
    expect(analyzeIntraday({ current: 100, candles4h: [], candles1h: [] })).toBeNull();
    expect(analyzeIntraday({ current: 0, candles4h: flat(61, 100), candles1h: range(49, 100, 110) })).toBeNull();
  });

  it('横盘：识别箱体震荡，价格在中部时建议观望', () => {
    const r = analyzeIntraday(baseInput(105))!;
    expect(r.headline).toContain('4h：震荡');
    expect(r.headline).toContain('箱体：');
    expect(r.headline).toContain('中部50%');
    expect(r.advice).toContain('箱体中部');
  });

  it('箱体上沿：不追多', () => {
    const r = analyzeIntraday(baseInput(108))!;
    expect(r.headline).toContain('上沿80%');
    expect(r.advice).toContain('箱体上沿');
  });

  it('箱体下沿：轻仓试多 + 跌破箱底止损', () => {
    const r = analyzeIntraday(baseInput(102))!;
    expect(r.headline).toContain('下沿20%');
    expect(r.advice).toContain('轻仓试多');
    expect(r.advice).toContain('跌破箱底止损');
  });

  it('突破箱体上沿：提示突破与假突破风险', () => {
    const r = analyzeIntraday(baseInput(112))!;
    expect(r.headline).toContain('已突破上沿');
    expect(r.advice).toContain('突破');
  });

  it('跌破箱体下沿：提示下探风险', () => {
    const r = analyzeIntraday(baseInput(98))!;
    expect(r.headline).toContain('已跌破下沿');
    expect(r.advice).toContain('跌破箱底');
  });

  it('4h 上涨：方向偏多，4h / 1h 指标各一行并给出布林上中下轨', () => {
    const r = analyzeIntraday({
      current: 160,
      candles4h: uptrend(61),
      candles1h: flat(49, 160),
    })!;
    expect(r.headline).toContain('偏多');

    // 4h：BOLL 上/中/下 + MACD + RSI + ATR 压缩在一行
    expect(r.h4).toContain('BOLL4h：上$');
    expect(r.h4).toContain('/中$');
    expect(r.h4).toContain('/下$');
    expect(r.h4).toContain('MACD');
    expect(r.h4).toContain('RSI');
    expect(r.h4).toContain('ATR');

    // 1h：BOLL 上/中/下 + %B + MACD/RSI 压缩在一行
    expect(r.h1).toContain('BOLL1h：上$');
    expect(r.h1).toContain('/中$');
    expect(r.h1).toContain('/下$');
    expect(r.h1).toContain('%B');

    expect(r.advice.length).toBeGreaterThan(0);
  });

  it('只有 4h：不输出箱体，仍返回 4h 方向', () => {
    const r = analyzeIntraday({ current: 160, candles4h: uptrend(61), candles1h: [] })!;
    expect(r.headline).not.toContain('箱体');
    expect(r.headline).toContain('偏多');
    expect(r.h1).toBeNull();
  });

  it('只有 1h：4h 显示数据不足，箱体照常输出', () => {
    const r = analyzeIntraday({ current: 105, candles4h: [], candles1h: range(49, 100, 110) })!;
    expect(r.headline).toContain('4h：数据不足');
    expect(r.headline).toContain('箱体：');
    expect(r.h4).toBeNull();
  });
});
