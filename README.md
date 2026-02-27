# Crypto Price Bot 📊

一个基于 Node.js 的加密货币价格监控机器人，定时通过 Telegram 和飞书发送实时价格报告。

## 🚀 功能特性

- **多币种监控**：默认支持 BTC, ETH, USDT, SOL, ABT, BNB 等。
- **双语计价**：同时提供人民币 (CNY) 和美元 (USD) 价格。
- **定时推送**：通过 `node-schedule` 实现每日定时发送报告（默认每天 9:00 AM）。
- **多平台推送**：支持同时向 Telegram 和飞书发送报告。
- **趋势链接**：点击报告中的链接可直接跳转至 CoinGecko 查看详细趋势图。
- **PM2 支持**：内置 PM2 启动脚本，方便生产环境持久化运行。

## 🛠️ 技术栈

- **Bun**: 运行环境及包管理
- **Axios**: 处理 API 请求
- **node-telegram-bot-api**: Telegram 机器人交互
- **node-fetch**: 飞书 Webhook 请求
- **node-schedule**: 定时任务管理
- **CoinGecko API**: 免费且强大的加密货币数据源

## 📋 快速开始

### 1. 克隆项目并安装依赖

```bash
git clone <repository-url>
cd crypto-price-bot
bun install
```

### 2. 配置环境变量

在根目录下创建 `.env` 文件，并填入你的配置信息：

```env
TG_BOT_TOKEN="你的_TELEGRAM_机器人_TOKEN"
TG_CHAT_ID=你的_TELEGRAM_聊天_ID
FEISHU_WEBHOOK_URL=你的_飞书_ webhook_ URL
TIMEZONE="Asia/Shanghai"  # 时区设置,默认为北京时区
```

### 3. 运行机器人

**开发模式：**
```bash
bun run dev
```

**生产模式 (使用 PM2)：**
```bash
bun start
```

### 4. GitHub Actions 定时任务 (推荐)

项目已配置 GitHub Actions，可实现每小时自动发送报告。

**设置步骤：**
1. 将项目推送到你的 GitHub 仓库。
2. 在仓库设置中找到 **Settings** -> **Secrets and variables** -> **Actions**。
3. 添加以下三个 Repository secrets：
   - `TG_BOT_TOKEN`: 你的 Telegram Bot Token。
   - `TG_CHAT_ID`: 你的 Telegram Chat ID。
   - `FEISHU_WEBHOOK_URL`: 你的飞书机器人 Webhook URL。
4. 工作流会使用 Bun 环境在每小时整点运行。你也可以在 **Actions** 标签页手动触发 **Hourly Crypto Price Report**。

## ⚙️ 自定义配置

你可以在 [index.js](file:///Users/skypesky/workSpaces/javascript/github/crypto-price-bot/index.js) 的 `CONFIG` 对象中进行如下调整：

- **CRYPTO_LIST**: 修改或增加你想要监控的币种 ID（需符合 CoinGecko ID 规范）。
- **SCHEDULE_RULE**: 修改定时规则（Cron 表达式格式）。
- **USER_AGENT**: 自定义请求头。

## 📄 开源协议

[ISC License](file:///Users/skypesky/workSpaces/javascript/github/crypto-price-bot/package.json)
