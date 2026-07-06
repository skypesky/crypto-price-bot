# crypto-price-bot 架构文档

> 基于静态分析（源码、配置、Docker、CI）生成 · 2026-07-03
> 所有标注 `[需运行时确认]` 的指标需要部署后实测。

---

## 1. 项目概述

| 字段 | 值 |
|------|----|
| 名称 | crypto-price-bot |
| 版本 | v2.0.0 |
| 类型 | 定时数据采集 + 多通道推送 + Web 管理后台 |
| 核心场景 | 加密货币价格监控，每 30 分钟拉一次 11 个币种的价格/K线/汇率，推送到 Telegram / 飞书；同时通过 Web Dashboard 管理所有配置 |
| 目标用户 | 个人 / 小团队加密资产持有者 |
| 部署形态 | Docker（推荐）/ Native（开发）/ GitHub Actions（兜底） |
| 主语言 | TypeScript 5.6（前后端共用） |

**核心特性（README 自述）：**

- Web Dashboard：账密登录，可视化编辑所有配置
- 多币种监控：BTC / ETH / USDT / SOL / ABT / BNB / ICX / FIL / ATOM / OP / GT
- 技术指标：MA7/30/90/180/365 + 7d/30d/90d/180d/1y 趋势
- 双语计价：USD + CNY（汇率走 CoinGecko）
- 定时推送：cron 6 段（支持秒 + 时区）
- 多平台推送：Telegram + 飞书 webhook
- 历史报表：SQLite 持久化，可重发

---

## 2. 技术栈

### 2.1 后端（`server/`）

| 技术 | 版本 | 用途 | 成熟度 | 状态 | 备注 |
|------|------|------|--------|------|------|
| Node.js | 22 LTS (alpine 22.20) | 运行时 | ★★★★★ | ✅ | 比 20 更新，fetch/undici 原生支持 |
| TypeScript | 5.6.2 | 语言 | ★★★★★ | ✅ | strict 模式 |
| better-sqlite3 | 11.3.0 | 数据库 | ★★★★★ | ✅ | 同步 API，性能强；不适合高并发写 |
| zod | 3.23.8 | 入参校验 | ★★★★★ | ✅ | 类型即 schema |
| bcryptjs | 2.4.3 | 密码哈希 | ★★★★ | ✅ | 纯 JS 实现（vs native bcrypt），无编译依赖 |
| croner | 10.0.1 | cron 调度 | ★★★★ | ✅ | 支持秒、时区、热重载 |
| undici | 7.28.0 | HTTP 客户端 | ★★★★★ | ✅ | Node 内置 fetch 的底层，keep-alive Agent |
| vitest | 2.1.2 | 测试框架 | ★★★★★ | ✅ | 含 v8 coverage |

**自研部分：**
- HTTP 框架：`src/http/{router,middleware,server,request,response,errors}.ts`（trie 树路由 + 中间件链 + JSON 响应封装），**不依赖 Express/Koa**

### 2.2 前端（`web/`）

| 技术 | 版本 | 用途 | 成熟度 | 状态 | 备注 |
|------|------|------|--------|------|------|
| Vite | 5.4.9 | 构建工具 | ★★★★★ | ✅ | 171ms 冷启动 |
| React | 18.3.1 | UI 框架 | ★★★★★ | ✅ | - |
| TypeScript | 5.6.2 | 语言 | ★★★★★ | ✅ | - |
| Ant Design | 5.21.5 | 组件库 | ★★★★★ | ✅ | 国内后台首选 |
| @dnd-kit | 6.1.0 / 8.0.0 | 拖拽 | ★★★★ | ✅ | 替代 react-dnd，维护更活跃 |
| dayjs | 1.11.13 | 日期 | ★★★★★ | ✅ | 比 moment 轻 97% |
| react-router-dom | 6.27.0 | 路由 | ★★★★★ | ✅ | - |

### 2.3 基础设施

