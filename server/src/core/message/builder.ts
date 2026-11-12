import type { Coin } from '../models/coin.js';
import type { TrendAnalysis } from '../analysis/trend-report.js';
import type { IntradayAnalysis } from '../analysis/intraday.js';
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
  /** 日内交易分析（4h 方向 + 1h 箱体 / 指标） */
  intraday?: IntradayAnalysis | null;
  error?: string;
  source: 'gate' | 'stable' | 'failed';
}

/** 涨跌幅紧凑写法：+5.50% / -8.03% / N/A。 */
function formatTrend(trend: number | null): string {
  return trend === null ? 'N/A' : `${trend >= 0 ? '+' : ''}${trend.toFixed(2)}%`;
}

/** 美元价格：≥1 保留 2 位，小币最多 6 位。 */
function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(n) >= 1 ? 2 : 6,
  });
}

/** 均线上的美元价格：≥100 取整，≥1 保留 2 位，小币最多 6 位。 */
function fmtUsdShort(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 100) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

/** 人民币紧凑写法：亿 / 万，避免每行被长数字撑开；千位用逗号分隔。 */
function fmtCny(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  if (abs >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toPrecision(3);
}

/** 显示宽度：中文 / emoji 记 2 列，用于把长行折到手机一屏内。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  }
  return width;
}

/**
 * 把若干数据项用 ` · ` 拼接并按显示宽度折行。
 * 有标签时续行对齐到冒号后的内容起点（如 `涨跌：` → 9 空格），
 * 没有标签时续行缩进 5 空格，避免和新的数据行混淆。
 */
function wrapItems(items: string[], opts: { label?: string; maxWidth?: number } = {}): string {
  const maxWidth = opts.maxWidth ?? 52;
  const head = `   ${opts.label ? `${opts.label}：` : ''}`;
  const cont = opts.label ? ' '.repeat(3 + displayWidth(opts.label) + 2) : '     ';
  const lines: string[] = [];
  let line = head;
  for (const item of items) {
    if (line !== head && displayWidth(line) + 3 + displayWidth(item) > maxWidth) {
      lines.push(line);
      line = cont + item;
    } else {
      line += (line === head ? '' : ' · ') + item;
    }
  }
  lines.push(line);
  return `${lines.join('\n')}\n`;
}

/** 分区标题：左右各 4 段横线（宽度适配手机屏幕），把消息切成可扫读的区块。 */
function section(title: string): string {
  return `   ──── ${title} ────\n`;
}

/**
 * 均线紧凑写法：`7 < 75,122(¥53.3万)` —— 符号表示现价与均线的相对位置，
 * 读法与「现价 < MA7」一致：< = 现价在均线下方，> = 现价在均线上方，= = 持平。
 */
function formatMA(label: string, ma: number | null, current: number, rate: number): string {
  if (ma === null) return `${label} N/A`;
  const sign = current > ma ? '>' : current < ma ? '<' : '=';
  return `${label} ${sign} ${fmtUsdShort(ma)}(¥${fmtCny(ma * rate)})`;
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
    const { coin, ticker, indicators, analysis, intraday } = r;
    if (!ticker) {
      msg += `🔹 *${coin.name}* ${coin.symbol} · ⚠️ 数据获取失败\n\n`;
      continue;
    }
    const usd = Number(ticker.last);
    // 标题行：币名 + 现价 + 人民币（紧凑万/亿）+ 汇率，全部压到一行
    msg += `🔹 *${coin.name}* ${coin.symbol} · \`$${fmtUsd(usd)}(¥${fmtCny(usd * usdtToCny)} @${usdtToCny.toFixed(2)})\`\n`;
    if (indicators) {
      msg += section('📈 趋势');
      msg += wrapItems([
        `${formatTrend(indicators.trend7d)}(7d)`,
        `${formatTrend(indicators.trend30d)}(30d)`,
        `${formatTrend(indicators.trend90d)}(90d)`,
        `${formatTrend(indicators.trend180d)}(180d)`,
        `${formatTrend(indicators.trend1y)}(1y)`,
      ], { label: '涨跌' });
      const maItems = [
        formatMA('7', indicators.ma7, usd, usdtToCny),
        formatMA('30', indicators.ma30, usd, usdtToCny),
        formatMA('90', indicators.ma90, usd, usdtToCny),
        formatMA('180', indicators.ma180, usd, usdtToCny),
        formatMA('365', indicators.ma365, usd, usdtToCny),
      ];
      msg += wrapItems(maItems, { label: '均线' });
    } else {
      msg += section('📈 趋势') + '   涨跌：趋势数据暂时不可用\n';
    }
    // 日内在前（短线更先看到），趋势研判在后
    if (intraday) {
      msg += section('⚡ 日内');
      msg += `   ${intraday.headline}\n`;
      if (intraday.h4) msg += wrapItems(intraday.h4.split(' · '));
      if (intraday.h1) msg += wrapItems(intraday.h1.split(' · '));
      msg += `   💡 ${intraday.advice}\n`;
    }
    if (analysis) {
      // 周期研判：日/周/月/年各占一行（文本自带「日线：」等前缀），避免长句在手机上乱折行
      msg += section('🧭 周期研判');
      msg += `   ${analysis.daily}\n`;
      msg += `   ${analysis.weekly}\n`;
      msg += `   ${analysis.monthly}\n`;
      msg += `   ${analysis.yearly}\n`;
      // 四个周期的解读逐条展开，续行对齐到「解读：」之后
      const labels = ['日线', '周线', '月线', '年线'];
      const insights = [
        analysis.insights.daily,
        analysis.insights.weekly,
        analysis.insights.monthly,
        analysis.insights.yearly,
      ]
        .map((s, i) => (s ? `${labels[i]}·${s}` : ''))
        .filter(Boolean);
      if (insights.length) {
        msg += `   解读：${insights[0]}\n`;
        for (const insight of insights.slice(1)) msg += `         ${insight}\n`;
      }
      // 合约情绪 + 合约资金：每组数据按显示宽度折行，解读单独一行
      const sentimentData = analysis.sentiment.filter((l) => !l.startsWith('解读：'));
      const sentimentRead = analysis.sentiment.find((l) => l.startsWith('解读：'));
      if (sentimentData.length || analysis.futures.length || sentimentRead) {
        msg += section('📊 合约');
        if (sentimentData.length) msg += wrapItems(sentimentData);
        if (analysis.futures.length) msg += wrapItems(analysis.futures);
        if (sentimentRead) msg += `   解读：${sentimentRead.slice(3)}\n`;
      }
      // 结论 + 建议合并：`📌 … → 卖出`
      const action = analysis.advice.split(' —— ')[0] ?? analysis.advice;
      msg += section('📌 结论');
      msg += `   ${analysis.summary} → ${action}\n`;
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