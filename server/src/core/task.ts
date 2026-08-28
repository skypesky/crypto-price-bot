import { getGateTicker } from './gate/ticker.js';
import { getGateKlines } from './gate/klines.js';
import { getUsdtToCnyRate } from './gate/fx.js';
import { buildIndicators, buildMessage, type CoinResult } from './message/builder.js';
import { sendToTG } from './notify/telegram.js';
import { sendToFeishu } from './notify/feishu.js';
import { listEnabledCoins } from './models/coin.js';
import { createReport } from './models/report.js';
import { getConfig } from './config.js';
import { createLogger } from '../util/logger.js';
import type { Coin } from './models/coin.js';

const log = createLogger({ isTTY: false }).child('task');

export interface TaskRunResult {
  reportId: number;
  triggered_by: string;
  success: boolean;
  totalCoins: number;
  okCoins: number;
  tgSent: boolean;
  feishuSent: boolean;
  message: string;
}

async function fetchOne(coin: Coin): Promise<CoinResult> {
  if (!coin.gate_pair) {
    return { coin, ticker: { last: '1.0' }, indicators: null, source: 'stable' };
  }
  try {
    const [ticker, closes] = await Promise.all([
      getGateTicker(coin.gate_pair),
      getGateKlines(coin.gate_pair, 365),
    ]);
    const currentPrice = Number(ticker.last);
    return {
      coin,
      ticker: { last: ticker.last, change_percentage: ticker.change_percentage },
      indicators: buildIndicators(closes, currentPrice),
      source: 'gate',
    };
  } catch (err) {
    log.warn(`${coin.symbol} gate.io failed: ${(err as Error).message}`);
    return {
      coin,
      ticker: null,
      indicators: null,
      source: 'failed',
      error: (err as Error).message,
    };
  }
}

export async function runTask(triggeredBy: 'cron' | 'manual' | 'test' | 'resend' = 'manual'): Promise<TaskRunResult> {
  const cfg = getConfig();
  log.info(`runTask start: triggered_by=${triggeredBy}`);

  const coins = listEnabledCoins();
  const results: CoinResult[] = await Promise.all(coins.map(fetchOne));
  const okCount = results.filter(r => r.ticker !== null).length;
  const success = okCount > 0;

  // 实时汇率（带 1h 缓存，失败回落到 settings.usdt_to_cny）
  const fx = await getUsdtToCnyRate();
  log.info(`usdt→cny rate: ${fx.rate} (${fx.source})`);

  // 通过 GITHUB_ACTIONS 区分本地 / CI，标签会展示在报告标题里
  const trigger: 'local' | 'ci' = process.env['GITHUB_ACTIONS'] === 'true' ? 'ci' : 'local';
  const message = buildMessage(results, { usdtToCny: fx.rate, trigger });
  log.info(`results: ${okCount}/${coins.length} ok`);

  // 并行推送
  const [tgRes, feishuRes] = await Promise.all([
    sendToTG(message).catch((e) => ({ ok: false, error: (e as Error).message })),
    sendToFeishu(message).catch((e) => ({ ok: false, error: (e as Error).message })),
  ]);

  if (!tgRes.ok) log.warn(`telegram failed: ${tgRes.error ?? 'unknown'}`);
  if (!feishuRes.ok) log.warn(`feishu failed: ${feishuRes.error ?? 'unknown'}`);

  const summary = {
    triggered_by: triggeredBy,
    total_coins: coins.length,
    ok_coins: okCount,
    tg: tgRes.ok,
    feishu: feishuRes.ok,
    coins: results.map(r => ({ symbol: r.coin.symbol, ok: r.ticker !== null, error: r.error })),
  };

  const report = createReport({
    triggered_by: triggeredBy,
    success,
    total_coins: coins.length,
    ok_coins: okCount,
    tg_sent: tgRes.ok,
    feishu_sent: feishuRes.ok,
    message,
    summary,
  });

  log.info(`runTask done: reportId=${report.id}`);

  return {
    reportId: report.id,
    triggered_by: triggeredBy,
    success,
    totalCoins: coins.length,
    okCoins: okCount,
    tgSent: tgRes.ok,
    feishuSent: feishuRes.ok,
    message,
  };
}

/** 仅重发已有 message，不重跑数据 */
export async function resendReport(message: string, channels: Array<'tg' | 'feishu'>): Promise<{ tg: boolean; feishu: boolean }> {
  const out = { tg: false, feishu: false };
  if (channels.includes('tg')) {
    const r = await sendToTG(message);
    out.tg = r.ok;
  }
  if (channels.includes('feishu')) {
    const r = await sendToFeishu(message);
    out.feishu = r.ok;
  }
  return out;
}