| 工具 | 版本 | 用途 |
|------|------|------|
| Docker | multi-stage（5 stages） | 构建 + 运行 |
| tini | latest | PID 1，信号转发 |
| mirror.gcr.io | - | 国内可访问的基础镜像 |
| SQLite WAL | - | 持久化 |
| GitHub Actions | - | 兜底 cron（每 30min） |
| DoH (Cloudflare 1.1.1.1) | - | DNS 污染兜底 |

### 2.4 开发工具链

- `Makefile`：把命令分成 native（铁律不碰 docker）+ docker 两套
- `.vscode/settings.json`：编辑器配置
- `.env` / `.env.example`：环境变量模板
- `coverage/`：已生成过覆盖率报告

---

## 3. 目录结构

```
crypto-price-bot/
├── server/                          # Node 22 后端 (TS, ESM)
│   ├── src/
│   │   ├── api/                     # JSON API 路由（7 个文件）
│   │   │   ├── auth.ts              # /api/auth/{login,logout,me}
│   │   │   ├── coins.ts             # /api/coins CRUD + reorder
│   │   │   ├── logs.ts              # /api/logs（最近日志）
│   │   │   ├── reports.ts           # /api/reports + resend
│   │   │   ├── settings.ts          # /api/settings CRUD
│   │   │   ├── status.ts            # /api/status（健康）
│   │   │   └── task.ts              # /api/task/{run,next}
│   │   ├── core/                    # 业务核心
│   │   │   ├── config.ts            # env + DB 双源配置（env 覆盖 DB）
│   │   │   ├── db.ts                # better-sqlite3 + 迁移（5 张表）
│   │   │   ├── scheduler.ts         # croner + 热重载
│   │   │   ├── task.ts              # 任务编排（fetchOne + 并行推送）
│   │   │   ├── gate/                # 数据源适配层（gate.io）
│   │   │   │   ├── ticker.ts        # 24h ticker
│   │   │   │   ├── klines.ts        # 365 天日线
│   │   │   │   └── fx.ts            # USDT/CNY 汇率（CoinGecko）
│   │   │   ├── indicators/          # 技术指标
│   │   │   │   ├── ma.ts            # MA7/30/90/180/365
│   │   │   │   └── trend.ts         # 7d/30d/90d/180d/1y 涨跌
│   │   │   ├── message/             # 报告渲染
│   │   │   │   ├── builder.ts       # 拼装 Markdown
│   │   │   │   └── formatter.ts     # 平台适配（TG markdown / 飞书 text）
│   │   │   ├── models/              # 数据访问层
│   │   │   │   ├── coin.ts          # coins 表 CRUD
│   │   │   │   ├── report.ts        # reports 表
│   │   │   │   ├── session.ts       # sessions 表
│   │   │   │   ├── setting.ts       # settings 表（kv）
│   │   │   │   └── user.ts          # users 表（bcryptjs）
│   │   │   └── notify/              # 推送通道
│   │   │       ├── telegram.ts      # Telegram Bot API
│   │   │       └── feishu.ts        # 飞书 Incoming Webhook
│   │   ├── http/                    # 自研 HTTP 框架
│   │   │   ├── router.ts            # trie 树路由
│   │   │   ├── middleware.ts        # logger / error / json / static / auth
│   │   │   ├── server.ts            # listen + close
│   │   │   ├── request.ts           # body 解析
│   │   │   ├── response.ts          # JSON / error 响应
│   │   │   └── errors.ts            # NotFound / BadRequest / Unauthorized / Conflict
│   │   ├── util/                    # 工具集
│   │   │   ├── http.ts              # 核心：fetch + retry + DoH（213 行）
│   │   │   ├── auth.ts              # session 创建 / 校验
│   │   │   ├── validate.ts          # zod schema + parseJson
│   │   │   ├── logger.ts            # pino-like 结构化日志
│   │   │   └── id.ts                # ID 生成
│   │   └── index.ts                 # bootstrap 入口
│   └── package.json
│
├── web/                             # Vite + React + AntD 前端
│   ├── src/
│   │   ├── api/client.ts            # fetch wrapper（含 401 自动跳转）
│   │   ├── components/              # 共享组件
│   │   │   └── ProtectedRoute.tsx   # 路由守卫
│   │   ├── layouts/
│   │   │   └── MainLayout.tsx       # 侧边栏 + 顶栏
│   │   ├── pages/                   # 6 个页面
│   │   │   ├── Login.tsx            # 账密登录
│   │   │   ├── Dashboard.tsx        # 总览
│   │   │   ├── Coins.tsx            # CRUD + 拖拽（224 行，最大）
│   │   │   ├── Settings.tsx         # 全配置表单（139 行）
│   │   │   ├── Reports.tsx          # 历史报表 + 重发
│   │   │   └── Account.tsx          # 改密
│   │   ├── router.tsx               # React Router 6
│   │   └── main.tsx                 # React 入口
│   └── vite.config.ts               # 代理 /api → :8787
│
├── data/                            # SQLite 文件（gitignore）
├── docs/superpowers/                # 设计文档 + 实施计划
├── Dockerfile                       # 5 阶段多阶段构建
├── docker-compose.yml               # healthcheck + 数据卷
├── Makefile                         # native + docker 双命令集
├── .env / .env.example              # 环境变量
└── .github/workflows/price-report.yml  # GH Actions 兜底 cron
```

