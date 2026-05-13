require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');

// 核心配置
const CONFIG = {
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN,
  TG_CHAT_ID: process.env.TG_CHAT_ID,
  FEISHU_WEBHOOK_URL: process.env.FEISHU_WEBHOOK_URL,
  TIMEZONE: process.env.TIMEZONE || 'Asia/Shanghai',
  USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  CRYPTO_LIST: [
    { id: 'bitcoin', symbol: 'BTC', name: '比特币' },
    { id: 'ethereum', symbol: 'ETH', name: '以太坊' },
    { id: 'tether', symbol: 'USDT', name: '泰达币' },
    { id: 'solana', symbol: 'SOL', name: '索拉纳' },
    { id: 'arcblock', symbol: 'ABT', name: '区块基石' },
    { id: 'binancecoin', symbol: 'BNB', name: '币安币', gateSlug: 'bnb-bnb' },
    { id: 'icon', symbol: 'ICX', name: 'ICON' },
    { id: 'filecoin', symbol: 'FIL', name: '文件币', gateSlug: 'filecoin(ipfs)-fil' },
    { id: 'cosmos', symbol: 'ATOM', name: '阿童木', gateSlug: 'cosmos-hub-atom' },
    { id: 'optimism', symbol: 'OP', name: 'Optimism' },
    { id: 'gatechain-token', symbol: 'GT', name: 'Gate', gateSlug: 'gate-gt' },
  ],
  SCHEDULE_RULE: '0 0 9 * * *'
};

if (!CONFIG.TG_BOT_TOKEN || !CONFIG.TG_CHAT_ID || CONFIG.TG_BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error('❌ 错误：请在 .env 文件中配置有效的 TG_BOT_TOKEN 和 TG_CHAT_ID');
  process.exit(1);
}

const tgBot = new TelegramBot(CONFIG.TG_BOT_TOKEN, { polling: false });

/**
 * 计算移动平均线
 */
