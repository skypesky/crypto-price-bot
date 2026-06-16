import { httpGet } from '../../util/http.js';
import { getConfig } from '../config.js';

type GateKline = [
  // [timestamp_seconds, volume, close, high, low, amount, ...]
  number | string,
  string,
  string,
  string,
  string,
  string,
  ...unknown[]
];

/**
 * 获取最近 N 天日线收盘价数组（按时间升序）。
 */
export async function getGateKlines(pair: string, days = 365): Promise<number[]> {
  const cfg = getConfig();
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${encodeURIComponent(pair)}&interval=1d&limit=${days}`;
  const res = await httpGet<GateKline[]>(url, {
    timeoutMs: cfg.request_timeout_ms,
    retries: cfg.max_retries,
    headers: { 'User-Agent': cfg.ua },
    doh: cfg.doh_enabled ? { endpoint: `https://${cfg.doh_server}/dns-query`, bypass: new Set(cfg.doh_bypass) } : null,
  });
  if (!Array.isArray(res.data)) {
    throw new Error(`Gate.io klines invalid: ${pair}`);
  }
  // Gate.io 返回顺序：从新到旧。我们需要从旧到新（升序）。
  const closes = res.data.map((row) => Number(row[2])).filter((n) => Number.isFinite(n));
  closes.reverse();
  return closes;
}