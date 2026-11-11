import { httpGet } from '../../util/http.js';
import { getConfig } from '../config.js';

type GateKline = [
  // [timestamp_seconds, volume(quote), close, high, low, amount(base), ...]
  number | string,
  string,
  string,
  string,
  string,
  string,
  ...unknown[]
];

/** 一根日线。volume 用基础币计量的成交量（同一币种跨时间可比，不受币价涨跌影响）。 */
export interface GateCandle {
  ts: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

/**
 * Gate 现货 K 线支持的区间。
 * Gate 用 `7d` / `30d` 表示周线 / 月线（没有 1w / 1M / 1Y），年线只能由月线聚合。
 */
export type GateInterval = '1d' | '7d' | '30d';

/**
 * 按指定区间获取 K 线（按时间升序）。
 * 最后一根永远是「当前周期」（进行中，收盘价 ≈ 当前价）。
 */
export async function getGateCandlesByInterval(
  pair: string,
  interval: GateInterval,
  limit: number,
): Promise<GateCandle[]> {
  const cfg = getConfig();
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${encodeURIComponent(pair)}&interval=${interval}&limit=${limit}`;
  const res = await httpGet<GateKline[]>(url, {
    timeoutMs: cfg.request_timeout_ms,
    retries: cfg.max_retries,
    headers: { 'User-Agent': cfg.ua },
    doh: cfg.doh_enabled ? { endpoint: `https://${cfg.doh_server}/dns-query`, bypass: new Set(cfg.doh_bypass) } : null,
  });
  if (!Array.isArray(res.data)) {
    throw new Error(`Gate.io klines invalid: ${pair}`);
  }
  const candles: GateCandle[] = [];
  for (const row of res.data) {
    const close = Number(row[2]);
    const high = Number(row[3]);
    const low = Number(row[4]);
    const volume = Number(row[5]);
    if (!Number.isFinite(close)) continue;
    candles.push({
      ts: Number(row[0]),
      close,
      high: Number.isFinite(high) ? high : close,
      low: Number.isFinite(low) ? low : close,
      volume: Number.isFinite(volume) ? volume : 0,
    });
  }
  return candles;
}

/**
 * 获取最近 N 天日线（按时间升序）。
 * 最后一根是「今天」（日内进行中，收盘价 ≈ 当前价），倒数第二根是昨天。
 */
export async function getGateCandles(pair: string, days = 365): Promise<GateCandle[]> {
  return getGateCandlesByInterval(pair, '1d', days);
}

/**
 * 获取最近 N 天日线收盘价数组（按时间升序）。
 */
export async function getGateKlines(pair: string, days = 365): Promise<number[]> {
  const candles = await getGateCandles(pair, days);
  return candles.map((c) => c.close);
}