---

## 4. 特性架构

### 4.1 模块拓扑

```
┌─────────────────────────────────────────────────────────────────┐
│                      GitHub Actions (兜底)                      │
│            GITHUB_ACTIONS=true → 跑一次 → 退出                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Docker Container / Native Process             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │ Scheduler│  │  HTTP    │  │  Task    │  │  Notify  │         │
│  │ (croner) │  │ (custom) │  │ 编排     │  │ TG/Feishu│         │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘         │
│       │             │             │             │               │
│       │             │             ▼             │               │
│       │             │     ┌──────────────┐     │               │
│       └─────────────┴────►│  Data Source │◄────┘               │
│                           │  gate.io API │                     │
│                           │  CoinGecko   │                     │
│                           └──────┬───────┘                     │
│                                  │                             │
│                                  ▼                             │
│                           ┌──────────────┐                     │
│                           │   SQLite     │                     │
│                           │ (5 tables)   │                     │
│                           └──────────────┘                     │
└─────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │
┌─────────────────────────────────────────────────────────────────┐
│                     Web Dashboard (React)                       │
│   Login → Dashboard / Coins / Settings / Reports / Account      │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 特性 → 技术映射

| 模块 | 功能 | 技术实现 | 数据存储 | 缓存策略 |
|------|------|----------|----------|----------|
| 定时调度 | 每 30min 跑一次任务 | `core/scheduler.ts` + `croner` | - | 内存中持有 `_job` 引用 |
| 价格获取 | 11 个币种 × ticker + klines | `core/gate/{ticker,klines}.ts` | - | 无（每次重新拉） |
| 汇率获取 | USDT → CNY | `core/gate/fx.ts` (CoinGecko) | - | 进程内 1h TTL（`fx.ts:10`） |
| 指标计算 | MA + 趋势 | `core/indicators/{ma,trend}.ts` | - | 无 |
| 报告渲染 | Markdown / 平台适配 | `core/message/{builder,formatter}.ts` | `reports.message` 落库 | 无 |
| Telegram 推送 | Bot API sendMessage | `core/notify/telegram.ts` | - | 无 |
| 飞书推送 | Incoming Webhook text | `core/notify/feishu.ts` | - | 无 |
| 报表持久化 | 全量 message + summary | `core/models/report.ts` | `reports` 表 | 无 |
| 报表重发 | 用历史 message 直接重推 | `core/task.ts:resendReport` | `reports` 表 | 无 |
| 账密登录 | session token | `util/auth.ts` + `models/session.ts` | `sessions` 表 | 无 |
| Web 配置编辑 | 增删改查 + 拖拽排序 | `api/coins.ts` + `pages/Coins.tsx` | `coins` 表 | 配置改完 reload，调度热重启 |
| HTTP 框架 | trie 路由 + 中间件 | `http/{router,middleware}.ts` | - | - |
| 数据源适配 | fetch + retry + DoH | `util/http.ts` (213 行) | - | DoH IP 缓存 `dohCache` |
| 容器化 | 5 阶段多阶段构建 | `Dockerfile` | `./data` 卷 | - |
| 健康检查 | `/api/status` | `docker-compose.yml` healthcheck | - | - |

---

## 5. 数据流

### 5.1 一次完整推送请求的生命周期

```
cron 触发 (每 30min)
    │
    ▼
