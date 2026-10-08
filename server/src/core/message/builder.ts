import type { Coin } from '../models/coin.js';
import { calculateMA } from '../indicators/ma.js';
import { calculateTrend } from '../indicators/trend.js';
import { getConfig } from '../config.js';
import { FALLBACK_USDT_TO_CNY } from '../gate/fx.js';

export interface CoinResult {
  coin: Coin;
  ticker: { last: string; change_percentage?: string } | null;
  indicators: {
    ma7: number | null;
    ma30: number | null;
    ma90: number | null;
    ma180: number | null;
    ma365: number | null;
    trend7d: number | null;
    trend30d: number | null;
    trend90d: number | null;
    trend180d: number | null;
    trend1y: number | null;
  } | null;
  error?: string;
  source: 'gate' | 'stable' | 'failed';
}

function formatTrend(trend: number | null): string {
  if (trend === null) return 'N/A';
  if (trend > 0) return `🔺 +${trend}%`;
  if (trend < 0) return `🔻 ${trend}%`;
  return `${trend}%`;
}

function formatMA(ma: number | null, current: number, usdtToCny: number): string {
  if (ma === null) return 'N/A';
  const ratio = current / ma;
  const cny = (ma * usdtToCny).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usdStr = `$${ma.toFixed(2)}`;
  const cnyStr = `¥${cny}`;
  if (ratio > 1.1) return `📈 ${usdStr} ${cnyStr} (偏高)`;
  if (ratio < 0.9) return `📉 ${usdStr} ${cnyStr} (偏低)`;
  return `➡️ ${usdStr} ${cnyStr}`;
}

export function buildMessage(results: CoinResult[], ctx?: { usdtToCny?: number; timezone?: string; now?: Date; trigger?: 'local' | 'ci'; fxSource?: 'live' | 'cache' | 'fallback' }): string {
  const cfg = getConfig();
  const usdtToCny = ctx?.usdtToCny ?? FALLBACK_USDT_TO_CNY;
  const timezone = ctx?.timezone ?? cfg.timezone;
  const now = ctx?.now ?? new Date();
  const trigger = ctx?.trigger ?? 'local';
  const fxSource = ctx?.fxSource;
  // fallback 时在标题末尾加标记，让用户知道人民币汇率不是实时的
  const fxMarker = fxSource === 'fallback' ? ' ⚠️汇率兜底' : '';
  let msg = `📊 *加密货币价格报告 (含技术指标) from ${trigger}${fxMarker}*\n\n`;
  for (const r of results) {
    const { coin, ticker, indicators } = r;
    if (!ticker) {
      msg += `🔹 *${coin.name}* (${coin.symbol})\n   ⚠️ 数据获取失败\n\n`;
      continue;
    }
    const usd = Number(ticker.last);
    const cny = (usd * usdtToCny).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    msg += `🔹 *${coin.name}* (${coin.symbol})\n`;
    msg += `   💰 人民币：\`¥${cny}(${usdtToCny.toFixed(2)})\`\n`;
    msg += `   💵 美元：\`$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}\`\n`;
    if (indicators) {
      msg += `   ──────── 📈 趋势分析 ────────\n`;
      msg += `   📅 7天:   ${formatTrend(indicators.trend7d)}    📅 30天:  ${formatTrend(indicators.trend30d)}\n`;
      msg += `   📅 90天:  ${formatTrend(indicators.trend90d)}   📅 180天: ${formatTrend(indicators.trend180d)}\n`;
      msg += `   📅 1年:   ${formatTrend(indicators.trend1y)}\n`;
      msg += `   ──────── 📊 均线 (MA) ────────\n`;
      msg += `   MA7:   ${formatMA(indicators.ma7, usd, usdtToCny)}\n`;
      msg += `   MA30:  ${formatMA(indicators.ma30, usd, usdtToCny)}\n`;
      msg += `   MA90:  ${formatMA(indicators.ma90, usd, usdtToCny)}\n`;
      msg += `   MA180: ${formatMA(indicators.ma180, usd, usdtToCny)}\n`;
      msg += `   MA365: ${formatMA(indicators.ma365, usd, usdtToCny)}\n`;
    } else {
      msg += `   📈 趋势数据暂时不可用\n`;
    }
    const { gate: gateUrl, binance: binanceUrl, coingecko: cgUrl } = buildCoinLinks(coin);
    const links: string[] = [`[Gate](${gateUrl})`];
    if (binanceUrl) links.push(`[Binance](${binanceUrl})`);
    links.push(`[CoinGecko](${cgUrl})`);
    msg += `   🔗 ${links.join(' | ')}\n\n`;
  }
  msg += `⏰ 更新时间: ${now.toLocaleString('zh-CN', { timeZone: timezone })}`;
  msg += `\n⚠️ MA（移动平均线）仅供参考，不构成投资建议`;
  msg += `\n数据展示以 CoinGecko 数据为准`;
  return msg;
}

/** 内部：把 closes 数组转 indicators */
export function buildIndicators(closes: number[], currentPrice: number) {
  return {
    ma7:   calculateMA(closes, 7),
    ma30:  calculateMA(closes, 30),
    ma90:  calculateMA(closes, 90),
    ma180: calculateMA(closes, 180),
    ma365: calculateMA(closes, 365),
    trend7d:   calculateTrend(currentPrice, closes.length >= 7   ? closes[closes.length - 8]   : null),
    trend30d:  calculateTrend(currentPrice, closes.length >= 30  ? closes[closes.length - 31]  : null),
    trend90d:  calculateTrend(currentPrice, closes.length >= 90  ? closes[closes.length - 91]  : null),
    trend180d: calculateTrend(currentPrice, closes.length >= 180 ? closes[closes.length - 181] : null),
    trend1y:   calculateTrend(currentPrice, closes.length >= 365 ? closes[0]                  : null),
  };
}

/**
 * 生成单个币种的外部链接（Gate / Binance / CoinGecko）。
 * 抽出来便于测试 URL 形态；URL 改了/挂了就立刻在 build/test 时炸出来。
 */
export function buildCoinLinks(coin: Coin): { gate: string; binance: string | null; coingecko: string } {
  // gate.com 实际路径格式：`{name-slug}-{symbol}`，例如 bitcoin-btc / cosmos-hub-atom。
  // 没有 gate_slug 的旧数据回退到 symbol（小写）。
  const slug = (coin.gate_slug && coin.gate_slug.trim())
    ? coin.gate_slug.toLowerCase()
    : coin.symbol.toLowerCase();
  const gate = `https://www.gate.com/zh/price/${slug}-${coin.symbol.toLowerCase()}`;
  // 币安价格页 URL：`https://www.binance.com/zh-CN/price/{slug}/`。
  // binance_slug 为 NULL 时（币安未上架，例如 GT）返回 null，调用方负责跳过展示。
  const binanceSlug = (coin.binance_slug && coin.binance_slug.trim()) ? coin.binance_slug.trim() : null;
  const binance = binanceSlug ? `https://www.binance.com/zh-CN/price/${binanceSlug}/` : null;
  const coingecko = `https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/${encodeURIComponent(coin.cg_id)}`;
  return { gate, binance, coingecko };
}