# Crypto Price Bot v2 — 设计文档

> 日期：2026-06-16
> 状态：已批准，进入实现规划阶段
> 范围：单进程 Node 服务 + Web Dashboard + SQLite + 多阶段 Docker

---

## 1. 背景与目标

原项目 `crypto-price-bot` 是一个单文件（`index.js`、347 行）Bun/Node 脚本，定时从 Gate.io 拉取加密货币价格并推送到 Telegram / 飞书。代码组织、依赖管理、Docker 部署、Web 配置界面均较为粗糙。

### 1.1 本次重构目标

1. **全面 TypeScript 化**：前后端均用 TS，类型贯穿全链路。
2. **Vite + React + TS 前端 Dashboard**：所有可调参数可在网页改，账密登录。
3. **SQLite 持久化**：配置、币种、历史报表、用户、会话均落库。
4. **Docker 化完善**：多阶段构建、非 root、镜像瘦身。
5. **代码清理**：移除未使用的依赖（`coingecko-api`、`node-telegram-bot-api`、`axios`），按职责拆分模块。

### 1.2 非目标（YAGNI）

- 不做多用户 / RBAC（单账密即可）。
- 不做币种价格历史曲线图（用 CoinGecko 链接跳转代替）。
- 不做实时 WebSocket 日志推送（仅提供 REST 拉取最近 200 行）。
- 不做 SSR / Nuxt（纯 SPA 即可）。
- 不保留 Bun 运行时兼容性（统一 Node 22 LTS）。
- 不引 Express / Fastify / Hono（手写极简路由）。

---

## 2. 顶层架构

单进程 Node 22 LTS 服务，进程内同时运行：

- **HTTP Server**：Node 内置 `http` + 手写路由，供 Web API + 静态前端资源。
- **Cron 调度器**：手写最小 cron 解析器 + `setTimeout` 递归调度。
- **Gate.io 数据拉取**：基于 `fetch` 的极简 HTTP 封装。
- **推送器**：Telegram Bot API + 飞书 Incoming Webhook。
- **SQLite**：通过 `better-sqlite3` 同步 API。

```
┌─────────────────────────────────────────────┐
│  Node 22 进程                                │
│  ┌────────────┐ ┌────────────┐ ┌─────────┐  │
│  │ HTTP API   │ │ Cron       │ │ Logger  │  │
│  │ (router)   │ │ Scheduler  │ │ (环形)   │  │
│  └─────┬──────┘ └─────┬──────┘ └────┬────┘  │
│        │              │             │       │
│        └─────────┬────┴─────────────┘       │
│              ┌───▼────┐                      │
│              │ Core   │                      │
│              │ Models │                      │
│              └───┬────┘                      │
│                  │                           │
│              ┌───▼────┐                      │
│              │ SQLite │                      │
│              └────────┘                      │
└─────────────────────────────────────────────┘
        │                     │
        ▼                     ▼
   Web Dashboard          Telegram / 飞书
   (Vite SPA)             (HTTPS 推送)
```

---

## 3. 目录结构