function calculateMA(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

/**
 * 计算趋势百分比
 */
function calculateTrend(currentPrice, pastPrice) {
  if (!pastPrice || pastPrice === 0) return null;
  return ((currentPrice - pastPrice) / pastPrice * 100).toFixed(2);
}

/**
 * 获取单币种历史数据并计算指标
 */
async function getCryptoWithIndicators(coinId) {
  try {
    // 获取365天历史数据（CoinGecko免费API最大支持）
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=365`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Accept': 'application/json'
      }
    });

    const prices = response.data.prices.map(p => p[1]);
    const currentPrice = prices[prices.length - 1];

    // 计算各周期MA
    const ma7 = calculateMA(prices, 7);
    const ma30 = calculateMA(prices, 30);
    const ma90 = calculateMA(prices, 90);
    const ma180 = calculateMA(prices, 180);
    const ma365 = calculateMA(prices, 365);

    // 计算趋势（相对于不同周期的价格）
    const price7d = prices.length >= 7 ? prices[prices.length - 8] : null;
    const price30d = prices.length >= 30 ? prices[prices.length - 31] : null;
    const price90d = prices.length >= 90 ? prices[prices.length - 91] : null;
    const price180d = prices.length >= 180 ? prices[prices.length - 181] : null;
    const price1y = prices.length >= 365 ? prices[0] : null;

    return {
      currentPrice,
      ma7,
      ma30,
      ma90,
      ma180,
      ma365,
      trend7d: calculateTrend(currentPrice, price7d),
      trend30d: calculateTrend(currentPrice, price30d),
      trend90d: calculateTrend(currentPrice, price90d),
      trend180d: calculateTrend(currentPrice, price180d),
      trend1y: calculateTrend(currentPrice, price1y),
    };
  } catch (err) {
    console.error(`获取 ${coinId} 历史数据失败:`, err.message);
    return null;
  }
}

/**
 * 格式化趋势箭头和颜色
 */
function formatTrend(trend) {
  if (trend === null) return 'N/A';
  const num = parseFloat(trend);
  if (num > 0) return `🔺 +${num}%`;
  if (num < 0) return `🔻 ${num}%`;
  return `${num}%`;
}

/**
 * 格式化MA
 */
function formatMA(ma, currentPrice) {
  if (ma === null) return 'N/A';
  const ratio = currentPrice / ma;
  if (ratio > 1.1) return `📈 MA: $${ma.toFixed(2)} (偏高)`;
  if (ratio < 0.9) return `📉 MA: $${ma.toFixed(2)} (偏低)`;
  return `➡️ MA: $${ma.toFixed(2)}`;
}

/**
 * 获取加密货币价格并格式化消息（带指标）
 */
async function getCryptoPricesWithIndicators() {
  try {
    console.log('正在从 CoinGecko 获取价格和指标...');

    // 先获取实时价格
    const ids = CONFIG.CRYPTO_LIST.map(item => item.id).join(',');
    const priceUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=cny,usd`;
    const priceResponse = await axios.get(priceUrl, {
      headers: { 'User-Agent': CONFIG.USER_AGENT, 'Accept': 'application/json' }
    });
    const priceData = priceResponse.data;

    let msg = '📊 *加密货币价格报告 (含技术指标)*\n\n';

    // 获取每个币种的历史数据
    for (const item of CONFIG.CRYPTO_LIST) {
      const price = priceData[item.id];
      if (!price) {
        msg += `⚠️ 无法获取 ${item.name} 的价格\n\n`;
        continue;
      }

      // 获取指标
      const indicators = await getCryptoWithIndicators(item.id);

      const gateSlug = item.gateSlug || `${item.id}-${item.symbol.toLowerCase()}`;
      const gateUrl = `https://www.gate.com/zh/price/${gateSlug}`;
      const cgUrl = `https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/${encodeURIComponent(item.id)}`;

      msg += `🔹 *${item.name}* (${item.symbol})\n`;
      msg += `   💰 人民币：\`¥${price.cny.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}\`\n`;
      msg += `   💵 美元：\`$${price.usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}\`\n`;

      if (indicators) {
        msg += `   ──────── 📈 趋势分析 ────────\n`;
        msg += `   📅 7天趋势: ${formatTrend(indicators.trend7d)}\n`;
        msg += `   📅 30天趋势: ${formatTrend(indicators.trend30d)}\n`;
        msg += `   📅 90天趋势: ${formatTrend(indicators.trend90d)}\n`;
        msg += `   📅 180天趋势: ${formatTrend(indicators.trend180d)}\n`;
        msg += `   📅 1年趋势: ${formatTrend(indicators.trend1y)}\n`;

        msg += `   ──────── 📊 均线 (MA) ────────\n`;
        msg += `   MA7: ${indicators.ma7 ? '$' + indicators.ma7.toFixed(2) : 'N/A'}\n`;
        msg += `   MA30: ${indicators.ma30 ? '$' + indicators.ma30.toFixed(2) : 'N/A'}\n`;
        msg += `   MA90: ${indicators.ma90 ? '$' + indicators.ma90.toFixed(2) : 'N/A'}\n`;
        msg += `   MA180: ${indicators.ma180 ? '$' + indicators.ma180.toFixed(2) : 'N/A'}\n`;
        msg += `   MA365: ${indicators.ma365 ? '$' + indicators.ma365.toFixed(2) : 'N/A'}\n`;
      } else {
        msg += `   📈 趋势数据暂时不可用\n`;
      }

      msg += `   🔗 [Gate](${gateUrl}) | [CoinGecko](${cgUrl})\n\n`;

      // 添加延迟避免API限流
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    msg += `⏰ 更新时间: ${new Date().toLocaleString('zh-CN', { timeZone: CONFIG.TIMEZONE })}`;
    msg += `\n⚠️ MA（移动平均线）仅供参考，不构成投资建议`;
    return msg;
  } catch (err) {
    console.error('获取价格失败：', err.message);
    if (err.response) {
      console.error(`状态码: ${err.response.status}`);
      console.error(`返回数据:`, err.response.data);
    }
    return `❌ 获取价格失败：${err.message}`;
  }
}

/**
 * 发送消息到TG
 */
async function sendToTG(message) {
  try {
    await tgBot.sendMessage(CONFIG.TG_CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log('✅ 消息发送成功');
  } catch (err) {
    console.error('❌ TG发送失败：', err);
    if (err.response && err.response.statusCode === 401) {
      console.error('   提示：请检查 TG_BOT_TOKEN 是否正确');
    }
  }
}

function normalizeMessageForTextChannel(message) {
  return String(message)
    .replace(/\r\n/g, '\n')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2')
    .replace(/[*_`]/g, '');
}

async function sendToFeishu(message) {
  if (!CONFIG.FEISHU_WEBHOOK_URL) return;
  try {
    const text = normalizeMessageForTextChannel(message);
    await axios.post(
      CONFIG.FEISHU_WEBHOOK_URL,
      { msg_type: 'text', content: { text } },
      { headers: { 'Content-Type': 'application/json', 'User-Agent': CONFIG.USER_AGENT } }
    );
    console.log('✅ 飞书消息发送成功');
  } catch (err) {
    console.error('❌ 飞书发送失败：', err.message);
    if (err.response) {
      console.error(`状态码: ${err.response.status}`);
      console.error('返回数据:', err.response.data);
    }
  }
}

/**
 * 主任务
 */
async function mainTask() {
  console.log(`[${new Date().toLocaleString('zh-CN', { timeZone: CONFIG.TIMEZONE })}] 开始执行价格查询任务...`);
  const priceMsg = await getCryptoPricesWithIndicators();
  await sendToTG(priceMsg);
  await sendToFeishu(priceMsg);
}

if (process.env.GITHUB_ACTIONS === 'true') {
  console.log('检测到 GitHub Actions 环境，执行单次任务...');
  mainTask().then(() => {
    console.log('✅ 任务执行完毕，正在退出...');
    setTimeout(() => process.exit(0), 5000);
  }).catch(err => {
    console.error('❌ 任务执行失败:', err);
    process.exit(1);
  });
} else {
  mainTask();

  schedule.scheduleJob(CONFIG.SCHEDULE_RULE, () => {
    console.log('定时任务触发');
    mainTask();
  });

  console.log(`🚀 机器人已启动！`);
  console.log(`📅 定时规则: ${CONFIG.SCHEDULE_RULE} (每天 ${CONFIG.SCHEDULE_RULE.split(' ')[2]} 点)`);
  console.log(`📝 监控币种: ${CONFIG.CRYPTO_LIST.map(c => c.symbol).join(', ')}`);
  console.log(`📈 已启用：技术指标 (MA7/30/90/180/365 + 趋势分析)`);
}
