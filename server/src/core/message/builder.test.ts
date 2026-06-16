import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setDb, closeDb } from '../db.js';
import { initDefaults } from '../models/setting.js';
import { buildMessage, buildIndicators, type CoinResult } from './builder.js';
import type { Coin } from '../models/coin.js';

let customDb: Database.Database;

const fakeCoin = (overrides: Partial<Coin> = {}): Coin => ({
  id: 1, symbol: 'BTC', name: '比特币', gate_pair: 'BTC_USDT', cg_id: 'bitcoin',
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