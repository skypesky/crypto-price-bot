# Crypto Price Bot 功能清单

## 1. 项目概述

- **产品定位**: 一个自托管的加密货币价格监控机器人，自带 Web Dashboard，定时通过 Telegram 和飞书 Webhook 推送实时价格、技术指标与汇率换算报告。
- **目标用户**: 加密货币投资者 / 量化爱好者 / 团队管理员。需要"配置一次、自动推送"的中文 Telegram / 飞书群组运营场景。
- **核心价值**: 单二进制自部署（含 Web 前后端 + SQLite + Docker 镜像 < 200MB）；所有配置（币种、推送通道、调度规则、汇率、DoH）可视化编辑，立即生效；技术指标（MA + 多周期趋势）+ 中英双计价 + 多通道独立失败容错。

## 2. 功能模块全景

| ID  | 模块                | 说明                                              |
| --- | ------------------- | ------------------------------------------------- |
| M1  | 认证与会话模块      | 账密登录、session cookie、登出、auth middleware   |
| M2  | 用户与账号模块      | 管理员初始化、修改密码、bcrypt 哈希               |
| M3  | 币种管理模块        | CRUD + 拖拽排序 + 启停                            |
| M4  | 系统设置模块        | 推送/调度/数据源/高级，DB + env 双层热生效        |
| M5  | 报表历史模块        | 历史快照、详情查看、按通道重发                    |
| M6  | 任务调度与执行模块  | cron 6 段调度、立即执行、单次模式（GitHub Actions）|
| M7  | 系统状态与监控模块  | /api/status 全景指标、/api/logs 环形日志          |
| M8  | 数据采集模块        | Gate.io ticker/klines、CoinGecko USDT/CNY 汇率    |
| M9  | 推送通知模块        | Telegram Bot API、飞书 Incoming Webhook           |
| M10 | Web Dashboard 前端  | React 18 + AntD 5，6 个页面 + 1 套主布局          |

### 模块依赖关系图

```
                ┌──────────────────┐
                │  M10 Web UI      │
                │  (Login/Dashboard│
                │  Coins/.../Acct) │
                └─────┬────────────┘
                      │ HTTP+Cookie
        ┌─────────────┼──────────────────────┐
        ▼             ▼                      ▼
  ┌──────────┐  ┌──────────┐         ┌──────────────┐
  │ M1 认证  │  │ M2 用户  │         │ M3 币种管理  │
  │ session  │←→│ (账号)   │         │ (listEnabled)│
  └────┬─────┘  └────┬─────┘         └──────┬───────┘
       │              │                     │
       │ cookie       │ createUser          │ listEnabledCoins
       ▼              ▼                     ▼
  ┌──────────────────────────────────────────────┐
  │ M4 设置 / M5 报表 / M6 任务 / M7 状态/日志  │
  │            （共享 DB + Config）              │
  └─────┬──────────────────────┬─────────────────┘
        │ runTask               │ getConfig
        ▼                       ▼
  ┌──────────────┐         ┌──────────────┐
  │ M8 数据采集  │         │ M9 推送通知  │
  │ Gate.io FX   │         │ TG / 飞书    │
  └──────────────┘         └──────────────┘
```

横切关注点（被所有模块使用）：`util/logger`（结构化日志 + 环形缓冲）、`util/http`（带超时/重试/DoH 兜底的 fetch）、`http/middleware`（鉴权、JSON body、错误兜底）、`http/router`（自实现 trie 路由器）、`core/db`（better-sqlite3 连接 + 自动迁移）。

## 3. 模块详情

### M1 — 认证与会话模块 (P0)

**目标**: 用账密登录换取 7 天有效的 session cookie，作为后续 API 调用的身份凭证。
**主要角色**: Web Dashboard 用户（系统管理员）
**复杂度**: 中
**核心功能**: 登录、登出、session 校验中间件
**关键依赖**: bcryptjs（密码哈希）、HMAC-SHA256（备用 token 算法，本项目用随机串）、better-sqlite3（sessions 表）

