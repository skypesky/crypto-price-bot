# Crypto Price Bot 📊

一个基于 Node.js + Vite/React + SQLite 的加密货币价格监控机器人，**内置 Web Dashboard** 管理所有配置，定时通过 Telegram 和飞书发送实时价格报告。

## 🚀 功能特性

- **Web Dashboard**：账密登录，所有配置（币种、推送通道、调度规则、汇率、DoH 等）可视化编辑。
- **多币种监控**：默认 BTC / ETH / USDT / SOL / ABT / BNB / GT / YGG / SAGA，可在页面增删改、启停、拖拽排序。
- **技术指标**：MA7 / MA30 / MA90 / MA180 / MA365 + 7d / 30d / 90d / 180d / 1y 趋势。
- **双语计价**：美元 + 人民币。
- **定时推送**：cron 6 段（含秒）调度，支持时区。
- **多平台推送**：Telegram + 飞书 Incoming Webhook，任一失败不影响另一通道。
- **历史报表**：最近推送的快照保留在 SQLite，可重发到任意通道。
- **多阶段 Docker**：`node:22-alpine` 镜像，< 200MB，非 root 运行。

## 🛠️ 技术栈

**后端：** Node 22 LTS · TypeScript 5 · better-sqlite3 · zod · bcryptjs · 内置 `http` 模块（手写路由）
**前端：** Vite 5 · React 18 · TypeScript 5 · Ant Design 5 · @dnd-kit
**工具链：** vitest · tini（Docker PID 1）

## 📋 快速开始

### 1. 克隆 & 安装

```bash
git clone https://github.com/skypesky/crypto-price-bot
cd crypto-price-bot
make install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env：至少修改 INIT_PASSWORD（首次启动会创建管理员账密）
```

### 3. 运行

#### 方式 A：Docker（推荐部署 / 服务器）

```bash
make build.docker      # 构建镜像
make dev.docker        # 启动容器（后台）
make logs.docker       # 跟踪日志
```

容器内 `TZ=Asia/Shanghai`，通过 `volumes: ./data:/app/data` 持久化 SQLite。

#### 方式 B：Native（开发推荐）

```bash
make dev               # 并行启动：server (tsx watch :8787) + web (vite :5173)
```

打开 http://localhost:5173，用 `.env` 中配置的 `INIT_USERNAME` / `INIT_PASSWORD` 登录。

#### 方式 C：生产前台

```bash
make build             # 编译 server + web
make start             # 前台运行编译后产物
```

### 4. GitHub Actions 定时

`.github/workflows/price-report.yml` 已配置为 Node 22 + 每 6 小时运行一次。需要在仓库 Settings → Secrets 添加：

- `INIT_USERNAME`
- `INIT_PASSWORD`
- `TG_BOT_TOKEN`
- `TG_CHAT_ID`
- `FEISHU_WEBHOOK_URL`

## ⚙️ Web Dashboard

| 路径 | 说明 |
|---|---|
| `/login` | 账密登录 |
| `/dashboard` | 总览（监控币种数 / 最近推送 / 下次推送 / 立即执行） |
| `/coins` | 币种 CRUD + 拖拽排序 + 启停 |
| `/settings` | 全配置表单（推送通道 / 调度 / 数据源 / 高级） |
| `/reports` | 历史报表查询 / 重发 |
| `/account` | 修改密码 |

修改任意配置后立即生效（无需重启）。

## 📦 目录结构

```
crypto-price-bot/
├── server/                 # Node 22 后端 (TS)
│   ├── src/
│   │   ├── api/            # JSON API 路由
│   │   ├── core/           # 业务核心（db / models / scheduler / task / indicators / notify）
│   │   ├── http/           # 内置 http 包装（router / middleware / server）
│   │   ├── util/           # logger / cron / auth / http / validate / id
│   │   └── index.ts
│   └── package.json
├── web/                    # Vite + React + AntD 前端
│   ├── src/
│   │   ├── api/            # fetch wrapper
│   │   ├── pages/          # Login / Dashboard / Coins / Settings / Reports / Account
│   │   ├── layouts/
│   │   ├── router.tsx
│   │   └── main.tsx
│   └── vite.config.ts
├── data/                   # SQLite 文件（gitignore）
├── Dockerfile              # 多阶段
├── docker-compose.yml
├── Makefile
└── docs/superpowers/       # 设计文档 + 实现计划
```

## 🧪 测试

```bash
make test               # 全部 vitest
make test.coverage      # + 覆盖率报告
```

## 📄 开源协议

[ISC License](LICENSE)

## 飞书 Bot 配置（可选，「立即查询」按钮功能）

定时推送默认走 **webhook 自定义机器人**（纯文本）。
要开启「🔄 立即查询」按钮（卡片可点击、点完 DM 给你），需要额外配置飞书自建应用 Bot。本项目使用 **SDK 长连接（WebSocket）** 模式，**不需要公网 URL / ngrok**，本地开发即可用。

### 1. 创建应用

访问 https://open.feishu.cn/app → 创建企业自建应用

### 2. 开启机器人能力

应用能力 → 机器人 → 添加

### 3. 配置权限

权限管理 → 开通以下 scope：
- `im:message`（接收消息）
- `im:message:send_as_bot`（以 Bot 名义发）
- `im:message.p2p_msg`（单聊）
- `im:chat:readonly`（查询所在群）

### 4. 获取 App ID / App Secret

应用 → 凭证与基础信息 → 复制 App ID 和 App Secret

### 5. 获取 receive_id

```bash
# 拿 tenant_access_token
curl -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \
  -H "Content-Type: application/json" \
  -d '{"app_id":"cli_xxx","app_secret":"xxx"}'

# 列出 bot 所在的所有群
curl -G "https://open.feishu.cn/open-apis/im/v1/chats" \
  -H "Authorization: Bearer <token>" \
  --data-urlencode "user_id_type=open_id"
```

返回的 `chat_id` 就是 `FEISHU_DEFAULT_RECEIVE_ID`。

### 6. 发布应用

版本管理与发布 → 创建版本 → 申请发布（需企业管理员审批）

### 7. 填 .env

参考 `.env.example` 的 Bot 字段，填上 4 个变量：

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxx
FEISHU_DEFAULT_RECEIVE_ID=oc_xxxxxxxxxxxxx
FEISHU_DEFAULT_RECEIVE_ID_TYPE=chat_id
```

重启服务即可。

### 8. 验证

- 重启 server，看日志：`[INFO] [app:feishu-ws] feishu WS client started`
- 等下次调度（或 dashboard 手点）→ 群里收到带「🔄 立即查询」按钮的卡片
- 点按钮 → 几秒后收到 DM

### 不需要的事

- ❌ 不需要公网 URL / 域名
- ❌ 不需要 ngrok / cloudflared
- ❌ 不需要事件回调配置
- ❌ 不需要 Encrypt Key / Verification Token

### 凭证缺失的降级行为

如果 4 个必填 env 变量任一缺失，server 启动时会打日志 `Bot not configured, skipping feishu WS start`，定时推送自动降级为 webhook 纯文本（无按钮）。系统不会宕机。