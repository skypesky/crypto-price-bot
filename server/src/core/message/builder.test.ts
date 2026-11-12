import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setDb, closeDb } from '../db.js';
import { initDefaults } from '../models/setting.js';
import { buildMessage, buildIndicators, buildCoinLinks, type CoinResult } from './builder.js';
import { messageToFeishuCard, type FeishuCardElement } from './formatter.js';
import type { Coin } from '../models/coin.js';

/** 取卡片元素里所有可见文本，便于按语义断言。 */
function elementText(e: FeishuCardElement): string {
  switch (e.tag) {
    case 'markdown':
      return e.content;
    case 'column_set':
      return e.columns.map(elementText).join('\n');
    case 'column':
      return e.elements.map(elementText).join('\n');
    default:
      return '';
  }
}

let customDb: Database.Database;

const fakeCoin = (overrides: Partial<Coin> = {}): Coin => ({
  id: 1, symbol: 'BTC', name: '比特币', gate_pair: 'BTC_USDT', gate_slug: 'bitcoin', binance_pair: 'BTC_USDT', cg_id: 'bitcoin',
  sort_order: 0, enabled: 1, created_at: 0, updated_at: 0,
  ...overrides,
});

beforeAll(() => {
  customDb = new Database(':memory:');
  customDb.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  setDb(customDb);
  initDefaults();
});

afterAll(() => {
  customDb.close();
  closeDb();
});

describe('buildIndicators', () => {
  it('数据充足', () => {
    const closes = Array.from({ length: 400 }, (_, i) => 100 + i);
    const ind = buildIndicators(closes, 500);
    expect(ind.ma7).toBe(496); // 493..499 平均
    expect(ind.ma365).toBeGreaterThan(100);
  });

  it('数据不足', () => {
    const closes = [1, 2, 3];
    const ind = buildIndicators(closes, 3);
    expect(ind.ma7).toBeNull();
    expect(ind.ma30).toBeNull();
    expect(ind.trend30d).toBeNull();
  });
});

