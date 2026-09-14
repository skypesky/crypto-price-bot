/**
 * 实时汇率：USDT → CNY
 * - 多源链：CoinGecko（主）→ open.er-api.com → frankfurter.app，任一成功即用，并更新 1h 缓存
 * - 失败回落：FALLBACK_USDT_TO_CNY 常量（兜底值应接近实际汇率，避免推送与现实偏差过大）
 *
 * 为什么需要多源：
 * - 真实环境中常见 CoinGecko 失败的原因：DNS 污染 / 限流（429）/ User-Agent 拒访
 * - 单源失败时若直接落到 FALLBACK，推送价格偏离现实，对依赖 CNY 报价的用户体验差
 * - 多源轮询把失败概率压到几乎为零
 */

import { httpGet } from '../../util/http.js';
import { getConfig } from '../config.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
export const FALLBACK_USDT_TO_CNY = 6.80; // 兜底汇率（接近现实，避免推送价格偏差过大）

interface CacheEntry {
  rate: number;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

/** 单个汇率源：URL + 从 JSON 中提取 CNY 兑 USD 的路径 */
interface RateSource {
  name: string;
  url: string;
  /**
   * 从 JSON 中提取 USDT→CNY 汇率。
   * 返回 null 表示该响应不符合预期格式，跳到下一个源。
   */
  extract: (data: unknown) => number | null;
}

/** USDT≈USD，所以 USD→CNY 即 USDT→CNY。所有源都按 USD→CNY 报价 */
const SOURCES: RateSource[] = [
  {
    name: 'coingecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=cny',
    extract: (data) => {
      const d = data as { tether?: { cny?: number } } | null;
      const r = d?.tether?.cny;
      return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null;
    },
  },
  {
    name: 'open.er-api.com',
    // 该 API 返回 USD 作为基准，cny 即 1 USD = X CNY
    url: 'https://open.er-api.com/v6/latest/USD',
    extract: (data) => {
      const d = data as { result?: string; rates?: { CNY?: number } } | null;
      if (d?.result !== 'success') return null;
      const r = d.rates?.CNY;
      return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null;
    },
  },
  {
    name: 'frankfurter',
    url: 'https://api.frankfurter.app/latest?from=USD&to=CNY',
    extract: (data) => {
      const d = data as { rates?: { CNY?: number } } | null;
      const r = d?.rates?.CNY;
      return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null;
    },
  },
];

export interface FxResult {
  rate: number;
  /** 拿到该 rate 的来源名称（live / cache 时是源名；fallback 时是 'fallback'） */
  source: 'live' | 'cache' | 'fallback';
  /** 实际命中的源名（live 时才有值；fallback 时为 'fallback'） */
  origin?: string;
}

async function fetchFromSource(s: RateSource): Promise<number | null> {
  try {
    const cfg = getConfig();
    const res = await httpGet<unknown>(s.url, {
      timeoutMs: 10_000,
      retries: 1,
      headers: { 'User-Agent': cfg.ua },
      doh: null,
    });
    return s.extract(res.data);
  } catch {
    return null;
  }
}

/** 返回 USDT → CNY 实时汇率；主源失败自动降级到备用源；全部失败回落到 FALLBACK_USDT_TO_CNY */
export async function getUsdtToCnyRate(): Promise<FxResult> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { rate: cache.rate, source: 'cache' };
  }

  for (const s of SOURCES) {
    const rate = await fetchFromSource(s);
    if (rate !== null) {
      cache = { rate, fetchedAt: now };
      return { rate, source: 'live', origin: s.name };
    }
  }

  return { rate: FALLBACK_USDT_TO_CNY, source: 'fallback' };
}

/** 测试用：清缓存强制下次重新拉 */
export function _resetFxCache(): void {
  cache = null;
}