| ID    | 功能     | 子功能                                          | 优先级 |
| ----- | -------- | ----------------------------------------------- | ------ |
| F1.1  | 登录     | 账密登录校验 SF1.1.1                            | P0     |
| F1.1  | 登录     | 创建 session 并写入 cookie SF1.1.2             | P0     |
| F1.2  | 登出     | 清除 session 记录 + 清除 cookie SF1.2.1        | P0     |
| F1.3  | 会话校验 | cookie → session 查找 + 过期判定 SF1.3.1       | P0     |
| F1.3  | 会话校验 | 全局 authMiddleware 公开白名单 SF1.3.2         | P0     |

**端点**:
- `POST /api/auth/login` (public) → `{ username, password }` → 200 `{ data: { username } }` + Set-Cookie `cpb_session`；401 invalid；400 schema
- `POST /api/auth/logout` (auth) → 200 `{ data: { ok: true } }`
- （隐式）`authMiddleware` 拦截非白名单 `/api/*`，无 cookie 或过期 → 401

**业务规则**:
- session TTL = 7 天（`SESSION_TTL_MS`），cookie 同步 `Max-Age=7d`
- cookie 配置：`httpOnly=true; sameSite=Strict; path=/`
- 公开白名单：`/api/status`, `/api/auth/login`（登录前需要 status 看后端是否健康）
- 改密后**全部 session 失效**（强制重登），当前 session 不保留

### M2 — 用户与账号模块 (P0)

**目标**: 管理系统唯一的角色——管理员；首次启动自动创建默认用户；登录后改密。
**主要角色**: 管理员
**复杂度**: 简单
**核心功能**: 默认用户初始化、修改密码
**关键依赖**: bcryptjs（cost=10）、session 模块（被踢下线）

| ID    | 功能     | 子功能                                  | 优先级 |
| ----- | -------- | --------------------------------------- | ------ |
| F2.1  | 初始化   | 首启 users 表为空时创建默认用户 SF2.1.1 | P0     |
| F2.2  | 修改密码 | 校验旧密码 + 哈希新密码 + 失效所有 session SF2.2.1 | P0     |

**端点**:
- （内部）`createUser(username, password)` — 无 endpoint
- `POST /api/auth/change-password` (auth) → `{ oldPassword, newPassword }` → 200；401 旧密码错；400 schema

**业务规则**:
- 默认用户名/密码来自 env：`INIT_USERNAME` / `INIT_PASSWORD`，未设置则 `admin` / `admin123456`，日志明确警告需改密
- 改密要求：新密码 ≥ 8 字符
- 改密不要求 admin 角色——任何登录用户都可改自己密码（即唯一用户）

### M3 — 币种管理模块 (P0)

**目标**: 维护"监控币种清单"——symbol、名称、各数据源标识、是否启用、显示顺序。
**主要角色**: 管理员
**复杂度**: 中
**核心功能**: CRUD、拖拽排序、启停
**关键依赖**: DB（coins 表 + 索引 sort_order）、前端 dnd-kit（拖拽）

| ID    | 功能     | 子功能                                | 优先级 |
| ----- | -------- | ------------------------------------- | ------ |
| F3.1  | 列表     | 全部币种（按 sort_order）SF3.1.1      | P0     |
| F3.2  | 新增     | 表单校验 + UNIQUE 防重 SF3.2.1        | P0     |
| F3.3  | 编辑     | 部分字段 PATCH SF3.3.1                | P0     |
| F3.4  | 删除     | 单条删除 SF3.4.1                      | P0     |
| F3.5  | 排序     | 拖拽后批量更新 sort_order SF3.5.1     | P0     |
| F3.6  | 启停     | 单字段切换 enabled SF3.6.1            | P0     |

**端点**:
- `GET /api/coins` (auth) → `Coin[]`
- `POST /api/coins` (auth) → `Coin`，400 schema；409 symbol 重复
- `PUT /api/coins/:id` (auth) → `Coin`；400 invalid id / schema；404 不存在
- `DELETE /api/coins/:id` (auth) → `{ ok: true }`；404
- `POST /api/coins/reorder` (auth) → `{ ids: number[] }` → `Coin[]`

