import { initDb } from './core/db.js';
initDb('/tmp/probe_qnt.db');
const { getGateTicker } = await import('./core/gate/ticker.js');
const { getGateCandles, getGateCandlesByInterval } = await import('./core/gate/klines.js');
const { getGateDerivatives } = await import('./core/gate/futures.js');
const { analyzeTrend } = await import('./core/analysis/trend-report.js');
const { buildIndicators, buildMessage } = await import('./core/message/builder.js');
const pair = 'QNT_USDT';
const [ticker, candles, weekly, monthly] = await Promise.all([
  getGateTicker(pair), getGateCandles(pair, 365),
  getGateCandlesByInterval(pair, '7d', 120), getGateCandlesByInterval(pair, '30d', 60),
]);
const current = Number(ticker.last);
const indicators = buildIndicators(candles.map(c => c.close), current);
const derivatives = await getGateDerivatives(pair, 7);
const analysis = analyzeTrend({ current, candles, weekly, monthly, indicators, derivatives });
const coin = { id: 1, symbol: 'QNT', name: 'Quant', gate_pair: 'QNT_USDT', gate_slug: 'quant', binance_pair: 'QNT_USDT', cg_id: 'quant-network', sort_order: 0, enabled: 1, alert_above: null, alert_below: null, last_price: null, last_alert_at: 0, last_alert_dir: null, created_at: 0, updated_at: 0 } as any;
const msg = buildMessage([{ coin, ticker: { last: ticker.last }, indicators, analysis, source: 'gate' }], { usdtToCny: 6.67 });
console.log(msg);
console.log('\n[总长度]', msg.length);
