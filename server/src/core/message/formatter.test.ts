import { describe, it, expect } from 'vitest';
import { normalizeMessageForTextChannel } from './formatter.js';

describe('normalizeMessageForTextChannel', () => {
  it('CRLF → LF', () => {
    expect(normalizeMessageForTextChannel('Line1\r\nLine2\r\nLine3')).toBe('Line1\nLine2\nLine3');
  });

  it('Markdown 链接 → text: url', () => {
    expect(normalizeMessageForTextChannel('[Gate 行情](https://www.gate.com/price/gate-gt)'))
      .toBe('Gate 行情: https://www.gate.com/price/gate-gt');
  });

  it('去除 markdown 字符', () => {
    expect(normalizeMessageForTextChannel('**bold** *italic* `code`'))
      .toBe('bold italic code');
  });

  it('混合内容', () => {
    const input = '📊 *今日加密货币价格报告*\n\n🔹 *[比特币](https://example.com/bitcoin)* (BTC)';
    const out = normalizeMessageForTextChannel(input);
    expect(out).toBe('📊 今日加密货币价格报告\n\n🔹 比特币: https://example.com/bitcoin (BTC)');
  });

  it('非字符串输入转字符串', () => {
    expect(normalizeMessageForTextChannel(123)).toBe('123');
    expect(normalizeMessageForTextChannel(null)).toBe('null');
    expect(normalizeMessageForTextChannel(undefined)).toBe('undefined');
  });

  it('空字符串', () => {
    expect(normalizeMessageForTextChannel('')).toBe('');
  });
});