**业务规则**:
- `symbol`：1-16 位大写字母+数字
- `name`：1-64 字符（中文友好）
- `gate_pair`：形如 `BTC_USDT`，稳定币可空
- `gate_slug`：小写字母/数字/连字符，决定 gate.com 链接
- `cg_id`：CoinGecko 的币种 ID，必填
- `enabled` / `sort_order` 整数，0/1 语义
- 首启若 coins 表为空，自动插入 12 个默认币种（BTC/ETH/USDT/SOL/ABT/BNB/FIL/ATOM/OP/GT/YGG/SAGA，ICX 已移除）

### M4 — 系统设置模块 (P0)

**目标**: 用一份键值表承载运行时所有可调参数；DB 优先，env 覆盖，热生效。
**主要角色**: 管理员
**复杂度**: 中
**核心功能**: 读取、批量更新（保存即生效）
**关键依赖**: zod（schema 校验）、config（reloadConfig 触发 listener）、scheduler（监听 onConfigChange 自动重排）

| ID    | 功能     | 子功能                            | 优先级 |
| ----- | -------- | --------------------------------- | ------ |
| F4.1  | 读取配置 | 返回全部键默认值（缺失时）SF4.1.1 | P0     |
| F4.2  | 保存配置 | zod 校验 + 批量 UPSERT + reload SF4.2.1 | P0     |

**端点**:
- `GET /api/settings` (auth) → `Record<key, value>`（含默认值）
- `PUT /api/settings` (auth) → `Record<key, value>`（部分字段），立即生效

**业务规则**:
- 12 个 setting key：`tg_bot_token / tg_chat_id / feishu_webhook_url / timezone / schedule_rule / usdt_to_cny / ua / doh_enabled / doh_server / doh_bypass / request_timeout_ms / max_retries`
- `schedule_rule` 必须是 6 段 cron（含秒）
- `doh_bypass` 数组，DB 存 JSON 数组
- `feishu_webhook_url` 校验 URL 或空
- `request_timeout_ms` ≤ 120000；`max_retries` ≤ 5
- env 启动时覆盖：TG_BOT_TOKEN / TG_CHAT_ID / FEISHU_WEBHOOK_URL / TIMEZONE / CUSTOM_USER_AGENT
- 保存触发 `reloadConfig` → scheduler 重新挂 cron 表达式

### M5 — 报表历史模块 (P0)

**目标**: 持久化每次任务执行的快照（推送内容 + 各通道结果），支持查看与按通道重发。
**主要角色**: 管理员
**复杂度**: 简单
**核心功能**: 列表、详情、重发
**关键依赖**: task（resendReport 复用 sendToTG/sendToFeishu）、reports 表

| ID    | 功能     | 子功能                                | 优先级 |
| ----- | -------- | ------------------------------------- | ------ |
| F5.1  | 报表列表 | 倒序分页 SF5.1.1                      | P0     |
| F5.2  | 报表详情 | 单条 + 原始 message SF5.2.1           | P0     |
| F5.3  | 重发     | 选择通道（TG/飞书）重发历史文本 SF5.3.1 | P0     |

**端点**:
- `GET /api/reports?limit=50` (auth) → `Report[]`
- `GET /api/reports/:id` (auth) → `Report`；404
- `POST /api/reports/:id/resend` (auth) → `{ channels: ('tg'|'feishu')[] }` → `{ tg, feishu }`

**业务规则**:
- `triggered_by`: cron / manual / test / resend
- `message` 字段为完整 Markdown 文本（与推送一致）
- `summary` 字段为 JSON（含每个币种的 ok/error）
- 重发不重跑数据，**只复用历史 message**
- 重发某通道时若该通道上次失败，UI 显示"重发"按钮（disabled 状态由后端不约束）

### M6 — 任务调度与执行模块 (P0)

**目标**: 拉取行情 → 计算指标 → 推送 → 落库一条龙；可定时、可手动、也可单次模式（CI/CD）。
**主要角色**: 系统 + 管理员
**复杂度**: 复杂
**核心功能**: 立即执行、cron 调度、单次模式、下次时间查询
**关键依赖**: gate（ticker/klines/fx）、notify（telegram/feishu）、message（builder）、reports（持久化）、croner