scheduler.ts:24 → runTask('cron')
    │
    ▼
task.ts:54 runTask()
    │
    ├─► coins = listEnabledCoins()          [SQLite]
    │
    ├─► Promise.all(coins.map(fetchOne))   [并行]
    │       │
    │       └─► gate/ticker.ts + gate/klines.ts  [HTTPS → gate.io]
    │              │
    │              └─► fetch failed? → 标 source='failed'，继续跑其他
    │
    ├─► getUsdtToCnyRate()                 [CoinGecko, 1h 缓存]
    │
    ├─► buildMessage(results, fx)          [Markdown]
    │
    ├─► Promise.all([
    │       sendToTG(message),             [Telegram Bot API]
    │       sendToFeishu(message)          [飞书 Webhook]
    │    ])
    │
    ├─► createReport({...})                [SQLite 持久化]
    │
    └─► return { reportId, success, ... }
```

### 5.2 HTTP 请求处理链

```
IncomingMessage
    │
    ▼
server.ts:listen → handleRequest
    │
    ▼
middlewares chain:  [logger, error, jsonBody, static?] → [auth] → handler
    │
    ▼
router.ts:match(method, pathname)  → trie 树查找
    │
    ▼
handler(ctx) → sendOk / sendError
```

### 5.3 数据获取层（DoH 兜底流程）

```
httpGet(url)
    │
    ├─► resolveHostname(url, doh)
    │       │
    │       ├─► 系统 DNS（默认）
    │       │
    │       └─► DoH 1.1.1.1（如果开启且不在 bypass）
    │              │
    │              └─► 解析出 IP → URL 改用 IP + dispatcher 带 servername(SNI)
    │
    ▼
fetchWithRetry
    │  失败 → sleep(500 * attempt) → 重试 (max_retries 次)
    │
    ▼
HttpError / HttpResponse
```

### 5.4 缓存层（仅一处）

| 层 | 位置 | 策略 | TTL |
|----|------|------|-----|
| 汇率 | `gate/fx.ts:10` | 进程内 Map | 1 小时 |
| DoH 解析 | `util/http.ts:37` | hostname → IP | 永久（直到进程重启）|
| undici Dispatcher | `util/http.ts:88` | 按 hostname 缓存 | 永久 |

---

## 6. 部署架构

### 6.1 推荐部署形态

```
┌────────────────────────────────────────────────────────────┐
│                      Docker Host                           │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  Container: crypto-price-bot (node:22.20-alpine)    │ │
│  │  ┌──────────────────────────────────────────────┐    │ │
│  │  │  tini (PID 1)                               │    │ │
│  │  │    └─► node dist/index.js                   │    │ │
│  │  │         ├─► HTTP :8787                       │    │ │
│  │  │         ├─► Scheduler (croner)               │    │ │
│  │  │         └─► SQLite (./data/crypto.db)        │    │ │
│  │  └──────────────────────────────────────────────┘    │ │
│  │  Volume: ./data:/app/data                             │ │
│  │  Port: 8787 → host:8787                               │ │
│  │  Healthcheck: GET /api/status (30s)                   │ │
│  └──────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
              │                          │
              ▼                          ▼
┌──────────────────────┐    ┌──────────────────────┐
│  Web Dashboard      │    │  Telegram / 飞书     │
│  Browser            │    │  推送目标            │
└──────────────────────┘    └──────────────────────┘
```

### 6.2 GitHub Actions 兜底模式

当本机服务宕机时，GH Actions 每 30min 触发一次独立运行：

```
workflow_dispatch / schedule (*/30 * * * *)
    │
    ▼
