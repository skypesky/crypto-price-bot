import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDb, closeDb } from '../db.js';
import { initDefaults } from '../models/setting.js';
import { getGateDerivatives } from './futures.js';
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
});
afterEach(() => {
  customDb.close();
  closeDb();
  vi.resetAllMocks();
});

/** 今天 UTC 00:00 的时间戳（秒）。 */
const todayStart = Math.floor(Date.now() / 86_400_000) * 86400;
/** n 天前的 UTC 00:00（秒）。 */
const daysAgo = (n: number) => todayStart - n * 86400;

/** 造一行 contract_stats。 */
function row(time: number, over: Record<string, unknown> = {}) {
  return {
    time,
    lsr_account: 2.0,
    lsr_taker: 1.1,
    top_lsr_account: 0.5,
    long_users: 300,
    short_users: 100,
    open_interest_usd: 1_000_000,
    long_liq_usd: 1000,
    short_liq_usd: 100,
    last_funding_rate: '0.0001',
    ...over,
  };
}

function mockRows(rows: unknown[]) {
  vi.mocked(httpGet).mockResolvedValueOnce({ status: 200, headers: new Headers(), data: rows });
}

describe('getGateDerivatives', () => {
  it('剔除"今天"这根进行中的桶，daily 只留完整交易日', async () => {
    mockRows([
      row(daysAgo(7)), row(daysAgo(6)), row(daysAgo(5)),
      row(daysAgo(4)), row(daysAgo(3)), row(daysAgo(2)),
      row(daysAgo(1)), row(todayStart, { lsr_taker: 0 }),
    ]);

    const d = await getGateDerivatives('BTC_USDT', 7);

    expect(d).not.toBeNull();
    expect(d!.daily).toHaveLength(7);
    // 最后一根必须是昨天，不是今天
    expect(d!.daily[d!.daily.length - 1]!.ts).toBe(daysAgo(1));
    // 当天进行中的 lsr_taker=0 不能污染均值
    expect(d!.daily.every((x) => x.takerRatio !== 0)).toBe(true);
  });

  it('字段缺失（null）不会被当成数值 0', async () => {
    mockRows([
      row(daysAgo(2), { lsr_taker: null, top_lsr_account: undefined, long_users: null }),
      row(daysAgo(1), { lsr_taker: null, top_lsr_account: undefined, long_users: null }),
    ]);

    const d = await getGateDerivatives('BTC_USDT', 7);

    expect(d!.daily[0]!.takerRatio).toBeNull();
    expect(d!.daily[0]!.topLsrAccount).toBeNull();
    expect(d!.daily[0]!.longUsers).toBeNull();
  });

  it('爆仓与持仓变化只统计完整交易日', async () => {
    mockRows([
      row(daysAgo(2), { long_liq_usd: 500, open_interest_usd: 1_000_000 }),
      row(daysAgo(1), { long_liq_usd: 500, open_interest_usd: 2_000_000 }),
      // 今天这根带了大额爆仓，不应计入
      row(todayStart, { long_liq_usd: 999_999, open_interest_usd: 9_000_000 }),
    ]);

    const d = await getGateDerivatives('BTC_USDT', 7);

    expect(d!.longLiquidationUsd).toBe(1000);
    expect(d!.openInterestChangePct).toBeCloseTo(100, 5);
  });

  it('没有永续合约（HTTP 400）→ 返回 null 而不是抛错', async () => {
    const { HttpError } = await import('../../util/http.js');
    vi.mocked(httpGet).mockRejectedValueOnce(new HttpError('CONTRACT_NOT_FOUND: bad request', 400));
    expect(await getGateDerivatives('NOPE_USDT', 7)).toBeNull();
  });

  it('空数组 → null', async () => {
    mockRows([]);
    expect(await getGateDerivatives('BTC_USDT', 7)).toBeNull();
  });
});