| ID    | 功能       | 子功能                                 | 优先级 |
| ----- | ---------- | -------------------------------------- | ------ |
| F6.1  | 立即执行   | POST /api/task/run 触发整条流水 SF6.1.1 | P0     |
| F6.2  | 下次时间   | GET /api/task/next 计算 nextRunAt SF6.2.1 | P0     |
| F6.3  | 定时调度   | croner 6 段 cron + 时区 + 热重排 SF6.3.1 | P0     |
| F6.4  | 单次模式   | GITHUB_ACTIONS=true 时执行一次后退出 SF6.4.1 | P0     |

**端点**:
- `POST /api/task/run` (auth) → `{ reportId, success, totalCoins, okCoins, tgSent, feishuSent }`
- `GET /api/task/next` (auth) → `{ nextRunAt: ISOString | null }`

**业务规则**:
- 执行流程：listEnabledCoins → 并行 fetchOne(ticker + klines) → getUsdtToCnyRate → buildMessage → 并行 sendToTG/sendToFeishu → createReport
- 任一币种 ticker 失败不中断其他币种，最终 `okCoins > 0` 视为 success
- TG / 飞书并行推送，任一通道失败不影响另一通道；都失败仍生成 report（success=false）
- `cron` 6 段（含秒），默认 `0 */30 * * * *`（每 30 分钟整点）
- 时区默认 `Asia/Shanghai`，可改
- 修改 `schedule_rule` / `timezone` 立即生效（config listener）
- GitHub Actions 模式：scheduler 不启动；执行完 5s 后优雅退出（避免连接被 SIGKILL 截断）

### M7 — 系统状态与监控模块 (P1)

**目标**: 暴露给前端的健康指标与运行日志，方便排查。
**主要角色**: 管理员
**复杂度**: 简单
**核心功能**: 状态总览、日志查看
**关键依赖**: logger（环形缓冲 500 条）

| ID    | 功能       | 子功能                              | 优先级 |
| ----- | ---------- | ----------------------------------- | ------ |
| F7.1  | 系统状态   | 返回 9 项核心指标 SF7.1.1           | P1     |
| F7.2  | 日志查询   | 内存环形缓冲最新 N 条 SF7.2.1       | P1     |

**端点**:
- `GET /api/status` (public) → `{ version, uptime, dbOk, sqliteVersion, totalCoins, userCount, nextRunAt, lastReportAt, timezone, scheduleRule }`
- `GET /api/logs?limit=200` (auth) → `LogEntry[]`（最大 500）

**业务规则**:
- `/api/status` 公开（登录前用于探测后端健康）
- 日志通过 `logger.recent(limit)` 返回结构化 JSON
- 级别可调：`LOG_LEVEL=debug|info|warn|error`

### M8 — 数据采集模块 (P0)

**目标**: 从外部源（Gate.io / CoinGecko）拉数据；带超时、重试、DoH 兜底。
**主要角色**: 系统
**复杂度**: 中
**核心功能**: ticker、klines、USDT/CNY 汇率
**关键依赖**: util/http（DoH + undici agent）、croner 不相关

| ID    | 功能       | 子功能                              | 优先级 |
| ----- | ---------- | ----------------------------------- | ------ |
| F8.1  | 实时行情   | gate.io /api/v4/spot/tickers SF8.1.1 | P0     |
| F8.2  | 历史K线    | gate.io /api/v4/spot/candlesticks SF8.2.1 | P0     |
| F8.3  | USDT/CNY   | CoinGecko simple/price + 1h 缓存 + fallback SF8.3.1 | P0     |

**业务规则**:
- 行情路径：`GET /api/v4/spot/tickers?currency_pair=XXX_USDT`，取首条
- K线：`GET /api/v4/spot/candlesticks?interval=1d&limit=365`，按时间升序
- USDT/CNY：缓存 1 小时；CoinGecko 失败时回落 `config.usdt_to_cny`
- 稳定币（gate_pair=null）跳过拉取，ticker 视为 `{ last: '1.0' }`，source='stable'
- HTTP 工具统一：`timeoutMs` + `retries` + 备用 DoH（飞书强制不走 DoH，因为 CDN 节点拒绝直连 IP）