node dist/index.js  （GITHUB_ACTIONS=true）
    │
    ├─► bootstrap() 检测到 GITHUB_ACTIONS
    │
    ├─► 跳过 startScheduler()
    │
    ├─► runTask('manual')  跑一次
    │
    └─► setTimeout(shutdown, 5000) → 退出
```

**Secrets 依赖：** `TG_BOT_TOKEN` / `TG_CHAT_ID` / `FEISHU_WEBHOOK_URL`

---

## 7. 架构评估

### 7.1 过设计检测（[需人工确认]）

| 维度 | 检测项 | 状态 | 说明 |
|------|--------|------|------|
| 数据库 | 表数量 | ✅ 5 张，规模合理 | users / sessions / settings / coins / reports |
| 数据库 | 字段数量 | ✅ 最多 14 字段（reports） | 合理 |
| 数据库 | 冗余表 | ✅ 无 | stats 表按需可加 |
| API | 相似路径 | ✅ 无 | `/api/coins` 风格统一 |
| API | 未使用端点 | ⚠️ `/api/logs`（logs.ts） | 需确认前端是否真的展示日志 |
| 代码 | 长文件 | ⚠️ `web/pages/Coins.tsx` 224 行 / `util/http.ts` 213 行 | http.ts 是核心基建，可接受；Coins.tsx 是 CRUD 密集型，可拆 |
| 代码 | 死代码 | ✅ `gate/notify` 子目录无 `index.ts` barrel，但所有引用都直接走具体文件 | 健康 |
| 代码 | 注释行 | ✅ 注释密度高，关键模块都有 JSDoc | - |

### 7.2 性能指标（[需运行时确认]）

| 指标 | 期望值 | 备注 |
|------|--------|------|
| 启动时间 | < 2s | 无重型 init，主要是 SQLite migrate + 11 行 seed |
| 单次 runTask 耗时 | 2~5s | 11 个币种并行 + 汇率 + 2 推送通道 |
| API 响应时间 | < 50ms（p95） | 全部走 SQLite，无远程 IO |
| 内存占用 | < 100MB | Node + undici dispatcher cache + SQLite WAL |
| 镜像大小 | < 200MB | multi-stage + alpine + prune devDeps |

### 7.3 可扩展性

| 维度 | 评分 | 说明 |
|------|------|------|
| 无状态 | ★★★★★ | 进程内存只缓存汇率（可重启重建） |
| 配置外置 | ★★★★★ | env + DB 双层，env 覆盖 DB，热重载 |
| 模块耦合 | ★★★★ | `core/` 模块化清晰；`gate/` 目录暗示了未来扩展（"data source adapter"） |
| 横向扩展 | ★★ | 单实例设计；如需多实例需要外部 session store（目前 session 落 SQLite 本地） |

### 7.4 安全

| 维度 | 状态 | 说明 |
|------|------|------|
| 密码哈希 | ✅ bcryptjs | 纯 JS 实现，无 native 编译依赖 |
| Session | ⚠️ DB 存储 | 进程内无 token 黑名单；登出仅删 DB 行 |
| CSRF | ⚠️ 无显式保护 | 同源 + Bearer token + SameSite=Lax 隐式保护 |
| SQL 注入 | ✅ 参数化查询 | 全部用 prepared statement |
| 密钥管理 | ✅ env 注入 | `AUTH_SECRET` 可外部注入；默认 fallback 到 dbPath hash（不理想） |
| HTTPS | ⚠️ 由反向代理承担 | 应用层只听 HTTP |
| 依赖审计 | [需运行时确认] | `npm audit` 应在 CI 中跑 |
| 鉴权中间件 | ✅ 在受保护路由前插入（`index.ts:110`） | 顺序正确 |

### 7.5 单点故障 (SPOF) 清单

| SPOF | 严重度 | 已发生？ | 建议 |
|------|--------|----------|------|
| **gate.io API（数据源）** | 🔴 **P0** | ✅ **是，2026-07-02 22:00 起持续 13.5h+** | 加 Binance / Bybit / CoinGecko fallback |
| **CoinGecko（汇率源）** | 🟠 P1 | ✅ 是（同次故障） | 加 exchangerate.host / frankfurter 兜底 |
| **SQLite** | 🟡 P2 | 否 | WAL 模式 + 卷挂载；高并发写才成问题 |
| **单一 Node 进程** | 🟡 P2 | 否 | 单实例足够；如需 HA 需迁移到 Postgres |
| **Telegram Bot API** | 🟢 已备份 | `ok=false` 长期存在 | 排查 bot token / chat_id / 网络代理 |
| **飞书 Webhook** | 🟢 已备份 | 同上 | 与 TG 互为冗余 |
| **Cloudflare DoH** | 🟡 P2 | ✅ 是 | 网络层兜底；可加 Google DoH (`8.8.8.8`) 备选 |

---

## 8. 优化路线图

### Phase 1（P0，本周内）

| # | 任务 | 估时 | 触发条件 |
|---|------|------|----------|
| 1 | **多数据源 fallback**：`core/gate/` 拆出 `sources/{binance,bybit,coingecko}.ts`，`task.ts:fetchOne` 串行试 3 个源 | 半天 | gate.io 故障再次出现立即开做 |
| 2 | **修复 usdt/cny fallback 偏高的 bug**：用最近一次成功值替代硬编码 7.2 | 1h | `gate/fx.ts:48` |
| 3 | **从服务器手动验证网络**：`curl -v https://api.gate.io/api/v4/spot/tickers` + `curl -v https://api.binance.com/...` | 30min | 每次故障复盘必做 |

