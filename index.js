require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');

// 核心配置
const CONFIG = {
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN,
  TG_CHAT_ID: process.env.TG_CHAT_ID,
  // 用户指定的 User-Agent
  USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  // 要查询的币种（CoinGecko的币种ID，可在官网查）
  CRYPTO_LIST: [
    { id: 'bitcoin', symbol: 'BTC', name: '比特币' },
    { id: 'ethereum', symbol: 'ETH', name: '以太坊' },
    { id: 'tether', symbol: 'USDT', name: '泰达币' },
    { id: 'solana', symbol: 'SOL', name: '索拉纳' },
    { id: 'arcblock', symbol: 'ABT', name: '区块基石' },
    { id: 'binancecoin', symbol: 'BNB', name: '币安币' },
    { id: 'icon', symbol: 'ICX', name: 'ICON' },
    { id: 'filecoin', symbol: 'FIL', name: '文件币' },
    { id: 'cosmos', symbol: 'ATOM', name: '阿童木' },
    { id: 'optimism', symbol: 'OP', name: 'Optimism' },
  ],
  // 定时规则：每天9点0分0秒执行（格式：秒 分 时 日 月 周）
  SCHEDULE_RULE: '0 0 9 * * *'
};

// 验证配置
if (!CONFIG.TG_BOT_TOKEN || !CONFIG.TG_CHAT_ID || CONFIG.TG_BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error('❌ 错误：请在 .env 文件中配置有效的 TG_BOT_TOKEN 和 TG_CHAT_ID');
  process.exit(1);
}

// 初始化TG机器人
const tgBot = new TelegramBot(CONFIG.TG_BOT_TOKEN, { polling: false });

/**
 * 获取加密货币价格并格式化消息
 */
async function getCryptoPrices() {
  try {
    console.log('正在从 CoinGecko 获取价格...');
    
    const ids = CONFIG.CRYPTO_LIST.map(item => item.id).join(',');
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=cny,usd`;

    const response = await axios.get(url, {
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Accept': 'application/json'
      }
    });

    const data = response.data;

    // 格式化消息
    let msg = '📊 *今日加密货币价格报告*\n\n';
    CONFIG.CRYPTO_LIST.forEach(item => {
      const price = data[item.id];
      if (price) {
        // 使用用户要求的链接格式：https://www.coingecko.com/zh/数字货币/币种ID
        const trendUrl = `https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/${encodeURIComponent(item.id)}`;
        msg += `🔹 *${item.name}* (${item.symbol}):\n`;
        msg += `   💰 人民币：\`¥${price.cny.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}\`\n`;
        msg += `   💵 美元：\`$${price.usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}\`\n`;
        msg += `   📈 [查看趋势图](${trendUrl})\n\n`;
      } else {
        msg += `⚠️ 无法获取 ${item.name} 的价格\n\n`;
      }
    });
    
    msg += `⏰ 更新时间: ${new Date().toLocaleString('zh-CN')}`;
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
    // 如果是 401，可能是 Token 错误
    if (err.response && err.response.statusCode === 401) {
      console.error('   提示：请检查 TG_BOT_TOKEN 是否正确');
    }
  }
}

/**
 * 主任务：查价格 + 发TG
 */
async function mainTask() {
  console.log(`[${new Date().toLocaleString()}] 开始执行价格查询任务...`);
  const priceMsg = await getCryptoPrices();
  await sendToTG(priceMsg);
}

// 1. 如果是 GitHub Actions 环境，执行一次就退出
if (process.env.GITHUB_ACTIONS === 'true') {
  console.log('检测到 GitHub Actions 环境，执行单次任务...');
  mainTask().then(() => {
    console.log('✅ 任务执行完毕，正在退出...');
    // 给一点时间让异步日志输出完毕
    setTimeout(() => process.exit(0), 5000);
  }).catch(err => {
    console.error('❌ 任务执行失败:', err);
    process.exit(1);
  });
} else {
  // 2. 本地/服务器模式：立即执行一次并开启定时任务
  mainTask();

  schedule.scheduleJob(CONFIG.SCHEDULE_RULE, () => {
    console.log('定时任务触发');
    mainTask();
  });

  console.log(`🚀 机器人已启动！`);
  console.log(`📅 定时规则: ${CONFIG.SCHEDULE_RULE} (每天 ${CONFIG.SCHEDULE_RULE.split(' ')[2]} 点)`);
  console.log(`📝 监控币种: ${CONFIG.CRYPTO_LIST.map(c => c.symbol).join(', ')}`);
}
