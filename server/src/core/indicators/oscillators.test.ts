import { describe, it, expect } from 'vitest';
import {
  bollBandwidthPercentile,
  calculateAtr,
  calculateBoll,
  calculateMacd,
  calculateRsi,
  emaSeries,
} from './oscillators.js';
import type { GateCandle } from '../gate/klines.js';

/** 构造 K 线：close 序列 + 固定 ±1% 高低点。 */
function candles(closes: number[]): GateCandle[] {
  return closes.map((close, i) => ({
    ts: 1_700_000_000 + i * 3600,
    close,
    high: close * 1.01,
    low: close * 0.99,
    volume: 100,
  }));
}

describe('calculateBoll', () => {
  it('横盘：上下轨收敛于中轨，%B = 50', () => {
    const b = calculateBoll(Array.from({ length: 25 }, () => 100))!;
    expect(b.mid).toBe(100);
    expect(b.upper).toBe(100);
    expect(b.lower).toBe(100);
    expect(b.bandwidth).toBe(0);
    expect(b.percentB).toBe(50);
  });

  it('数据不足返回 null', () => {
    expect(calculateBoll([1, 2, 3])).toBeNull();
  });

  it('上涨序列：价格靠近上轨，%B > 50', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + i);
    const b = calculateBoll(closes)!;
    expect(b.upper).toBeGreaterThan(b.mid);
    expect(b.mid).toBeGreaterThan(b.lower);
    expect(b.percentB).toBeGreaterThan(50);
  });
});

describe('bollBandwidthPercentile', () => {
  it('带宽恒定（横盘）时百分位为 50，而不是 100', () => {
    expect(bollBandwidthPercentile(Array.from({ length: 60 }, () => 100))).toBe(50);
  });
});

describe('emaSeries', () => {
  it('标准 EMA 递推', () => {
    // period=3 → alpha=0.5
    expect(emaSeries([1, 2, 3], 3)).toEqual([1, 1.5, 2.25]);
  });

  it('空数组', () => {
    expect(emaSeries([], 3)).toEqual([]);
  });
});

describe('calculateMacd', () => {
  it('数据不足返回 null', () => {
    expect(calculateMacd(Array.from({ length: 30 }, () => 100))).toBeNull();
  });

  it('返回最新与上一根值（用于判断金叉/动能）', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const m = calculateMacd(closes)!;
    expect(m.dif).toBeGreaterThan(0);
    expect(m.prevDif).not.toBeNull();
    expect(m.prevDea).not.toBeNull();
    expect(m.hist).toBeCloseTo((m.dif - m.dea) * 2, 8);
  });
});

describe('calculateRsi', () => {
  it('单边上涨 = 100', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(calculateRsi(closes)).toBe(100);
  });

  it('单边下跌 = 0', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(calculateRsi(closes)).toBe(0);
  });

  it('横盘 = 50', () => {
    expect(calculateRsi(Array.from({ length: 20 }, () => 100))).toBe(50);
  });

  it('数据不足返回 null', () => {
    expect(calculateRsi([1, 2, 3])).toBeNull();
  });
});

describe('calculateAtr', () => {
  it('恒定振幅的 ATR 等于该振幅', () => {
    const atr = calculateAtr(candles(Array.from({ length: 20 }, () => 100)), 14);
    expect(atr).toBeCloseTo(2, 8);
  });

  it('数据不足返回 null', () => {
    expect(calculateAtr(candles([100, 101, 102]), 14)).toBeNull();
  });
});
