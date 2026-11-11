import { describe, it, expect } from 'vitest';
import { splitMessage } from './split.js';

describe('splitMessage', () => {
  it('短消息原样返回一条', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('超过上限时按空行拆成多条，每条都不超限', () => {
    const block = 'x'.repeat(500);
    const message = Array.from({ length: 20 }, () => block).join('\n\n');
    const parts = splitMessage(message, 2000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(2000);
  });

  it('内容不丢：所有段落拼回来等于原文（去空白后）', () => {
    const blocks = ['第一块', '第二块'.repeat(100), '第三块'];
    const message = blocks.join('\n\n');
    const parts = splitMessage(message, 50);
    expect(parts.join('\n\n').replace(/\s+/g, '')).toBe(message.replace(/\s+/g, ''));
  });

  it('不会把一个段落劈成两半（按空行边界切）', () => {
    const a = 'A'.repeat(40);
    const b = 'B'.repeat(40);
    const c = 'C'.repeat(40);
    const parts = splitMessage([a, b, c].join('\n\n'), 100);
    for (const p of parts) {
      expect(p === a || p === b || p === c || p === `${a}\n\n${b}` || p === `${b}\n\n${c}`).toBe(true);
    }
  });

  it('单段超长时兜底硬切，不丢内容', () => {
    const huge = Array.from({ length: 200 }, () => 'line of text').join('\n');
    const parts = splitMessage(huge, 100);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100);
    expect(parts.join('\n')).toBe(huge);
  });

  it('真实报告规模（10 币 × 完整研判）能拆成多条且都不超 Telegram 上限', () => {
    const coin = [
      '🔹 *比特币* (BTC)',
      '   💵 `$73,824.20(¥504,219.29)[汇率: 6.83]`',
      '   ──────── 📈 趋势分析 ────────',
      '   📅 7天:   🔻 -8.3%    📅 30天:  🔻 -9.8%',
      '   ──────── 🧭 趋势研判 ────────',
      '   短线(7天)：大幅走弱 -8.30%，现价跌破MA7 1.69%，跌破MA30 6.90%，日均振幅3.8%',
      '   中线(30-90天)：30日大幅走弱-9.80%，90日强势上涨+16.29%，距90日高点回撤15.53%，现价低于MA90 6.75%，均线纠缠',
      '   长线(半年-1年)：180日下跌-6.69%，1年大幅走弱-27.37%，站上MA180 1.85%，低于MA365 3.23%',
      '   资金费率0.010%/8h(年化11.0%,多头付费意愿尚可)、账户多空比2.25(多头占优)、持仓-0.87%(资金平稳)、多头爆仓$66.6M占优(多头被清洗)；结论：各周期一致走弱，下行趋势延续，站回MA30前不宜追多',
      '   🔗 [Gate](https://www.gate.com/zh/trade/BTC_USDT) | [Binance](https://www.binance.com/zh-CN/trade/BTC_USDT?type=spot) | [CoinGlass](https://www.coinglass.com/zh/currencies/BTC) | [CoinGecko](https://www.coingecko.com/zh/x)',
    ].join('\n');
    const message = ['📊 *加密货币价格报告 (含技术指标) from local*', ...Array.from({ length: 10 }, () => coin), '⏰ 更新时间: 2026/11/11'].join('\n\n');
    expect(message.length).toBeGreaterThan(4096);

    const parts = splitMessage(message, 3800);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(3800);
    // 每条都以币种块为单位，不会出现半截的币种
    for (const p of parts) expect(p).toMatch(/^(📊|🔹|⏰)/);
  });
});