```
crypto-price-bot/
├── server/                        # Node 22 后端 (TS)
│   ├── src/
│   │   ├── index.ts               # 进程入口
│   │   ├── http/                  # HTTP 基础设施
│   │   │   ├── server.ts          # http.createServer 启动
│   │   │   ├── router.ts          # Trie 路由匹配
│   │   │   ├── request.ts         # IncomingMessage 包装
│   │   │   ├── response.ts        # JSON / 静态 / 流
│   │   │   ├── middleware.ts      # logger / json / static / auth
│   │   │   └── errors.ts          # HttpError 类
│   │   ├── api/                   # 业务路由
│   │   │   ├── auth.ts            # 登录 / 登出 / 改密
│   │   │   ├── settings.ts        # 配置读写
│   │   │   ├── coins.ts           # 币种 CRUD + 排序
│   │   │   ├── reports.ts         # 历史报表查询 / 重发
│   │   │   ├── task.ts            # 立即执行 / 下次时间
│   │   │   ├── logs.ts            # 运行日志
│   │   │   └── status.ts          # 健康检查
│   │   ├── core/                  # 业务核心
│   │   │   ├── config.ts          # 配置合并（env + db）
│   │   │   ├── db.ts              # SQLite 初始化 + 迁移
│   │   │   ├── models/
│   │   │   │   ├── user.ts
│   │   │   │   ├── session.ts
│   │   │   │   ├── setting.ts
│   │   │   │   ├── coin.ts
│   │   │   │   └── report.ts
│   │   │   ├── gate/
│   │   │   │   ├── ticker.ts
│   │   │   │   └── klines.ts
│   │   │   ├── indicators/
│   │   │   │   ├── ma.ts
│   │   │   │   └── trend.ts
│   │   │   ├── notify/
│   │   │   │   ├── telegram.ts
│   │   │   │   └── feishu.ts
│   │   │   ├── message/
│   │   │   │   ├── builder.ts     # 拼装 Markdown 报表
│   │   │   │   └── formatter.ts   # 文本规范化
│   │   │   ├── scheduler.ts       # cron + setTimeout
│   │   │   └── task.ts            # 主任务编排
│   │   ├── util/
│   │   │   ├── logger.ts          # 级别 + 颜色 + 环形缓冲
│   │   │   ├── http.ts            # fetch 封装 + DoH
│   │   │   ├── auth.ts            # bcrypt + JWT（自签 HMAC）
│   │   │   ├── validate.ts        # zod schemas
│   │   │   ├── cron.ts            # cron 解析器 + next()
│   │   │   └── id.ts              # 随机 token
│   │   └── types.ts
│   ├── tsconfig.json
│   ├── package.json
│   └── vitest.config.ts
│
├── web/                           # Vite + React + TS 前端
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   ├── Dashboard.tsx
│   │   │   ├── Coins.tsx
│   │   │   ├── Settings.tsx
│   │   │   ├── Reports.tsx
│   │   │   └── Account.tsx
│   │   ├── api/
│   │   │   └── client.ts          # fetch wrapper + 拦截器
│   │   ├── components/
│   │   ├── layouts/
│   │   │   └── MainLayout.tsx
│   │   ├── router.tsx             # HashRouter
│   │   └── styles/
│   ├── vite.config.ts             # build 输出到 ../server/src/static
│   ├── tsconfig.json
│   ├── package.json
│   └── index.html
│
├── data/                          # SQLite 文件（gitignore，挂载）
│   └── crypto.db
├── docs/superpowers/
│   ├── specs/                     # 设计文档
│   └── plans/                     # 实现计划
├── .github/workflows/
│   └── price-report.yml           # 改用 Node 22
├── Dockerfile                     # 多阶段
├── docker-compose.yml
├── .dockerignore
├── .env.example
├── .gitignore
├── Makefile
└── README.md
```

---

## 4. 数据模型

```sql
-- 启动初始化时若空则插入默认用户（账密来自 env INIT_USERNAME/INIT_PASSWORD）
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 单行表，KV 形式
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,  -- JSON 序列化
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT    UNIQUE NOT NULL,
  name        TEXT    NOT NULL,
  gate_pair   TEXT,                -- NULL 表示稳定币
  cg_id       TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  triggered_by  TEXT    NOT NULL,   -- 'cron' | 'manual' | 'test'
  success       INTEGER NOT NULL,
  total_coins   INTEGER NOT NULL,
  ok_coins      INTEGER NOT NULL,
  tg_sent       INTEGER NOT NULL,
  feishu_sent   INTEGER NOT NULL,
  message       TEXT    NOT NULL,   -- 完整 Markdown
  summary       TEXT    NOT NULL,   -- JSON
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
```

### 4.1 `settings` 表的 key 枚举

| key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `tg_bot_token` | string \| null | null | Telegram Bot Token |
| `tg_chat_id` | string \| null | null | Telegram Chat ID |
| `feishu_webhook_url` | string \| null | null | 飞书 Incoming Webhook URL |
| `timezone` | string | `Asia/Shanghai` | IANA 时区 |
| `schedule_rule` | string | `0 0 9 * * *` | cron 6 段（含秒） |
| `usdt_to_cny` | number | `7.20` | USDT 兑 CNY 汇率 |
| `ua` | string | 默认 UA | HTTP User-Agent |
| `doh_enabled` | boolean | `true` | 是否启用 DoH 兜底 |
| `doh_server` | string | `1.1.1.1` | DoH 服务器 |
| `doh_bypass` | string[] | `["1.1.1.1", "one.one.one.one"]` | 直连列表 |
| `request_timeout_ms` | number | `15000` | HTTP 请求超时 |
| `max_retries` | number | `1` | 失败重试次数 |

