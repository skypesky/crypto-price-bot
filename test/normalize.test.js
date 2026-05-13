import { describe, it, expect } from 'vitest';

// 引入待测试的函数
// 注意：由于 index.js 在顶层直接执行，我们直接复制函数逻辑进行测试
function normalizeMessageForTextChannel(message) {
  return String(message)
    .replace(/\r\n/g, '\n')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2')
    .replace(/[*_`]/g, '');
}

describe('normalizeMessageForTextChannel', () => {
  it('should replace CRLF with LF', () => {
    const input = 'Line1\r\nLine2\r\nLine3';
    const result = normalizeMessageForTextChannel(input);
    expect(result).toBe('Line1\nLine2\nLine3');
  });

  it('should convert markdown links to text format', () => {
    const input = '[Gate 行情](https://www.gate.com/price/gate-gt)';
    const result = normalizeMessageForTextChannel(input);
    expect(result).toBe('Gate 行情: https://www.gate.com/price/gate-gt');
  });

  it('should remove markdown formatting characters', () => {
    const input = '**bold** *italic* `code`';
    const result = normalizeMessageForTextChannel(input);
    expect(result).toBe('bold italic code');
  });

  it('should handle mixed content', () => {
    const input = '📊 *今日加密货币价格报告*\n\n🔹 *[比特币](https://example.com/bitcoin)* (BTC)';
    const result = normalizeMessageForTextChannel(input);
    expect(result).toBe('📊 今日加密货币价格报告\n\n🔹 比特币: https://example.com/bitcoin (BTC)');
  });

  it('should convert non-string input to string', () => {
    expect(normalizeMessageForTextChannel(123)).toBe('123');
    expect(normalizeMessageForTextChannel(null)).toBe('null');
    expect(normalizeMessageForTextChannel(undefined)).toBe('undefined');
  });

  it('should handle empty string', () => {
    expect(normalizeMessageForTextChannel('')).toBe('');
  });
});
