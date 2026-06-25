/**
 * 实时汇率：USDT → CNY
 * - 主源：CoinGecko `/simple/price`（每 1 小时缓存一次，避免高频触发限流）
 * - 失败回落到 config.usdt_to_cny（settings 表里）
 */

import { httpGet } from '../../util/http.js';
import { getConfig } from '../config.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时

interface CacheEntry {
  rate: number;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

interface CoingeckoSimplePrice {
  tether?: { cny?: number };
}

/** 返回 USDT → CNY 实时汇率；失败时回落到 config.usdt_to_cny */
export async function getUsdtToCnyRate(): Promise<{ rate: number; source: 'live' | 'cache' | 'fallback' }> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { rate: cache.rate, source: 'cache' };
  }

  try {
    const cfg = getConfig();
    const res = await httpGet<CoingeckoSimplePrice>(
      'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=cny',
      {
        timeoutMs: 10_000,
        retries: 1,
        headers: { 'User-Agent': cfg.ua },
        doh: null,
      },
    );
    const rate = res.data.tether?.cny;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`invalid rate from coingecko: ${JSON.stringify(res.data)}`);
    }
    cache = { rate, fetchedAt: now };
    return { rate, source: 'live' };
  } catch {
    const fallback = getConfig().usdt_to_cny;
    return { rate: fallback, source: 'fallback' };
  }
}

/** 测试用：清缓存强制下次重新拉 */
export function _resetFxCache(): void {
  cache = null;
}