---

## 5. 配置加载与生效机制

### 5.1 启动加载顺序

1. 读取 env：`DATABASE_PATH`、`PORT`、`WEB_USERNAME`、`WEB_PASSWORD`、`TIMEZONE`、`LOG_LEVEL`、`INIT_USERNAME`、`INIT_PASSWORD`。
2. 若 `INIT_USERNAME`/`INIT_PASSWORD` 存在且 users 表为空，插入默认管理员。
3. 读取 settings 表，全部为空则插入默认值。
4. 读取 coins 表，为空则插入默认 11 币种（与原 index.js 一致）。
5. 构建 `Config` 单例供 core 消费；env 中同名变量作为**初始默认值**（如 `TIMEZONE` 仍以 env 优先，覆盖 DB 默认值）。

### 5.2 运行时热更新

`core/config.ts` 暴露 `getConfig()` / `reloadConfig()` / `onConfigChange(fn)`。Web UI 修改 settings 后：

- 调用 `reloadConfig()`。
- 触发 `onConfigChange` 订阅者：
  - `scheduler` 取消旧 timer、用新 `schedule_rule` 重排。
  - `notify/telegram.ts` 重新读取 token（不缓存）。
  - `notify/feishu.ts` 同上。
  - `util/http.ts` 重建 DoH agent（如 doh_enabled 变化）。
- 无需重启进程。

### 5.3 校验

`util/validate.ts` 用 zod 对 PUT /api/settings 的整体 payload 做 schema 校验。任一字段不合法 → 400 + 详细错误。PUT /api/coins/:id 同理。

---

## 6. HTTP API 设计

所有 `/api/*`（除 `/api/auth/login` 和 `/api/status`）要求已登录。响应统一 JSON：`{ ok: true, data: ... }` 或 `{ ok: false, error: { code, message } }`。

