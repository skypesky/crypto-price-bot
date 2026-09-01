import { getGateTicker } from './gate/ticker.js';
import { getGateKlines } from './gate/klines.js';
import { getUsdtToCnyRate } from './gate/fx.js';
import { buildIndicators, buildMessage, type CoinResult } from './message/builder.js';
import { sendToTG } from './notify/telegram.js';
import { sendToFeishu } from './notify/feishu.js';
import { listEnabledCoins, updateCoin } from './models/coin.js';
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

  // 价格预警 edge-crossing 检测（在主推送之后跑，避免在主流程报错时丢失提醒）
  // 语义：每个币只在「上次价 < above ≤ 当前价」（上穿）或「上次价 > below ≥ 当前价」（下穿）时各发一次飞书；
  // 同方向在 alert_cooldown_hours（默认 24h）内 dedup。改阈值会自动清冷却（API 层处理）。
  try {
    await runPriceAlerts(results, cfg);
  } catch (err) {
    log.warn(`price alert pipeline failed: ${(err as Error).message}`);
  }

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

/** 检测每个币是否穿越阈值并按需发送飞书提醒（独立于主报表推送） */
async function runPriceAlerts(results: CoinResult[], cfg: { alert_cooldown_hours: number; timezone: string }): Promise<void> {
  const cooldownMs = cfg.alert_cooldown_hours * 3600 * 1000;
  const nowMs = Date.now();
  const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
  const dirCN: Record<'above' | 'below', string> = { above: '突破上限', below: '跌破下限' };
  const dirArrow: Record<'above' | 'below', string> = { above: '🔺', below: '🔻' };

  const msgs: string[] = [];
  for (const r of results) {
    const coin = r.coin;
    // 数据获取失败：last_price 不更新（避免"看门失效"导致误判 spike）
    if (!r.ticker) continue;
    const cur = Number(r.ticker.last);
    if (!Number.isFinite(cur)) continue;

    // 首次运行：只记录 last_price，不发提醒（无"穿越"语义）
    if (coin.last_price === null) {
      updateCoin(coin.id, { last_price: cur });
      continue;
    }

    const prev = coin.last_price;
    let fireDir: 'above' | 'below' | null = null;
    let threshold = 0;
    if (coin.alert_above !== null && prev < coin.alert_above && cur >= coin.alert_above) {
      fireDir = 'above';
      threshold = coin.alert_above;
    } else if (coin.alert_below !== null && prev > coin.alert_below && cur <= coin.alert_below) {
      fireDir = 'below';
      threshold = coin.alert_below;
    }

    const inCooldown = fireDir !== null
      && coin.last_alert_at > 0
      && coin.last_alert_dir === fireDir
      && (nowMs - coin.last_alert_at) < cooldownMs;

    if (fireDir && !inCooldown) {
      const lines = [
        `🚨 价格预警`,
        ``,
        `${dirArrow[fireDir]} ${coin.name} (${coin.symbol}) ${dirCN[fireDir]}`,
        `当前价：${usd(cur)}`,
        `阈值：${usd(threshold)}`,
        `上次价：${usd(prev)}`,
        `时间：${new Date(nowMs).toLocaleString('zh-CN', { timeZone: cfg.timezone })}`,
      ];
      msgs.push(lines.join('\n'));
      updateCoin(coin.id, { last_price: cur, last_alert_at: nowMs, last_alert_dir: fireDir });
      log.info(`alert fired: ${coin.symbol} ${fireDir} prev=${prev} cur=${cur} threshold=${threshold}`);
    } else {
      updateCoin(coin.id, { last_price: cur });
    }
  }

  for (const m of msgs) {
    try {
      const res = await sendToFeishu(m);
      if (!res.ok) log.warn(`alert feishu failed: ${res.error ?? 'unknown'}`);
    } catch (err) {
      log.warn(`alert feishu threw: ${(err as Error).message}`);
    }
  }
  if (msgs.length > 0) log.info(`alerts: ${msgs.length} sent`);
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