### M9 — 推送通知模块 (P0)

**目标**: 把 Markdown 报告文本投递到 Telegram Bot 和飞书 Incoming Webhook；任一通道失败不影响另一通道。
**主要角色**: 系统
**复杂度**: 中
**核心功能**: Telegram 推送、飞书推送
**关键依赖**: util/http、message/formatter（飞书纯文本规范化）

| ID    | 功能     | 子功能                                | 优先级 |
| ----- | -------- | ------------------------------------- | ------ |
| F9.1  | TG 推送  | POST sendMessage Markdown SF9.1.1     | P0     |
| F9.1  | TG 推送  | 缺 token/chat_id 短路返回 SF9.1.2     | P0     |
| F9.2  | 飞书推送 | 规范化 Markdown→纯文本 + text 类型 SF9.2.1 | P0     |
| F9.2  | 飞书推送 | 缺 webhook 短路返回 SF9.2.2           | P0     |

**业务规则**:
- TG：`https://api.telegram.org/bot{token}/sendMessage`；参数 `parse_mode=Markdown, disable_web_page_preview=true`
- TG 未配置：返回 `{ ok: false, error: 'telegram not configured' }`，不抛异常
- 飞书：`msg_type: text` + `content.text`；`normalizeMessageForTextChannel` 把 `[x](y)` 变 `x: y`，去 `*_`
- 飞书 CDN 对 DoH 解析 IP 直连返回 403，因此飞书推送 **强制 doh=null**
- 通道独立失败返回 `{ ok, error }`，由 task 层决定整体 success

### M10 — Web Dashboard 前端模块 (P0)

**目标**: 提供一个 Ant Design 5 风格的 SPA，6 个页面 + 1 套主布局，把后端 API 包装成"管理员友好的操作面板"。
**主要角色**: 管理员（通过浏览器）
**复杂度**: 中
**核心功能**: 路由、布局、6 个页面、API 客户端
**关键依赖**: React 18、AntD 5、@dnd-kit、dayjs、react-router-dom（HashRouter）

| ID     | 功能      | 子功能                                | 优先级 |
| ------ | --------- | ------------------------------------- | ------ |
| F10.1  | 路由      | HashRouter 6 路径 + ProtectedRoute SF10.1.1 | P0     |
| F10.2  | 主布局    | 左侧菜单 + 顶部栏 + Outlet SF10.2.1   | P0     |
| F10.3  | 登录页    | 用户名/密码 + 跳 dashboard SF10.3.1    | P0     |
| F10.4  | Dashboard | 4 张统计卡 + 立即执行 + 最近 5 份 SF10.4.1 | P0     |
| F10.5  | 币种页    | 拖拽表格 + 启停 + 模态框 CRUD SF10.5.1 | P0     |
| F10.6  | 设置页    | 4 Tab 表单（推送/调度/数据源/高级）SF10.6.1 | P0     |
| F10.7  | 报表页    | 表格 + Drawer 详情 + 重发按钮 SF10.7.1 | P0     |
| F10.8  | 改密页    | 三字段（当前/新/确认）表单 SF10.8.1    | P0     |
| F10.9  | API 客户端 | fetch wrapper + 自动 cookie + 401 重定向 SF10.9.1 | P0     |

**业务规则**:
- HashRouter：`#/login`（公开）、`#/dashboard`、`#/coins`、`#/settings`、`#/reports`、`#/account`
- ProtectedRoute：无 cookie 时渲染时跳 `#/login`
- 401 由 `apiClient` 拦截并跳登录
- 拖拽：PointerSensor，4px 触发距离，避免误触
- 立即执行 → POST `/api/task/run` → message.success 显示 okCoins/totalCoins
- 设置保存 → 全部 Tab 一起 form.validateFields() → PUT `/api/settings`（不分批）

## 4. MVP 范围建议