| Method | Path | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/status` | 否 | `{ version, uptime, dbOk, nextRunAt, lastReportAt }` |
| POST | `/api/auth/login` | 否 | `{ username, password }` → Set-Cookie session |
| POST | `/api/auth/logout` | 是 | 清 cookie |
| POST | `/api/auth/change-password` | 是 | `{ oldPassword, newPassword }` |
| GET | `/api/settings` | 是 | 返回所有 settings |
| PUT | `/api/settings` | 是 | 整体替换，触发 reload |
| GET | `/api/coins` | 是 | `Coin[]` |
| POST | `/api/coins` | 是 | 新增 |
| PUT | `/api/coins/:id` | 是 | 修改 |
| DELETE | `/api/coins/:id` | 是 | 删除 |
| POST | `/api/coins/reorder` | 是 | `{ ids: number[] }` 批量更新 sort_order |
| GET | `/api/reports?limit=50` | 是 | 报表列表 |
| GET | `/api/reports/:id` | 是 | 单份详情 |
| POST | `/api/reports/:id/resend` | 是 | `{ channels: ['tg','feishu'] }` 重发 |
| POST | `/api/task/run` | 是 | 立即执行任务，返回新 report id |
| GET | `/api/task/next` | 是 | `{ nextRunAt, scheduleRule }` |
| GET | `/api/logs?limit=200` | 是 | 内存环形缓冲最近 N 行 |
| GET | `/` | 否 | 静态 dist/index.html（SPA 入口） |
| GET | `/assets/*` | 否 | 静态资源 |

### 6.1 Cookie 约定

- `cpb_session` HttpOnly、SameSite=Strict、Secure（当 HTTPS）。
- 过期 7 天。
- 服务端 `sessions` 表记录，每次请求中间件校验未过期。
- 中间件逻辑：`req.cookies.cpb_session` → 查 sessions 表 → 未过期 → `req.user = ...`。

---

## 7. Cron 调度器

### 7.1 解析器

`util/cron.ts` 自实现 6 段 cron（含秒）：`* * * * * *`，支持 `*`、数字、`,`、`-`、`/`。**不**支持 `L`、`W`、`#`、`?`。代码 ~80 行 + 完整单测覆盖。

### 7.2 调度策略

- 主任务完成后 `setTimeout` 递归计算到下次触发的差值。
- 启动时立即算一次 next-time，setTimeout 到点。
- 切换 `schedule_rule`：取消旧 timer、`clearTimeout`、算新 next-time、`setTimeout`。
- 进程退出（SIGINT/SIGTERM）时清理 timer。

### 7.3 边界

- 不支持秒级精度以下。
- 不持久化 next-time（重启后由 cron 重新计算）。

---

## 8. Gate.io 数据源

### 8.1 接口

- Ticker：`GET https://api.gateio.ws/api/v4/spot/tickers?currency_pair={pair}` → `[{ last, change_percentage, ... }]`。
- K线：`GET https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair={pair}&interval=1d&limit=365` → `[[ts, vol, close, high, low, vol_quote, ...]]`。

### 8.2 封装

`util/http.ts` 提供：

- `httpGet(url, { timeout?, retries? })`：内部 Node `fetch`，失败自动重试 1 次（指数退避 500ms）。
- `httpPost(url, body, opts)`：同上。
- 失败抛 `HttpError`，调用方 try/catch 处理（单币种失败不中断其他币种）。
- DoH 兜底：仅在 `doh_enabled=true` 时启用；`doh_bypass` 列表内域名走系统 DNS。

### 8.3 主任务编排

`core/task.ts#runTask(triggeredBy)`：

1. 读 coins（按 sort_order）。
2. `Promise.allSettled` 并发拉 ticker + klines。
3. 失败项保留 error 信息，UI 报表中显示 ⚠️。
4. 调用 `message/builder.ts` 生成 Markdown。
5. 并行推送到 TG / 飞书（任一失败不影响另一通道）。
6. 写 `reports` 表。
7. 返回 `{ reportId, success, okCount, tgSent, feishuSent }`。

---

## 9. 推送器

### 9.1 Telegram

- `POST https://api.telegram.org/bot{token}/sendMessage`，body `{ chat_id, text, parse_mode: 'Markdown' }`。
- 不引 `node-telegram-bot-api`，直接 fetch。
- 失败返回 `{ ok: false, error_code, description }`，调用方判断。

### 9.2 飞书

- `POST {webhook_url}`，body `{ msg_type: 'text', content: { text } }`。
- 推送前用 `message/formatter.ts#normalizeMessageForTextChannel` 把 Markdown 转纯文本。
- 保留原 `normalize.test.js` 的所有断言。

---

## 10. 报表构建

### 10.1 Markdown（TG 用）

完全复刻原 `buildMessage` 输出格式（币种名 / 美元 / 人民币 / MA7-365 / 趋势 7d-1y / Gate + CoinGecko 链接 / 末尾时间戳 + 免责声明）。

### 10.2 纯文本（飞书用）

`normalizeMessageForTextChannel`：去 `*_`\``、CRLF→LF、`[text](url)` → `text: url`。

---

## 11. 前端 Web Dashboard

### 11.1 技术栈

- **构建**：Vite 5 + TypeScript 5
- **框架**：React 18 + react-router-dom v6（HashRouter）
- **UI**：Ant Design 5 + `@ant-design/icons`
- **HTTP**：原生 fetch 包装，401 自动跳登录

### 11.2 路由

| 路径 | 组件 | 鉴权 |
|---|---|---|
| `/login` | Login | 否 |
| `/` | 重定向 `/dashboard` | 是 |
| `/dashboard` | Dashboard | 是 |
| `/coins` | Coins | 是 |
| `/settings` | Settings | 是 |
| `/reports` | Reports | 是 |
| `/account` | Account | 是 |

### 11.3 页面要点

- **Login**：账密表单，错误提示，登录成功后跳 `/dashboard`。
- **Dashboard**：四个 Statistic 卡（监控币种数 / 最近一次推送 / 下次推送 / 最近一次状态），中部「立即执行」按钮 + 进度提示，底部最近 5 份报表预览列表。
- **Coins**：Ant Table，行内启停开关、编辑、删除；右上角「新增」按钮；拖拽排序（@dnd-kit/sortable）。
- **Settings**：Tabs 分组（Telegram / 飞书 / 调度 / 数据源 / 高级 / 货币）；每项带 Tooltip 说明；底部统一「保存」按钮。
- **Reports**：Table + Drawer 详情；操作列支持「重发到 TG / 飞书 / 全部」。
- **Account**：表单（当前密码 + 新密码 + 确认新密码）。

### 11.4 国际化

Ant Design `ConfigProvider locale={zhCN}`，所有内置文案中文。自定义文案用 `t('...')` 函数（简单词表，不引 i18n 库）。

### 11.5 主题

跟随系统 `prefers-color-scheme`，可手动切换。明暗两套 AntD 主题 token。

---

## 12. 错误处理与日志

### 12.1 Logger

`util/logger.ts`：

- 级别：debug / info / warn / error。
- 输出：时间戳 + 级别 + 模块名 + 消息，stderr 流式输出。
- 颜色：仅 TTY 启用。
- 环形缓冲：最近 500 行供 `/api/logs` 读取。
- 模块名：调用方传入（`logger.child('module-name')`）。

### 12.2 异常边界

- HTTP 中间件统一 try/catch，未捕获异常 → 500 + 日志。
- 主任务 try/catch，单币种失败不中断。
- DB 写入失败 → 整个任务失败、写一条失败 report。

### 12.3 健康检查

`/api/status` 返回 `{ version, uptime, dbOk, nextRunAt, lastReportAt, sqliteOk }`。`dbOk` 由 `db.pragma('user_version')` 探活。

---

## 13. 测试策略

### 13.1 工具

- vitest 1.x + @vitest/coverage-v8
- `environment: 'node'`，`include: ['server/src/**/*.test.ts', 'web/src/**/*.test.ts']`

