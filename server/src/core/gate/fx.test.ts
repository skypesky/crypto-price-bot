import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDb, closeDb } from '../db.js';
import { initDefaults } from '../models/setting.js';
import { getUsdtToCnyRate, _resetFxCache } from './fx.js';
import { httpGet } from '../../util/http.js';

vi.mock('../../util/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../util/http.js')>();
  return { ...actual, httpGet: vi.fn() };
});

let customDb: Database.Database;
beforeEach(() => {
  customDb = new Database(':memory:');
  customDb.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  setDb(customDb);
  initDefaults();
  _resetFxCache();
});
afterEach(() => {
  customDb.close();
  closeDb();
  vi.clearAllMocks();
});

describe('getUsdtToCnyRate', () => {
  it('CoinGecko 返回正常 → 用 live', async () => {
    vi.mocked(httpGet).mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { tether: { cny: 6.85 } } });
    const r = await getUsdtToCnyRate();
    expect(r.rate).toBe(6.85);
    expect(r.source).toBe('live');
  });

  it('1h 内再次调用走 cache', async () => {
    vi.mocked(httpGet).mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { tether: { cny: 6.85 } } });
    const a = await getUsdtToCnyRate();
    expect(a.source).toBe('live');
    // 第二次不应再调 httpGet
    const b = await getUsdtToCnyRate();
    expect(b.source).toBe('cache');
    expect(b.rate).toBe(6.85);
    expect(httpGet).toHaveBeenCalledTimes(1);
  });

  it('CoinGecko 抛错 → fallback 到 settings.usdt_to_cny (默认 7.20)', async () => {
    vi.mocked(httpGet).mockRejectedValueOnce(new Error('network down'));
    const r = await getUsdtToCnyRate();
    expect(r.source).toBe('fallback');
    expect(r.rate).toBe(7.2);
  });

  it('CoinGecko 返回非法数据 → fallback', async () => {
    vi.mocked(httpGet).mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { tether: {} } });
    const r = await getUsdtToCnyRate();
    expect(r.source).toBe('fallback');
  });

  it('CoinGecko 返回负数 → fallback', async () => {
    vi.mocked(httpGet).mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { tether: { cny: -1 } } });
    const r = await getUsdtToCnyRate();
    expect(r.source).toBe('fallback');
  });
});