### P0 — 必须（MVP）
- M1 认证会话：F1.1 登录、F1.2 登出、F1.3 会话校验
- M2 用户账号：F2.1 初始化、F2.2 改密
- M3 币种管理：F3.1 列表、F3.2 新增、F3.3 编辑、F3.4 删除、F3.5 排序、F3.6 启停
- M4 系统设置：F4.1 读取、F4.2 保存
- M5 报表历史：F5.1 列表、F5.2 详情、F5.3 重发
- M6 任务调度：F6.1 立即执行、F6.2 下次时间、F6.3 定时调度、F6.4 单次模式
- M8 数据采集：F8.1 ticker、F8.2 klines、F8.3 USDT/CNY
- M9 推送通知：F9.1 TG、F9.2 飞书
- M10 Web 前端：F10.1-F10.9 全部

### P1 — 增强体验
- M7 状态与日志：F7.1 status、F7.2 logs（已有 API，前端仅在 Settings/Dashboard 展示 status，logs 暂未做页面）

### P2 — 扩展功能
- 多用户 / 角色管理
- 报表导出 CSV
- 价格阈值告警
- 微信 / 钉钉 / Discord 通道
- 自定义消息模板
- 多账户（多 tg_chat_id 群发）

## 5. 复刻检查清单

按本文档重建时按以下顺序验证：

- [ ] **M1 认证**：账密登录 200 + cookie 设置；logout 清 cookie；未登录访问受保护路由 401
- [ ] **M2 用户**：首次启动创建默认用户并打印警告；改密后旧 session 失效
- [ ] **M3 币种**：默认 11 币种入 DB；CRUD + 拖拽排序生效；启停只影响 listEnabledCoins
- [ ] **M4 设置**：保存后 `getConfig()` 返回新值；`schedule_rule` 修改后 cron 立即重排
- [ ] **M5 报表**：任务执行后 reports 表多一条；详情 message 字段完整；重发走对应通道
- [ ] **M6 任务**：`POST /api/task/run` 走完整流水；`GET /api/task/next` 返回 ISO 时间；GitHub Actions 模式跑一次后退出
- [ ] **M7 状态**：`/api/status` 返回 9 项指标；`/api/logs` 返回结构化日志
- [ ] **M8 数据**：ticker/klines 解析正确；USDT/CNY 1h 缓存；CoinGecko 失败回落 settings
- [ ] **M9 推送**：TG Markdown 渲染正确；飞书纯文本无 markdown 字符；任一通道失败不影响另一通道
- [ ] **M10 前端**：6 个页面在路由内可访问；登录态持久化 7 天；401 自动跳登录
- [ ] **横切**：util/logger 环形缓冲 500 条；util/http DoH 兜底 1.1.1.1；http/middleware 鉴权白名单
- [ ] **数据迁移**：旧 DB 无 `gate_slug` 时自动 ALTER 并回填 11 个默认币种
- [ ] **部署**：Dockerfile 多阶段构建 < 200MB；非 root 运行；TZ=Asia/Shanghai

## 6. 备注

- **未覆盖的边缘功能**：`util/id.ts`（随机 token 生成）、`http/errors.ts`（错误类型）、`http/response.ts`（统一响应包络 `{ data, error? }`）属于横切工具，未单列功能。
- **测试覆盖**：核心模块均有 `*.test.ts`（`builder.test.ts`、`models.test.ts`），使用 vitest。功能行为以测试为权威。
- **CI/CD**：`.github/workflows/price-report.yml` Node 22 + 每 6 小时运行一次，依赖 5 个 GitHub Secrets（INIT_USERNAME / INIT_PASSWORD / TG_BOT_TOKEN / TG_CHAT_ID / FEISHU_WEBHOOK_URL）。
- **已知限制**：
  - 飞书 Webhook 对 DoH 解析出的 CDN IP 直连返回 403，因此飞书推送强制走 undici 默认 DNS。
  - `doh_bypass` 默认含 `1.1.1.1 / one.one.one.one / cloudflare-dns.com`，避免 DoH 自身被污染。
  - 旧版本 DB 缺 `gate_slug` 列，启动时自动迁移并按 symbol 回填。
- **依赖升级注意**：`croner` 仅支持 6 段 cron（含秒），迁移到 5 段需要先 `npx croner-trim`。