### 13.2 覆盖目标

| 模块 | 目标 | 关键 case |
|---|---|---|
| `indicators/ma.ts` | 100% | 长度不足返回 null、精确 N 长度求平均、空数组 |
| `indicators/trend.ts` | 100% | past=0 返回 null、上涨/下跌取整 2 位 |
| `message/formatter.ts` | 100% | CRLF/Markdown 链接/星号去除/null/undefined |
| `message/builder.ts` | 90% | 失败币种、MA/trend 缺失、稳定币路径 |
| `util/cron.ts` | 100% | next-time 计算：每日 9 点、每周一、跨月跨年、每 5 分钟 |
| `util/auth.ts` | 90% | hash/verify 往返、过期 token、JWT 签发 |
| `util/validate.ts` | 90% | schema 边界（错类型、缺字段、超长） |
| `notify/feishu.ts` | 80% | fetch 错误处理、文本规范化集成 |

### 13.3 不测

- 网络层（Gate.io / TG / 飞书），避免外部依赖。
- 前端组件（避免 React Testing Library 引入）。

---

## 14. Docker 多阶段构建

### 14.1 阶段

```dockerfile
# ---- Stage 1: deps (后端)
FROM node:22-alpine AS deps-server
WORKDIR /app/server
RUN apk add --no-cache python3 make g++  # better-sqlite3 编译
COPY server/package*.json ./
RUN npm ci --omit=dev=false  # 含 devDeps（typescript）

# ---- Stage 2: deps (前端)
FROM node:22-alpine AS deps-web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci

# ---- Stage 3: build
FROM deps-server AS build-server
WORKDIR /app/server
COPY server/ ./
RUN npm run build  # tsc → dist

FROM deps-web AS build-web
WORKDIR /app/web
COPY web/ ./
RUN npm run build  # vite build → ../server/src/static

# ---- Stage 4: runner
FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    PORT=8787 \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8

WORKDIR /app
RUN apk add --no-cache tini  # PID 1 信号转发

COPY --from=build-server /app/server/dist ./dist
COPY --from=build-server /app/server/node_modules ./node_modules
COPY --from=build-server /app/server/package.json ./
COPY --from=build-web /app/server/src/static ./src/static

# 非 root
USER node

EXPOSE 8787

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
```

### 14.2 .dockerignore

```
.git
.gitignore
.github
docs
data
node_modules
server/node_modules
web/node_modules
server/src/static
server/dist
web/dist
*.log
*.md
.env
.env.*
!.env.example
.DS_Store
bun.lockb
bun.lock
```

### 14.3 docker-compose.yml

