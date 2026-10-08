import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setDb, closeDb } from '../db.js';
import { initDefaults } from '../models/setting.js';
import { buildMessage, buildIndicators, buildCoinLinks, type CoinResult } from './builder.js';
import type { Coin } from '../models/coin.js';

let customDb: Database.Database;

const fakeCoin = (overrides: Partial<Coin> = {}): Coin => ({
  id: 1, symbol: 'BTC', name: '比特币', gate_pair: 'BTC_USDT', gate_slug: 'bitcoin', binance_slug: 'bitcoin', cg_id: 'bitcoin',
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
    expect(msg).toContain('¥360,000.00(7.20)');
    // 默认 trigger=local
    expect(msg).toContain('加密货币价格报告 (含技术指标) from local');
    // MA 指标同时显示美元和人民币金额
    // ma7 = 49000, ratio = 50000/49000 ≈ 1.02 → ➡️
    expect(msg).toContain('MA7:   ➡️ $49000.00 ¥352,800.00');
    // ma30 = 48000, ratio ≈ 1.04 → ➡️
    expect(msg).toContain('MA30:  ➡️ $48000.00 ¥345,600.00');
    // ma90 = 45000, ratio ≈ 1.11 → 📈 偏高
    expect(msg).toContain('MA90:  📈 $45000.00 ¥324,000.00 (偏高)');
    // ma180 = 40000, ratio = 1.25 → 📈 偏高
    expect(msg).toContain('MA180: 📈 $40000.00 ¥288,000.00 (偏高)');
    // ma365 = 30000, ratio ≈ 1.67 → 📈 偏高
    expect(msg).toContain('MA365: 📈 $30000.00 ¥216,000.00 (偏高)');
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
    // ma7 = 60000, ratio = 50000/60000 ≈ 0.83 → 📉 偏低
    expect(msg).toContain('MA7:   📉 $60000.00 ¥420,000.00 (偏低)');
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
  it('BTC：生成正确的 gate / binance / coingecko URL', () => {
    const { gate, binance, coingecko } = buildCoinLinks(fakeCoin());
    expect(gate).toBe('https://www.gate.com/zh/price/bitcoin-btc');
    expect(binance).toBe('https://www.binance.com/zh-CN/price/bitcoin/');
    expect(coingecko).toBe('https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/bitcoin');
  });

  it('cg_id 会被 URL 编码', () => {
    const { coingecko } = buildCoinLinks(fakeCoin({ cg_id: 'a b/c' }));
    expect(coingecko).toContain('a%20b%2Fc');
  });

  it('ATOM 用 cosmos-hub slug', () => {
    const { gate } = buildCoinLinks(fakeCoin({ symbol: 'ATOM', gate_slug: 'cosmos-hub' }));
    expect(gate).toBe('https://www.gate.com/zh/price/cosmos-hub-atom');
  });

  it('gate_slug 为空时回退到 symbol（小写）', () => {
    const { gate } = buildCoinLinks(fakeCoin({ symbol: 'USDT', gate_pair: null, gate_slug: null }));
    expect(gate).toBe('https://www.gate.com/zh/price/usdt-usdt');
  });

  it('BNB 的 binance_slug 是 bnb（不是 cg_id 的 binancecoin）', () => {
    const { binance } = buildCoinLinks(fakeCoin({ symbol: 'BNB', gate_slug: 'bnb', binance_slug: 'bnb', cg_id: 'binancecoin' }));
    expect(binance).toBe('https://www.binance.com/zh-CN/price/bnb/');
  });

  it('binance_slug 为空时 binance 返回 null（币安未上架的币）', () => {
    const { binance } = buildCoinLinks(fakeCoin({ symbol: 'GT', gate_slug: 'gate', binance_slug: null, cg_id: 'gatechain-token' }));
    expect(binance).toBeNull();
  });

  it('buildMessage 在 binance_slug 为 null 时不展示 Binance 链接', () => {
    const r: CoinResult = {
      coin: fakeCoin({ symbol: 'GT', gate_slug: 'gate', binance_slug: null, cg_id: 'gatechain-token' }),
      ticker: { last: '9.0' },
      indicators: null,
      source: 'gate',
    };
    const msg = buildMessage([r]);
    expect(msg).not.toContain('[Binance](');
    // 仍然展示 Gate 和 CoinGecko
    expect(msg).toContain('[Gate](');
    expect(msg).toContain('[CoinGecko](');
  });

  it('buildMessage 默认展示 Gate | Binance | CoinGecko 三段链接', () => {
    const r: CoinResult = {
      coin: fakeCoin(),
      ticker: { last: '50000.00' },
      indicators: null,
      source: 'gate',
    };
    const msg = buildMessage([r]);
    expect(msg).toContain('[Gate](https://www.gate.com/zh/price/bitcoin-btc)');
    expect(msg).toContain('[Binance](https://www.binance.com/zh-CN/price/bitcoin/)');
    expect(msg).toContain('[CoinGecko](https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/bitcoin)');
  });

  // 结构与可达性检查：如果将来 URL 形态变了（域名 / 路径改了），这些会先炸
  it.each([
    ['BTC',  'bitcoin',     'bitcoin'],
    ['ETH',  'ethereum',    'ethereum'],
    ['BNB',  'bnb',         'binancecoin'],
    ['FIL',  'filecoinipfs','filecoin'],
    ['ATOM', 'cosmos-hub',  'cosmos'],
  ])('%s URL 结构合法 + 主机正确', (sym, slug, cgId) => {
    const { gate, binance, coingecko } = buildCoinLinks(fakeCoin({ symbol: sym, gate_slug: slug, binance_slug: slug, cg_id: cgId }));
    const g = new URL(gate);
    const b = binance ? new URL(binance) : null;
    const c = new URL(coingecko);
    expect(g.host).toBe('www.gate.com');
    expect(c.host).toBe('www.coingecko.com');
    expect(g.pathname).toMatch(new RegExp(`^/zh/price/${slug}-${sym.toLowerCase()}$`));
    expect(c.pathname).toMatch(/^\/zh\/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81\/[^/]+$/);
    if (b) {
      expect(b.host).toBe('www.binance.com');
      expect(b.pathname).toMatch(new RegExp(`^/zh-CN/price/${slug}/$`));
    }
  });

  // 真正的 slug 回归测试放到了 models.test.ts 的 DEFAULT_COINS 上（直接验证 DB 默认值）。
});