### Phase 2（P1，本月内）

| # | 任务 | 估时 | 说明 |
|---|------|------|------|
| 4 | **推送通道诊断**：跑通 `telegram failed: ok=false` 的真实根因（多半是 bot 没启动 chat） | 2h | `core/notify/telegram.ts:28` |
| 5 | **加备用 DoH**：`util/http.ts` 支持 Google DoH (`8.8.8.8/dns-query`) 备选 + 配置项 | 1h | - |
| 6 | **加 healthcheck 深度指标**：暴露 SQLite WAL 大小、上次成功 runTask 时间、各币种最近成功时间 | 2h | `api/status.ts` |
| 7 | **拆分 Coins.tsx**：224 行拆成 `CoinTable` / `CoinFormModal` / `SortableRow` | 2h | `web/pages/Coins.tsx` |

### Phase 3（P2，下季度）

| # | 任务 | 估时 | 说明 |
|---|------|------|------|
| 8 | **K 线历史入 DB**：避免每次都拉 365 天日线；保留最近 2 年 + 增量更新 | 1 天 | `gate/klines.ts` |
| 9 | **指标预警**：MA 偏离阈值触发额外推送 | 2 天 | `core/indicators/` |
| 10 | **拆分 Web Dashboard**：把后端拆出 user/auth API，方便多实例 | 3 天 | - |
| 11 | **CI 加 npm audit + 覆盖率门禁** | 2h | `.github/workflows/` |
| 12 | **引入 OpenAPI 文档自动生成**（基于 zod schema） | 1 天 | - |

---

## 9. 总结

### 9.1 亮点

- **模块边界清晰**：`api/` `core/` `http/` `util/` 各司其职，没有跨层反向依赖
- **HTTP 框架自研**（trie 路由 + 中间件链）虽然有维护成本，但**做到了零运行时依赖**，启动体积小（仅 better-sqlite3 是 native）
- **DoH 兜底机制**：`util/http.ts` 实现了"IP 直连 + SNI 保持原域名"的精巧方案，绕过 DNS 污染
- **配置热重载**：`onConfigChange` 回调让 cron 规则修改无需重启
- **GitHub Actions 兜底**：环境变量注入即可做 SaaS 化的二级备份
- **测试覆盖良好**：util 全覆盖、router / task / builder 集成测试齐全
- **Docker 镜像优化**：multi-stage + prune devDeps + alpine + tini = < 200MB

### 9.2 痛点（必须修）

