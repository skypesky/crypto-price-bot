import type { Coin } from '../models/coin.js';
import { calculateMA } from '../indicators/ma.js';
import { calculateTrend } from '../indicators/trend.js';
import { getConfig } from '../config.js';

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

function formatMA(ma: number | null, current: number): string {
  if (ma === null) return 'N/A';
  const ratio = current / ma;
  if (ratio > 1.1) return `📈 $${ma.toFixed(2)} (偏高)`;
  if (ratio < 0.9) return `📉 $${ma.toFixed(2)} (偏低)`;
  return `➡️ $${ma.toFixed(2)}`;
}

export function buildMessage(results: CoinResult[], ctx?: { usdtToCny?: number; timezone?: string; now?: Date }): string {
  const cfg = getConfig();
  const usdtToCny = ctx?.usdtToCny ?? cfg.usdt_to_cny;
  const timezone = ctx?.timezone ?? cfg.timezone;
  const now = ctx?.now ?? new Date();
  let msg = '📊 *加密货币价格报告 (含技术指标)*\n\n';
  for (const r of results) {
    const { coin, ticker, indicators } = r;
    if (!ticker) {
      msg += `🔹 *${coin.name}* (${coin.symbol})\n   ⚠️ 数据获取失败\n\n`;
      continue;
    }
    const usd = Number(ticker.last);
    const cny = (usd * usdtToCny).toLocaleString('zh-CN', { minimumFractionDigits: 2 });
    msg += `🔹 *${coin.name}* (${coin.symbol})\n`;
    msg += `   💰 人民币：\`¥${cny}\`\n`;
    msg += `   💵 美元：\`$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}\`\n`;
    if (indicators) {
      msg += `   ──────── 📈 趋势分析 ────────\n`;
      msg += `   📅 7天:   ${formatTrend(indicators.trend7d)}    📅 30天:  ${formatTrend(indicators.trend30d)}\n`;
      msg += `   📅 90天:  ${formatTrend(indicators.trend90d)}   📅 180天: ${formatTrend(indicators.trend180d)}\n`;
      msg += `   📅 1年:   ${formatTrend(indicators.trend1y)}\n`;
      msg += `   ──────── 📊 均线 (MA) ────────\n`;
      msg += `   MA7:   ${formatMA(indicators.ma7, usd)}\n`;
      msg += `   MA30:  ${formatMA(indicators.ma30, usd)}\n`;
      msg += `   MA90:  ${formatMA(indicators.ma90, usd)}\n`;
      msg += `   MA180: ${formatMA(indicators.ma180, usd)}\n`;
      msg += `   MA365: ${formatMA(indicators.ma365, usd)}\n`;
    } else {
      msg += `   📈 趋势数据暂时不可用\n`;
    }
    const cgUrl = `https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/${encodeURIComponent(coin.cg_id)}`;
    const gatePair = coin.gate_pair ? coin.gate_pair.replace('_', '-').toLowerCase() : coin.symbol.toLowerCase();
    const gateUrl = `https://www.gate.com/zh/price/${gatePair}`;
    msg += `   🔗 [Gate](${gateUrl}) | [CoinGecko](${cgUrl})\n\n`;
  }
  msg += `⏰ 更新时间: ${now.toLocaleString('zh-CN', { timeZone: timezone })}`;
  msg += `\n⚠️ MA（移动平均线）仅供参考，不构成投资建议`;
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