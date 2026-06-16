import { httpGet } from '../../util/http.js';
import { getConfig } from '../config.js';

export interface GateTicker {
  currency_pair: string;
  last: string;
  lowest_ask?: string;
  highest_bid?: string;
  change_percentage?: string;
  base_volume?: string;
  quote_volume?: string;
  high_24h?: string;
  low_24h?: string;
}

export async function getGateTicker(pair: string): Promise<GateTicker> {
  const cfg = getConfig();
  const url = `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${encodeURIComponent(pair)}`;
  const res = await httpGet<GateTicker[]>(url, {
    timeoutMs: cfg.request_timeout_ms,
    retries: cfg.max_retries,
    headers: { 'User-Agent': cfg.ua },
    doh: cfg.doh_enabled ? { endpoint: `https://${cfg.doh_server}/dns-query`, bypass: new Set(cfg.doh_bypass) } : null,
  });
  if (!Array.isArray(res.data) || res.data.length === 0) {
    throw new Error(`Gate.io ticker empty: ${pair}`);
  }
  return res.data[0]!;
}