```yaml
services:
  crypto-price-bot:
    build: .
    image: crypto-price-bot:latest
    container_name: crypto-price-bot
    restart: unless-stopped
    env_file: .env
    ports:
      - "${PORT:-8787}:8787"
    volumes:
      - ./data:/app/data
```

### 14.4 镜像大小预期

- alpine base：~50MB
- node_modules（prod + better-sqlite3 prebuilt）：~80MB
- 应用代码 + 静态资源：~5MB
- **合计 ~135MB**

---

## 15. Makefile

```
make install              # server + web 各 npm ci
make dev                  # 并行：server (tsx watch) + web (vite dev 代理 /api → :8787)
make build                # server tsc + web vite build
make start                # 前台：node dist/index.js
make stop                 # pkill -f "node dist/index.js"
make test                 # server vitest
make test.coverage        # 含覆盖率报告

make build.docker         # docker build -t crypto-price-bot:latest .
make dev.docker           # docker compose up -d
make start.docker         # build.docker + dev.docker
make stop.docker          # docker compose down
make logs.docker          # docker compose logs -f
make shell.docker         # docker compose exec crypto-price-bot sh
make clean.docker         # docker compose down --rmi all

make clean                # 删 dist + node_modules + data/*
```

---

## 16. 兼容性与迁移

### 16.1 与原项目的差异

| 项 | 原 | 新 |
|---|---|---|
| Runtime | Bun + Node 双支持 | 仅 Node 22 LTS |
| 配置存储 | env | env 启动 + DB 运行时 |
| HTTP 服务 | 无 | 内置轻包装 |
| 前端 | 无 | Vite + React SPA |
| 数据库 | 无 | SQLite |
| 镜像 base | `oven/bun:1.3.6` | `node:22-alpine` |
| 入口 | `index.js` | `server/dist/index.js` |
| 依赖 | 5 个 | 仅 `better-sqlite3`（运行时）+ devDeps |

### 16.2 升级路径

- 保留 `.env.example` 字段名（TG_BOT_TOKEN / TG_CHAT_ID / FEISHU_WEBHOOK_URL / TIMEZONE），但这些不再必读；建议迁移到 Web UI 设置。
- 保留 cron 表达式格式（含秒）：`0 0 9 * * *`。
- 保留默认 11 币种列表（顺序、symbol、gate_pair、cg_id 一致）。
- GitHub Actions 改用 `actions/setup-node@v4` + Node 22。

---

## 17. 风险与缓解

| 风险 | 缓解 |
|---|---|
| better-sqlite3 在 alpine 编译失败 | builder 阶段装 python3/make/g++；runner 用 prebuilt 不再编译 |
| Web UI Cookie 在 HTTP 下不安全 | 默认仅本机 127.0.0.1 监听；公网部署需反代 HTTPS，前端 Set-Cookie 加 Secure |
| 手写 cron 解析器有 bug | 单元测试覆盖 100% next-time 计算 + 格式校验 |
| Vite build 产物跨域 | 反代场景由 docker-compose 同源服务；开发态 vite proxy 转发 /api |
| 长时间运行内存泄漏 | better-sqlite3 同步 API 无连接泄漏；logger 环形缓冲固定大小 |

---

## 18. 验收标准

1. `make install && make dev` 可在本地启动，前端在 http://localhost:5173，后端在 http://localhost:8787。
2. 首次访问前端 → 重定向 `/login` → 输入账密登录 → `/dashboard`。
3. 在 Web UI 修改任意 setting → 后端日志出现「config reloaded」→ 下次 cron 任务按新规则执行。
4. 在 Web UI 修改 coins → 排序、启停、生效。
5. 点击「立即执行」→ 2-3 秒内返回 reportId → Reports 页可见该条。
6. `make build.docker && make dev.docker` → 容器启动、健康检查 200、卷挂载 data/ 持久化。
7. `make test` 全部通过，行覆盖率 ≥ 60%、纯函数模块 ≥ 90%。
8. `docker images crypto-price-bot:latest` 大小 < 200MB。

---

## 19. 后续（Out of Scope）

- 多用户 / RBAC
- 价格历史曲线图
- WebSocket 实时日志
- SSR / Nuxt
- 自定义指标（MACD / RSI / 布林带）
- 多交易所聚合（仅 Gate.io）
- i18n 完整方案（仅中文）