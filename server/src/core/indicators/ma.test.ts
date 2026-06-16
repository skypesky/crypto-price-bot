import { describe, it, expect } from 'vitest';
import { calculateMA } from './ma.js';

describe('calculateMA', () => {
  it('空数组返回 null', () => {
    expect(calculateMA([], 7)).toBeNull();
  });

  it('数据不足返回 null', () => {
    expect(calculateMA([1, 2, 3], 7)).toBeNull();
  });

  it('正好 N 个数据求平均', () => {
    expect(calculateMA([2, 4, 6], 3)).toBe(4);
  });

  it('超过 N 个取最近 N 个', () => {
    expect(calculateMA([1, 1, 1, 2, 2, 2], 3)).toBe(2);
  });

  it('period <= 0 返回 null', () => {
    expect(calculateMA([1, 2, 3], 0)).toBeNull();
    expect(calculateMA([1, 2, 3], -1)).toBeNull();
  });

  it('大数', () => {
    expect(calculateMA([1000, 2000, 3000], 3)).toBe(2000);
  });
});