1. **🔴 单一交易所数据源**——已经在 2026-07-02 故障中暴露，13.5h+ 全量失败
2. **🟠 汇率 fallback 值 7.2 偏高**——会让用户看到错误价格（应该用 last-known-good）
3. **🟠 Telegram `ok=false` 长期未解决**——推送通道可能完全失灵

### 9.3 改进建议（建议修）

1. `Coins.tsx` 224 行偏大，建议拆分
2. `/api/logs` 端点是否有前端消费？需要确认是否死代码
3. `AUTH_SECRET` 默认 fallback 用 dbPath hash 不安全，应该强制 env 注入
4. SQLite session 存储在多实例场景下不工作，目前单实例够用但需文档化

### 9.4 优先级建议

| 优先级 | 项 | 截止 |
|--------|-----|------|
| 🔴 P0 | 多数据源 fallback（已发生事故） | 本周 |
| 🟠 P1 | 修复 fx fallback + Telegram 诊断 | 本周 |
| 🟡 P2 | Coins.tsx 拆分 + DoH 备选 + CI 门禁 | 下月 |

---

## 附录 A：关键文件位置速查

| 关注点 | 文件 | 行数 |
|--------|------|------|
| 任务编排入口 | `server/src/core/task.ts` | 124 |
| 价格数据源 | `server/src/core/gate/ticker.ts` | 30 |
| K线数据源 | `server/src/core/gate/klines.ts` | 33 |
| 汇率 + 缓存 | `server/src/core/gate/fx.ts` | 57 |
| HTTP 工具（DoH/retry） | `server/src/util/http.ts` | 213 |
| 调度器 | `server/src/core/scheduler.ts` | 69 |
| 配置加载 | `server/src/core/config.ts` | 104 |
| SQLite schema + migrate | `server/src/core/db.ts` | 119 |
| Telegram 推送 | `server/src/core/notify/telegram.ts` | 39 |
| 飞书推送 | `server/src/core/notify/feishu.ts` | 38 |
| 报告渲染 | `server/src/core/message/builder.ts` | 107 |
| 自研 router | `server/src/http/router.ts` | 125 |
| 中间件 | `server/src/http/middleware.ts` | 181 |
| 进程入口 | `server/src/index.ts` | 171 |
| 币种 CRUD API | `server/src/api/coins.ts` | 72 |
| 币种表 UI | `web/src/pages/Coins.tsx` | 224 |

## 附录 B：环境变量清单

| 变量 | 用途 | 默认 |
|------|------|------|
| `PORT` | HTTP 端口 | `8787` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `DATABASE_PATH` | SQLite 文件路径 | `./data/crypto.db` |
| `TIMEZONE` | 时区（cron + 日志） | `Asia/Shanghai` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `INIT_USERNAME` | 首次启动管理员 | `admin` |
| `INIT_PASSWORD` | 首次启动密码 | `admin123456` |
| `TG_BOT_TOKEN` | Telegram Bot Token（env 覆盖 DB） | 空 |
| `TG_CHAT_ID` | Telegram 目标 chat（env 覆盖 DB） | 空 |
| `FEISHU_WEBHOOK_URL` | 飞书 Incoming Webhook（env 覆盖 DB） | 空 |
| `CUSTOM_USER_AGENT` | 自定义 UA（env 覆盖 DB） | 默认 |
| `AUTH_SECRET` | session 签名密钥 | 缺省 → dbPath hash（不安全） |
| `GITHUB_ACTIONS` | GH Actions 模式标记 | - |

## 附录 C：DB Schema 速查

```sql
-- 5 张表
users      (id, username UNIQUE, password_hash, created_at, updated_at)
sessions   (token PK, user_id FK, expires_at, created_at)
settings   (key PK, value, updated_at)        -- 配置 KV
coins      (id, symbol UNIQUE, name, gate_pair, gate_slug, cg_id, sort_order, enabled, created_at, updated_at)
reports    (id, triggered_by, success, total_coins, ok_coins, tg_sent, feishu_sent, message, summary, created_at)
```