describe('buildMessage', () => {
  it('成功币种', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: {
        ma7: 49000, ma30: 48000, ma90: 45000, ma180: 40000, ma365: 30000,
        trend7d: 5.5, trend30d: 10.2, trend90d: 20.0, trend180d: 30.0, trend1y: 50.0,
      },
      source: 'gate',
    };
    const msg = buildMessage([r], { usdtToCny: 7.2, timezone: 'UTC', now: new Date('2026-06-16T01:00:00Z') });
    expect(msg).toContain('比特币');
    expect(msg).toContain('BTC');
    expect(msg).toContain('50,000');
    // 涨跌幅按宽度折行：首行 `涨跌：+5.50%(7d) · +10.20%(30d) · …`
    expect(msg).toContain('涨跌：+5.50%(7d) · +10.20%(30d)');
    // 价格行：美元 + 紧凑人民币（万）+ 汇率，压到一行
    expect(msg).toContain('`$50,000.00(¥36.0万 @7.20)`');
    // 默认 trigger=local
    expect(msg).toContain('加密货币价格报告 (含技术指标) from local');
    // MA 压成一行；符号两侧留空格，表示现价与均线的关系（> = 现价在均线上方）
    // 49000×7.2=352800 → ¥35.3万
    expect(msg).toContain('均线：7 > 49,000(¥35.3万)');
    expect(msg).toContain('30 > 48,000(¥34.6万)');
    expect(msg).toContain('90 > 45,000(¥32.4万)');
    expect(msg).toContain('180 > 40,000(¥28.8万)');
    expect(msg).toContain('365 > 30,000(¥21.6万)');
  });

  it('长行按显示宽度折行，续行对齐到标签后的内容起点', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '167.72' },
      indicators: {
        ma7: 186, ma30: 193, ma90: 144, ma180: 105, ma365: 89.57,
        trend7d: -11.22, trend30d: -20.01, trend90d: 188.13, trend180d: 107.06, trend1y: 84.75,
      },
      source: 'gate',
    };
    const msg = buildMessage([r], { usdtToCny: 6.67, timezone: 'UTC', now: new Date('2026-06-16T01:00:00Z') });
    // 涨跌：3 项一行，续行缩进 9 空格（对齐到「涨跌：」之后）
    expect(msg).toContain('   涨跌：-11.22%(7d) · -20.01%(30d) · +188.13%(90d)\n         +107.06%(180d) · +84.75%(1y)');
    // 均线：2 项一行，续行同样对齐
    expect(msg).toContain('   均线：7 < 186(¥1,240.62) · 30 < 193(¥1,287.31)\n         90 > 144(¥960.48)');
    // 四位数人民币带千位分隔
    expect(msg).toContain('¥1,240.62');
  });

  it('CI 触发时标题显示 [ci]', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: {
        ma7: 49000, ma30: 48000, ma90: 45000, ma180: 40000, ma365: 30000,
        trend7d: 5.5, trend30d: 10.2, trend90d: 20.0, trend180d: 30.0, trend1y: 50.0,
      },
      source: 'gate',
    };
    const msg = buildMessage([r], { usdtToCny: 7.2, timezone: 'UTC', now: new Date('2026-06-16T01:00:00Z'), trigger: 'ci' });
    expect(msg).toContain('加密货币价格报告 (含技术指标) from ci');
    expect(msg).not.toContain('from local');
  });

  it('MA 偏低（ratio < 0.9）', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: {
        ma7: 60000, ma30: 70000, ma90: 80000, ma180: 90000, ma365: null,
        trend7d: -16.7, trend30d: -28.6, trend90d: -37.5, trend180d: -44.4, trend1y: null,
      },
      source: 'gate',
    };
    const msg = buildMessage([r], { usdtToCny: 7.0, timezone: 'UTC', now: new Date('2026-06-16T01:00:00Z') });
    // ma7 = 60000 → 现价在均线下方（<）；60000×7=420000 → ¥42.0万
    expect(msg).toContain('7 < 60,000(¥42.0万)');
    // ma365 数据不足 → N/A
    expect(msg).toContain('365 N/A');
  });

  it('失败币种', () => {
    const r: CoinResult = {
      coin: fakeCoin({ symbol: 'X', name: 'X币' }),
      ticker: null,
      indicators: null,
      source: 'failed',
    };
    const msg = buildMessage([r], { usdtToCny: 7.2, timezone: 'UTC', now: new Date() });
    expect(msg).toContain('数据获取失败');
  });

  it('fxSource=fallback 时标题加 ⚠️汇率兜底 标记', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: null,
      source: 'gate',
    };
    const msg = buildMessage([r], { usdtToCny: 6.8, timezone: 'UTC', now: new Date('2026-09-14T00:00:00Z'), fxSource: 'fallback' });
    expect(msg).toContain('⚠️汇率兜底');
    expect(msg).toContain('from local ⚠️汇率兜底');
  });

  it('fxSource=live 时不加标记', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: null,
      source: 'gate',
    };
    const msg = buildMessage([r], { usdtToCny: 6.71, timezone: 'UTC', now: new Date('2026-09-14T00:00:00Z'), fxSource: 'live' });
    expect(msg).not.toContain('⚠️汇率兜底');
    expect(msg).toContain('from local');
  });

  it('不传 fxSource 时不加标记（兼容历史调用）', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: null,
      source: 'gate',
    };
    const msg = buildMessage([r], { usdtToCny: 6.71, timezone: 'UTC', now: new Date('2026-09-14T00:00:00Z') });
    expect(msg).not.toContain('⚠️汇率兜底');
  });

  it('稳定币（无 gate pair）', () => {
    const r: CoinResult = {
      coin: fakeCoin({ symbol: 'USDT', name: '泰达币', gate_pair: null, cg_id: 'tether' }),
      ticker: { last: '1.0' },
      indicators: null,
      source: 'stable',
    };
    const msg = buildMessage([r]);
    expect(msg).toContain('USDT');
    expect(msg).toContain('tether');
  });

  it('小币种（现价 < 1 美元）：美元最多 6 位小数、人民币不足 1 元用三位有效数字', () => {
    const r: CoinResult = {
      coin: fakeCoin({ symbol: 'SHIB', name: '柴犬币', gate_pair: 'SHIB_USDT', gate_slug: 'shiba-inu', cg_id: 'shiba-inu' }),
      ticker: { last: '0.123456' },
      indicators: {
        ma7: 50,          // 1 ≤ 50 < 100 → 美元保留 2 位小数；50×7.2=360 → 360.00 元
        ma30: 0.051234,   // < 1 美元 → 最多 6 位小数；0.051234×7.2=0.369 < 1 元 → 三位有效数字
        ma90: 0.123456,   // 与现价持平 → 「=」符号
        ma180: null,      // 数据不足 → N/A
        ma365: 0.8,       // < 1 美元 → 保留 2 位小数；0.8×7.2=5.76 → 5.76 元
        trend7d: 1.5, trend30d: -2.5, trend90d: 0, trend180d: null, trend1y: 3.3,
      },
      source: 'gate',
    };
    const msg = buildMessage([r], { usdtToCny: 7.2, timezone: 'UTC', now: new Date('2026-06-16T01:00:00Z') });
    // 现价 < 1 美元 → 美元最多 6 位小数；0.123456×7.2=0.889 < 1 元 → 三位有效数字
    expect(msg).toContain('`$0.123456(¥0.889 @7.20)`');
    // 均线 50：落在 [1, 100) → 美元保留 2 位小数
    expect(msg).toContain('7 < 50.00(¥360.00)');
    // 均线 0.051234：小于 1 美元 → 最多 6 位小数；人民币不足 1 元 → 三位有效数字
    expect(msg).toContain('30 > 0.051234(¥0.369)');
    // 现价与均线持平 → 「=」
    expect(msg).toContain('90 = 0.123456(¥0.889)');
    expect(msg).toContain('180 N/A');
    expect(msg).toContain('365 < 0.80(¥5.76)');
  });

  it('亿级人民币：价格折算超过 1 亿时用「亿」单位', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '20000000' },
      indicators: {
        ma7: 20000000, ma30: null, ma90: null, ma180: null, ma365: null,
        trend7d: 10, trend30d: null, trend90d: null, trend180d: null, trend1y: null,
      },
      source: 'gate',
    };
    const msg = buildMessage([r], { usdtToCny: 7.2, timezone: 'UTC', now: new Date('2026-06-16T01:00:00Z') });
    // 20000000 × 7.2 = 144000000 → ¥1.44亿
    expect(msg).toContain('`$20,000,000.00(¥1.44亿 @7.20)`');
    // 均线同样走「亿」写法；美元 ≥ 100 → 取整
    expect(msg).toContain('7 = 20,000,000(¥1.44亿)');
  });

  it('合约情绪带「解读：」前缀时单独成行（去掉前缀重复输出）', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: null,
      analysis: {
        daily: '日线：横盘',
        weekly: '周线：横盘',
        monthly: '月线：横盘',
        yearly: '年线：横盘',
        insights: { daily: '', weekly: '', monthly: '', yearly: '' },
        sentiment: ['多空 2.25(多头占优)', '解读：多头情绪偏热，注意回踩'],
        futures: ['资金费率 0.0100%/8h'],
        summary: '各周期横盘',
        advice: '观望',
      },
      source: 'gate',
    };
    const msg = buildMessage([r]);
    expect(msg).toContain('──── 📊 合约 ────');
    // 「解读：」条目不混进数据行，而是单独一行且只出现一次前缀
    expect(msg).toContain('解读：多头情绪偏热，注意回踩');
    expect((msg.match(/解读：/g) ?? []).length).toBe(1);
  });

  it('只有合约资金、没有情绪数据时也渲染「合约」分区', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: null,
      analysis: {
        daily: '日线：横盘',
        weekly: '周线：横盘',
        monthly: '月线：横盘',
        yearly: '年线：横盘',
        insights: { daily: '', weekly: '', monthly: '', yearly: '' },
        sentiment: [],
        futures: ['资金费率 0.0100%/8h'],
        summary: '各周期横盘',
        advice: '观望',
      },
      source: 'gate',
    };
    const msg = buildMessage([r]);
    expect(msg).toContain('──── 📊 合约 ────');
    expect(msg).toContain('资金费率 0.0100%/8h');
  });

  it('只有「解读：」一条情绪数据时也渲染「合约」分区', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: null,
      analysis: {
        daily: '日线：横盘',
        weekly: '周线：横盘',
        monthly: '月线：横盘',
        yearly: '年线：横盘',
        insights: { daily: '', weekly: '', monthly: '', yearly: '' },
        sentiment: ['解读：空头情绪主导'],
        futures: [],
        summary: '各周期横盘',
        advice: '观望',
      },
      source: 'gate',
    };
    const msg = buildMessage([r]);
    expect(msg).toContain('──── 📊 合约 ────');
    expect(msg).toContain('解读：空头情绪主导');
  });
});

