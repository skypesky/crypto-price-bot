import { describe, it, expect } from 'vitest';
import { randomToken, randomTokenB64, randomIntInclusive, uniqueId } from './id.js';

describe('id utilities', () => {
  it('randomToken 默认 64 字符 hex', () => {
    const t = randomToken();
    expect(t).toHaveLength(64);
    expect(t).toMatch(/^[0-9a-f]+$/);
  });

  it('randomToken 可指定字节数', () => {
    expect(randomToken(8)).toHaveLength(16);
    expect(randomToken(16)).toHaveLength(32);
  });

  it('randomToken 两次结果不同', () => {
    expect(randomToken()).not.toBe(randomToken());
  });

  it('randomTokenB64 是 url-safe 字符集', () => {
    const t = randomTokenB64(32);
    expect(t).not.toMatch(/[+/=]/);
    expect(t.length).toBeGreaterThan(0);
  });

  it('randomIntInclusive 在 [min, max)', () => {
    for (let i = 0; i < 100; i++) {
      const v = randomIntInclusive(5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThan(10);
    }
  });

  it('randomIntInclusive 单点区间抛错', () => {
    expect(() => randomIntInclusive(5, 5)).toThrow();
    expect(() => randomIntInclusive(10, 5)).toThrow();
  });

  it('uniqueId 单调递增', () => {
    const a = uniqueId();
    const b = uniqueId();
    const c = uniqueId();
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it('uniqueId 支持前缀', () => {
    const v = uniqueId('test-');
    expect(v.startsWith('test-')).toBe(true);
  });
});