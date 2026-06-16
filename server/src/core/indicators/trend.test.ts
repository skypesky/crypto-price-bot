import { describe, it, expect } from 'vitest';
import { calculateTrend } from './trend.js';

describe('calculateTrend', () => {
  it('past 为 null 返回 null', () => {
    expect(calculateTrend(100, null)).toBeNull();
  });

  it('past 为 0 返回 null', () => {
    expect(calculateTrend(100, 0)).toBeNull();
  });

  it('past undefined 返回 null', () => {
    expect(calculateTrend(100, undefined)).toBeNull();
  });

  it('上涨 +50%', () => {
    expect(calculateTrend(150, 100)).toBe(50);
  });

  it('下跌 -25%', () => {
    expect(calculateTrend(75, 100)).toBe(-25);
  });

  it('保留 2 位小数', () => {
    expect(calculateTrend(103.456, 100)).toBe(3.46);
  });

  it('不变化返回 0', () => {
    expect(calculateTrend(100, 100)).toBe(0);
  });

  it('NaN 输入返回 null', () => {
    expect(calculateTrend(NaN, 100)).toBeNull();
    expect(calculateTrend(100, NaN)).toBeNull();
  });
});