describe('buildCoinLinks', () => {
  it('BTC：生成正确的 gate / binance / coinglass / coingecko URL', () => {
    const { gate, binance, coinglass, coingecko } = buildCoinLinks(fakeCoin());
    expect(gate).toBe('https://www.gate.com/zh/trade/BTC_USDT');
    expect(binance).toBe('https://www.binance.com/zh-CN/trade/BTC_USDT?type=spot');
    expect(coinglass).toBe('https://www.coinglass.com/zh/currencies/BTC');
    expect(coingecko).toBe('https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/bitcoin');
  });

  it('cg_id 会被 URL 编码', () => {
    const { coingecko } = buildCoinLinks(fakeCoin({ cg_id: 'a b/c' }));
    expect(coingecko).toContain('a%20b%2Fc');
  });

  it('gate_pair 为空（稳定币）时回退到 Gate 价格页', () => {
    const { gate } = buildCoinLinks(fakeCoin({ symbol: 'USDT', gate_pair: null, gate_slug: 'tether' }));
    expect(gate).toBe('https://www.gate.com/zh/price/tether-usdt');
  });

  it('gate_slug 为空时回退到 symbol（小写）', () => {
    const { gate } = buildCoinLinks(fakeCoin({ symbol: 'USDT', gate_pair: null, gate_slug: null }));
    expect(gate).toBe('https://www.gate.com/zh/price/usdt-usdt');
  });

  it('BNB 的币安链接用交易对（不是 cg_id 的 binancecoin）', () => {
    const { binance } = buildCoinLinks(fakeCoin({ symbol: 'BNB', gate_pair: 'BNB_USDT', gate_slug: 'bnb', binance_pair: 'BNB_USDT', cg_id: 'binancecoin' }));
    expect(binance).toBe('https://www.binance.com/zh-CN/trade/BNB_USDT?type=spot');
  });

  it('binance_pair 为空时 binance 返回 null（币安现货没这个交易对）', () => {
    const { binance } = buildCoinLinks(fakeCoin({ symbol: 'GT', gate_pair: 'GT_USDT', gate_slug: 'gate', binance_pair: null, cg_id: 'gatechain-token' }));
    expect(binance).toBeNull();
  });

  it('buildMessage 在 binance_pair 为 null 时不展示 Binance 链接', () => {
    const r: CoinResult = {
      coin: fakeCoin({ symbol: 'GT', gate_pair: 'GT_USDT', gate_slug: 'gate', binance_pair: null, cg_id: 'gatechain-token' }),
      ticker: { last: '9.0' },
      indicators: null,
      source: 'gate',
    };
    const msg = buildMessage([r]);
    expect(msg).not.toContain('[Binance](');
    // 仍然展示 Gate / CoinGlass / CoinGecko
    expect(msg).toContain('[Gate](');
    expect(msg).toContain('[CoinGlass](');
    expect(msg).toContain('[CoinGecko](');
  });

  it('buildMessage 默认展示 Gate | Binance | CoinGlass | CoinGecko 四段链接', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: null,
      source: 'gate',
    };
    const msg = buildMessage([r]);
    expect(msg).toContain('[Gate](https://www.gate.com/zh/trade/BTC_USDT)');
    expect(msg).toContain('[Binance](https://www.binance.com/zh-CN/trade/BTC_USDT?type=spot)');
    expect(msg).toContain('[CoinGlass](https://www.coinglass.com/zh/currencies/BTC)');
    expect(msg).toContain('[CoinGecko](https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/bitcoin)');
  });

  it('有 analysis 时渲染趋势研判段（日/周/月/年 + 情绪 + 结论）', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: null,
      analysis: {
        daily: '日线：下跌 -7.99%',
        weekly: '周线：下跌 -9.50%',
        monthly: '月线：下跌 -6.37%',
        yearly: '年线：跌破3年年均线 6.37%',
        insights: {
          daily: '短期空头占优，均线压制，反弹先看能否收复 MA7',
          weekly: '中期偏弱，反弹关注均线压力',
          monthly: '长期趋势向上，价格运行于均线上方',
          yearly: '长期上升趋势未破',
        },
        sentiment: ['多空 2.25(多头占优)'],
        futures: ['费率 0.0100%/8h(年化10.9%,多头付费意愿尚可)'],
        summary: '各周期一致走弱，下行趋势延续',
        advice: '观望 —— 现价仍在日线MA30下方，等待站回MA30或明确企稳',
      },
      source: 'gate',
    };
    const msg = buildMessage([r]);
    // 分区标题带分隔线，四个周期各占一行
    expect(msg).toContain('──── 🧭 周期研判 ────');
    expect(msg).toContain('日线：下跌 -7.99%');
    expect(msg).toContain('周线：下跌 -9.50%');
    expect(msg).toContain('月线：下跌 -6.37%');
    expect(msg).toContain('年线：跌破3年年均线 6.37%');
    expect(msg).toContain('──── 📊 合约 ────');
    expect(msg).toContain('多空 2.25(多头占优)');
    expect(msg).toContain('费率 0.0100%/8h');
    // 四个周期的解读逐条展开（日线·/周线·/月线·/年线·），只有一条「解读」
    expect(msg).toContain('解读：日线·短期空头占优，均线压制');
    expect(msg).toContain('周线·中期偏弱');
    expect(msg).toContain('月线·长期趋势向上');
    expect(msg).toContain('年线·长期上升趋势未破');
    expect((msg.match(/解读：/g) ?? []).length).toBe(1);
    // 结论 + 建议压成一行
    expect(msg).toContain('──── 📌 结论 ────');
    expect(msg).toContain('各周期一致走弱，下行趋势延续 → 观望');
  });

  it('没有 analysis 时不渲染研判段', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: null,
      source: 'gate',
    };
    const msg = buildMessage([r]);
    expect(msg).not.toContain('🧭');
  });

  it('有 intraday 时渲染日内段（方向+箱体、4h 指标、1h 指标、建议）', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: null,
      intraday: {
        headline: '4h：震荡 · 箱体：$48,000.00~$52,000.00(8.0% 中部50%)',
        h4: 'BOLL4h：上$50,500.00/中$49,500.00/下$48,500.00(带宽4.2% 正常) · MACD：多头动能平缓 · RSI：52.0(中性)',
        h1: 'BOLL1h：上$50,200.00/中$49,800.00/下$49,400.00(%B50% 中轨附近 收敛)',
        advice: '箱体中部观望，等边缘或放量突破',
      },
      source: 'gate',
    };
    const msg = buildMessage([r]);
    expect(msg).toContain('──── ⚡ 日内 ────');
    expect(msg).toContain('4h：震荡');
    expect(msg).toContain('箱体：$48,000.00~$52,000.00');
    expect(msg).toContain('BOLL4h：上$50,500.00/中$49,500.00/下$48,500.00');
    expect(msg).toContain('BOLL1h：上$50,200.00/中$49,800.00/下$49,400.00');
    expect(msg).toContain('💡 箱体中部观望');
  });

  it('没有 intraday 时不渲染日内段', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: null,
      source: 'gate',
    };
    const msg = buildMessage([r]);
    expect(msg).not.toContain('⚡');
  });

  it('日内交易段排在趋势研判之前', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: null,
      intraday: {
        headline: '4h：震荡',
        h4: null,
        h1: null,
        advice: '观望',
      },
      analysis: {
        daily: '日线：横盘',
        weekly: '周线：横盘',
        monthly: '月线：横盘',
        yearly: '年线：横盘',
        insights: { daily: '', weekly: '', monthly: '', yearly: '' },
        sentiment: [],
        futures: [],
        summary: '各周期横盘',
        advice: '观望',
      },
      source: 'gate',
    };
    const msg = buildMessage([r]);
    const intradayAt = msg.indexOf('⚡');
    const trendAt = msg.indexOf('🧭');
    expect(intradayAt).toBeGreaterThan(-1);
    expect(trendAt).toBeGreaterThan(-1);
    expect(intradayAt).toBeLessThan(trendAt);
  });

  it('紧凑排版仍能被飞书卡片正确解析（链接转按钮、正文保留）', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: {
        ma7: 49000, ma30: 48000, ma90: 45000, ma180: 40000, ma365: 30000,
        trend7d: 5.5, trend30d: 10.2, trend90d: 20.0, trend180d: 30.0, trend1y: 50.0,
      },
      intraday: {
        headline: '4h：震荡 · 箱体：$48,000.00~$52,000.00(8.0% 中部50%)',
        h4: 'BOLL4h：上$50,500.00/中$49,500.00/下$48,500.00(带宽4.2% 正常)',
        h1: 'BOLL1h：上$50,200.00/中$49,800.00/下$49,400.00(%B50% 中轨附近 收敛)',
        advice: '箱体中部观望，等边缘或放量突破',
      },
      analysis: {
        daily: '日线：横盘',
        weekly: '周线：横盘',
        monthly: '月线：横盘',
        yearly: '年线：横盘',
        insights: { daily: '', weekly: '', monthly: '', yearly: '' },
        sentiment: ['多空 1.00(多空均衡)'],
        futures: ['资金费率 0.0100%/8h'],
        summary: '各周期横盘',
        advice: '观望 —— 方向不明',
      },
      source: 'gate',
    };
    const card = messageToFeishuCard(buildMessage([r], { usdtToCny: 7.2 }));
    expect(card).not.toBeNull();
    const text = card!.card.body.elements.map(elementText).join('\n');
    expect(text).toContain('**4h**：震荡');
    expect(text).toContain('**BOLL4h**');
    expect(text).toContain('**BOLL1h**');
    // 链接改为 Markdown 行内链接
    expect(text).toContain('[Gate](https://www.gate.com/zh/trade/BTC_USDT)');
  });

  // 多币种报告：飞书卡片按 🔹 边界切块，币种之间用 hr 分隔，尾部落在 trailer 里
  it('多币种报告能按 🔹 边界切成多个币种块', () => {
    const btc: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: {
        ma7: 49000, ma30: 48000, ma90: 45000, ma180: 40000, ma365: 30000,
        trend7d: 5.5, trend30d: 10.2, trend90d: 20.0, trend180d: 30.0, trend1y: 50.0,
      },
      source: 'gate',
    };
    const gt: CoinResult = {
      coin: fakeCoin({ symbol: 'GT', name: 'Gate', gate_pair: 'GT_USDT', gate_slug: 'gate', binance_pair: null, cg_id: 'gatechain-token' }),
      ticker: { last: '9.00' },
      indicators: null,
      source: 'gate',
    };
    const card = messageToFeishuCard(buildMessage([btc, gt], { usdtToCny: 7.2, timezone: 'UTC', now: new Date('2026-06-16T01:00:00Z') }));
    expect(card).not.toBeNull();
    if (!card) return;

    // 币种之间一个 hr
    const elements = card.card.body.elements;
    expect(elements.filter((e) => e.tag === 'hr')).toHaveLength(1);
    const hrIdx = elements.findIndex((e) => e.tag === 'hr');

    // 第一个币种块只含 BTC 内容，不串到第二个币种
    const firstText = elements.slice(0, hrIdx).map(elementText).join('\n');
    expect(firstText).toContain('**比特币**');
    expect(firstText).toContain('[Binance](');

    // 第二个币种块只含 GT 内容
    const secondText = elements.slice(hrIdx + 1).map(elementText).join('\n');
    expect(secondText).toContain('**Gate**');
    expect(secondText).not.toContain('比特币');
    expect(secondText).not.toContain('[Binance](');

    // 更新时间在副标题，免责声明在最后
    expect(card.card.header.subtitle?.content).toContain('⏰ 更新时间');
    expect(secondText).toContain('不构成投资建议');
  });

  // 结构与可达性检查：如果将来 URL 形态变了（域名 / 路径改了），这些会先炸
  it.each([
    ['BTC',  'BTC_USDT',  'bitcoin'],
    ['ETH',  'ETH_USDT',  'ethereum'],
    ['BNB',  'BNB_USDT',  'binancecoin'],
    ['FIL',  'FIL_USDT',  'filecoin'],
    ['ATOM', 'ATOM_USDT', 'cosmos'],
  ])('%s URL 结构合法 + 主机正确', (sym, pair, cgId) => {
    const { gate, binance, coinglass, coingecko } = buildCoinLinks(fakeCoin({ symbol: sym, gate_pair: pair, binance_pair: pair, cg_id: cgId }));
    const g = new URL(gate);
    const b = binance ? new URL(binance) : null;
    const cg = new URL(coinglass);
    const c = new URL(coingecko);
    expect(g.host).toBe('www.gate.com');
    expect(cg.host).toBe('www.coinglass.com');
    expect(c.host).toBe('www.coingecko.com');
    expect(g.pathname).toBe(`/zh/trade/${pair}`);
    expect(cg.pathname).toBe(`/zh/currencies/${sym}`);
    expect(c.pathname).toMatch(/^\/zh\/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81\/[^/]+$/);
    if (b) {
      expect(b.host).toBe('www.binance.com');
      expect(b.pathname).toBe(`/zh-CN/trade/${pair}`);
      expect(b.searchParams.get('type')).toBe('spot');
    }
  });

  // 真正的 slug 回归测试放到了 models.test.ts 的 DEFAULT_COINS 上（直接验证 DB 默认值）。
});