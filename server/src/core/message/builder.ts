import type { Coin } from '../models/coin.js';
import type { TrendAnalysis } from '../analysis/trend-report.js';
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
  /** 趋势研判（短线/中线/长线 + 合约情绪与结论） */
  analysis?: TrendAnalysis | null;
  error?: string;
  source: 'gate' | 'stable' | 'failed';
}

function formatTrend(trend: number | null): string {
  if (trend === null) return 'N/A';
  if (trend > 0) return `🔺 +${trend}%`;
  if (trend < 0) return `🔻 ${trend}%`;
  return `${trend}%`;
}

/**
 * 均线行：`MA7:  < $75,076.36(¥500,008.54)` —— 前缀符号表示现价与均线的相对位置，
 * 读法与「现价 < MA7」一致：< = 现价在均线下方，> = 现价在均线上方，= = 持平。
 */
function formatMA(ma: number | null, current: number, usdtToCny: number): string {
  if (ma === null) return 'N/A';
  const cny = (ma * usdtToCny).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const price = `$${ma.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}(¥${cny})`;
  const sign = current > ma ? '>' : current < ma ? '<' : '=';
  return `${sign} ${price}`;
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
    const { coin, ticker, indicators, analysis } = r;
    if (!ticker) {
      msg += `🔹 *${coin.name}* (${coin.symbol})\n   ⚠️ 数据获取失败\n\n`;
      continue;
    }
    const usd = Number(ticker.last);
    const cny = (usd * usdtToCny).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const usdStr = usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
    msg += `🔹 *${coin.name}* (${coin.symbol})\n`;
    // 美元在前、人民币括注，汇率显式标注：`$71.96(¥479.97)[汇率: 6.67]`
    msg += `   💵 \`$${usdStr}(¥${cny})[汇率: ${usdtToCny.toFixed(2)}]\`\n`;
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
    if (analysis) {
      msg += `   ──────── 🧭 趋势研判 ────────\n`;
      const periodLines: Array<[string, string]> = [
        [analysis.daily, analysis.insights.daily],
        [analysis.weekly, analysis.insights.weekly],
        [analysis.monthly, analysis.insights.monthly],
        [analysis.yearly, analysis.insights.yearly],
      ];
      for (const [line, insight] of periodLines) {
        msg += `   ${line}\n`;
        if (insight) msg += `   解读：${insight}\n`;
      }
      if (analysis.sentiment.length) {
        msg += `   ──────── 📊 合约情绪 ────────\n`;
        for (const line of analysis.sentiment) msg += `   ${line}\n`;
      }
      if (analysis.futures.length) {
        msg += `   ──────── 💰 合约资金 ────────\n`;
        for (const line of analysis.futures) msg += `   ${line}\n`;
      }
      msg += `   ──────── 📌 结论 ────────\n`;
      msg += `   ${analysis.summary}\n`;
      msg += `   💡 操作建议：${analysis.advice}\n`;
    }
    const { gate: gateUrl, binance: binanceUrl, coinglass: cgGlassUrl, coingecko: cgUrl } = buildCoinLinks(coin);
    const links: string[] = [`[Gate](${gateUrl})`];
    if (binanceUrl) links.push(`[Binance](${binanceUrl})`);
    links.push(`[CoinGlass](${cgGlassUrl})`);
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
 * 生成单个币种的外部链接（Gate / Binance / CoinGlass / CoinGecko）。
 * 抽出来便于测试 URL 形态；URL 改了/挂了就立刻在 build/test 时炸出来。
 */
export function buildCoinLinks(coin: Coin): { gate: string; binance: string | null; coinglass: string; coingecko: string } {
  // Gate 现货交易页：`https://www.gate.com/zh/trade/{交易对}`，例如 BTC_USDT。
  // 稳定币没有对应的现货市场（gate_pair 为空），回退到 Gate 价格页
  // （`https://www.gate.com/zh/price/{name-slug}-{symbol}`，例如 tether-usdt）。
  const gatePair = (coin.gate_pair && coin.gate_pair.trim()) ? coin.gate_pair.trim() : null;
  // 没有 gate_slug 的旧数据回退到 symbol（小写）。
  const slug = (coin.gate_slug && coin.gate_slug.trim())
    ? coin.gate_slug.toLowerCase()
    : coin.symbol.toLowerCase();
  const gate = gatePair
    ? `https://www.gate.com/zh/trade/${gatePair}`
    : `https://www.gate.com/zh/price/${slug}-${coin.symbol.toLowerCase()}`;
  // 币安现货交易页：`https://www.binance.com/zh-CN/trade/{交易对}?type=spot`。
  // binance_pair 为 NULL 时（币安现货没这个交易对，例如 ABT / GT / USDT）返回 null，调用方负责跳过展示。
  const binancePair = (coin.binance_pair && coin.binance_pair.trim()) ? coin.binance_pair.trim() : null;
  const binance = binancePair ? `https://www.binance.com/zh-CN/trade/${binancePair}?type=spot` : null;
  // CoinGlass 币种页：`https://www.coinglass.com/zh/currencies/{SYMBOL}`，slug 就是币种 symbol。
  const coinglass = `https://www.coinglass.com/zh/currencies/${coin.symbol.toUpperCase()}`;
  const coingecko = `https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/${encodeURIComponent(coin.cg_id)}`;
  return { gate, binance, coinglass, coingecko };
}