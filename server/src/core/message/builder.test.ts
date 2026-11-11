import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setDb, closeDb } from '../db.js';
import { initDefaults } from '../models/setting.js';
import { buildMessage, buildIndicators, buildCoinLinks, type CoinResult } from './builder.js';
import type { Coin } from '../models/coin.js';

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
    expect(msg).toContain('🔺 +5.5%');
    expect(msg).toContain('MA7');
    // 价格行：美元在前、人民币括注、汇率显式标注
    expect(msg).toContain('`$50,000.00(¥360,000.00)[汇率: 7.20]`');
    // 默认 trigger=local
    expect(msg).toContain('加密货币价格报告 (含技术指标) from local');
    // MA 指标同时显示美元和人民币金额，并显式说明现价与均线的大小关系
    // ma7 = 49000, ratio = 50000/49000 ≈ 1.02 → >（现价在均线上方）
    expect(msg).toContain('MA7:   > $49,000.00(¥352,800.00)');
    // ma30 = 48000, ratio ≈ 1.04 → >
    expect(msg).toContain('MA30:  > $48,000.00(¥345,600.00)');
    // ma90 = 45000, ratio ≈ 1.11 → >
    expect(msg).toContain('MA90:  > $45,000.00(¥324,000.00)');
    // ma180 = 40000, ratio = 1.25 → >
    expect(msg).toContain('MA180: > $40,000.00(¥288,000.00)');
    // ma365 = 30000, ratio ≈ 1.67 → >
    expect(msg).toContain('MA365: > $30,000.00(¥216,000.00)');
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
    // ma7 = 60000, ratio = 50000/60000 ≈ 0.83 → <（现价在均线下方）
    expect(msg).toContain('MA7:   < $60,000.00(¥420,000.00)');
    // ma365 数据不足 → N/A
    expect(msg).toContain('MA365: N/A');
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
        sentiment: ['账户多空比 2.25(多头占优)'],
        futures: ['资金费率 0.0100%/8h(年化10.9%,多头付费意愿尚可)'],
        summary: '各周期一致走弱，下行趋势延续',
        advice: '观望 —— 现价仍在日线MA30下方，等待站回MA30或明确企稳',
      },
      source: 'gate',
    };
    const msg = buildMessage([r]);
    expect(msg).toContain('🧭 趋势研判');
    expect(msg).toContain('日线：下跌 -7.99%');
    expect(msg).toContain('周线：下跌 -9.50%');
    expect(msg).toContain('月线：下跌 -6.37%');
    expect(msg).toContain('年线：跌破3年年均线 6.37%');
    expect(msg).toContain('📊 合约情绪');
    expect(msg).toContain('账户多空比 2.25(多头占优)');
    expect(msg).toContain('💰 合约资金');
    expect(msg).toContain('资金费率 0.0100%/8h');
    expect(msg).toContain('📌 结论');
    expect(msg).toContain('各周期一致走弱，下行趋势延续');
    // 每个周期后跟一句解读，结论后给出三选一的操作建议
    expect(msg).toContain('解读：短期空头占优，均线压制');
    expect(msg).toContain('💡 操作建议：观望');
  });

  it('没有 analysis 时不渲染研判段', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: null,
      source: 'gate',
    };
    const msg = buildMessage([r]);
    expect(msg).not.toContain('🧭 趋势研判');
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