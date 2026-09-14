import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDb, closeDb } from '../db.js';
import { initDefaults } from '../models/setting.js';
import { getUsdtToCnyRate, _resetFxCache, FALLBACK_USDT_TO_CNY } from './fx.js';
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
  _resetFxCache();
  vi.resetAllMocks();
});

describe('getUsdtToCnyRate', () => {
  it('CoinGecko 返回正常 → 用 live，origin=coingecko', async () => {
    vi.mocked(httpGet).mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { tether: { cny: 6.85 } } });
    const r = await getUsdtToCnyRate();
    expect(r.rate).toBe(6.85);
    expect(r.source).toBe('live');
    expect(r.origin).toBe('coingecko');
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

  it('CoinGecko 失败 → 自动降级到 open.er-api.com', async () => {
    // 第一个源（CoinGecko）抛错；第二个源（open.er-api.com）成功
    vi.mocked(httpGet)
      .mockRejectedValueOnce(new Error('coingecko 429'))
      .mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { result: 'success', rates: { CNY: 6.92 } } });
    const r = await getUsdtToCnyRate();
    expect(r.rate).toBe(6.92);
    expect(r.source).toBe('live');
    expect(r.origin).toBe('open.er-api.com');
  });

  it('CoinGecko + open.er-api.com 都失败 → 降级到 frankfurter', async () => {
    vi.mocked(httpGet)
      .mockRejectedValueOnce(new Error('coingecko network down'))
      .mockRejectedValueOnce(new Error('open.er-api.com 5xx'))
      .mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { rates: { CNY: 6.78 } } });
    const r = await getUsdtToCnyRate();
    expect(r.rate).toBe(6.78);
    expect(r.source).toBe('live');
    expect(r.origin).toBe('frankfurter');
  });

  it('所有源都失败 → fallback 到 FALLBACK_USDT_TO_CNY', async () => {
    vi.mocked(httpGet)
      .mockRejectedValueOnce(new Error('coingecko network down'))
      .mockRejectedValueOnce(new Error('open.er-api.com network down'))
      .mockRejectedValueOnce(new Error('frankfurter network down'));
    const r = await getUsdtToCnyRate();
    expect(r.source).toBe('fallback');
    expect(r.rate).toBe(FALLBACK_USDT_TO_CNY);
    // 兜底值必须 > 0 且不应该是个离谱值（早期 7.20 偏高，这里确认已经调到接近现实）
    expect(r.rate).toBeGreaterThan(6);
    expect(r.rate).toBeLessThan(7.5);
  });

  it('CoinGecko 返回非法数据 → 跳过该源，降级到下一源', async () => {
    // CoinGecko 返回空 tether 对象 → 跳过
    vi.mocked(httpGet)
      .mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { tether: {} } })
      .mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { result: 'success', rates: { CNY: 6.75 } } });
    const r = await getUsdtToCnyRate();
    expect(r.rate).toBe(6.75);
    expect(r.origin).toBe('open.er-api.com');
  });

  it('CoinGecko 返回负数 → 跳过该源，降级到 frankfurter', async () => {
    vi.mocked(httpGet)
      .mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { tether: { cny: -1 } } }) // coingecko 跳
      .mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { result: 'success', rates: { CNY: 6.92 } } }) // open.er-api 命中
      .mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { rates: { CNY: 6.80 } } }); // frankfurter（实际不会调）
    const r = await getUsdtToCnyRate();
    expect(r.rate).toBe(6.92);
    expect(r.origin).toBe('open.er-api.com');
  });

  it('open.er-api.com 返回 result!=success → 跳过', async () => {
    vi.mocked(httpGet)
      .mockRejectedValueOnce(new Error('coingecko fail'))
      .mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { result: 'error', rates: {} } })
      .mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { rates: { CNY: 6.85 } } });
    const r = await getUsdtToCnyRate();
    expect(r.origin).toBe('frankfurter');
    expect(r.rate).toBe(6.85);
  });
});
