# Crypto Price Bot v2 — 跑通 & 30 分钟飞书推送 设计与验证计划

> 日期：2026-07-06
> 状态：草案，等用户复核
> 上一份：[`2026-06-16-crypto-price-bot-v2-design.md`](./2026-06-16-crypto-price-bot-v2-design.md)（v2 整体设计，本文档不重复）
> 范围：在 macOS 上把 v2 实现端到端跑通，让用户每 30 分钟在飞书群收到一份所关注币种的 Markdown 报告

---

## 1. 背景与目标

v2 主体代码（server + web + SQLite + croner + 飞书/TG 推送 + Web UI）已经基本完成：

- 17 次提交，最新 `2ce946f fix(server): feishu/klines correctness + live FX rate`
- 123 个单元测试通过（`vitest run`，server + web 共 15 个 spec 文件）
- `tsc --noEmit` 双侧（`server/` 和 `web/`）exit=0
- `.env` 已存在并填好 `FEISHU_WEBHOOK_URL`、`TG_BOT_TOKEN`、`TG_CHAT_ID`、`INIT_USERNAME`、`INIT_PASSWORD`、`DATABASE_PATH`
- 默认 12 个币种（BTC/ETH/USDT/SOL/ABT/BNB/FIL/ATOM/OP/GT/YGG/SAGA，ICX 已移除）首启自动入库
- Docker 镜像与 `docker-compose.yml` 已写好（多阶段、`tini`、`TZ=Asia/Shanghai`、`./data:/app/data`）

但以下两项从未在真实环境端到端跑过：

1. 整套代码在 macOS + Docker 上能否启动到健康状态。
2. 用户每 30 分钟能否在飞书群收到一份所关注币种的推送。

并且代码工作区有 **9 个文件 74 行的未提交改动**（围绕 `gate_slug` 字段），从未落盘入库。

### 1.1 本次目标

把 `crypto-price-bot` v2 端到端跑通，并配置成 "每 30 分钟飞书推用户所关注币种" 的窄范围场景。

### 1.2 非目标（YAGNI）

- 不重写任何现有模块。
- 不引入新的依赖。
- 不创建独立脚本绕开 Web Dashboard（确认跑通后用户可以随时通过 UI 调配置，调度热重排已实现）。
- 不实测所有 M1–M10 模块；只测与"30 分钟飞书推送" 直接相关的链路。
- 不写新的单元测试（`gate_slug` 已有测试覆盖）。
- 不改动 `Dockerfile` / `docker-compose.yml` / `package.json` / `tsconfig` / release 配置。

### 1.3 成功判据

四条同时成立才算成功：

- `git log` 多一个新提交，含那 9 个未落盘改动 + `function.md` + `infra.md`。
- `docker ps` 看到容器 `Up`，`GET /api/status` 返回 `dbOk=true`、`totalCoins≥11`。
- `POST /api/task/run` 后 30 秒内飞书群收到一份合规 Markdown 报告，`reports` 表新增一条。
- 把 `schedule_rule` 改成 `0 */30 * * * *` 后，等待下一次半点（≤30 分钟），飞书群收到再次推送，`reports` 表又多一条。

---

## 2. 组件边界（不重写，只跑通）

| 角色 | 责任 | 边界 |
|---|---|---|
| 已存在代码 | 行情拉取 / 指标 / 消息构建 / croner 调度 / 飞书 + TG 推送 / SQLite / Web UI / 鉴权 / M1–M10 | 任何模块都不重写 |
| 本次实施 | 跑通端到端验证；配置 30 分钟 + 飞书窄参数；commit 未落盘改动 | — |
| 用户提供 | `FEISHU_WEBHOOK_URL`（已在 `.env`）、"我关注的"币种列表 | — |

**关键事实**：

- 飞书推送有特殊处理：`server/src/core/notify/feishu.ts:34` 强制 `doh=null`，因为飞书 CDN 对 DoH 解析的 IP 直连返回 403。
- 调度热重排已实现：`server/src/core/scheduler.ts:startScheduler()` 监听 `onConfigChange(() => schedule())`，改 `schedule_rule` 后立即重排。
- 旧 DB 兼容：`server/src/core/db.ts:migrate()` 用 `PRAGMA table_info` 检测缺列时 `ALTER TABLE` 加 `gate_slug` 并按 `symbol` 回填 11 个默认币种。

---

## 3. 端到端跑通的 8 步验证矩阵

每步都有可观察证据；不靠叙述、不靠"应该可以"。

| # | 步骤 | 动作命令 | 通过条件（可断言证据） |
|---|---|---|---|
| 1 | 提交未落盘改动 | `git add server web function.md infra.md && git commit -m "..."` | `git log -1` 显示新提交；`git status` 干净 |
| 2 | 构建并启动 Docker 容器 | `make build.docker && make dev.docker` | `docker ps --filter name=cpb` 显示 `Up`；`docker logs cpb` 含 `[app] listening on :8787` |
| 3 | 健康检查 | `curl -s http://localhost:8787/api/status` | JSON 含 `dbOk=true`、`totalCoins≥11`、有 `version` 字段 |
| 4 | 登录取 session | `curl -c cookies.txt -X POST .../api/auth/login -d '{"username":"...","password":"..."}'` | 200；`cookies.txt` 含 `cpb_session=...` |
| 5 | 配置 30 分钟调度 | `curl -b cookies.txt -X PUT .../api/settings -d '{"schedule_rule":"0 */30 * * * *","timezone":"Asia/Shanghai"}'` | `GET /api/task/next` 返回 30 分钟后的 ISO 字符串 |
| 6 | 配置所关注的币种 | `curl -b cookies.txt .../api/coins` 取列表，`DELETE .../api/coins/:id` 删掉不关注的 | `GET /api/coins` 只剩关注币种；全 `enabled=true` |
| 7 | 立即执行看飞书 | `curl -b cookies.txt -X POST .../api/task/run` | 30 秒内飞书群收到报告；DB `reports` 表新增 1 行 |
| 8 | cron 自动触发 | 等待最近一次半点 ≤ 30 分钟 | 飞书群再次收到；DB `reports` 表新增第 2 行 |

### 3.1 关于"我关注的币种"

默认 11 个币种先全部启用。完成步骤 6 的实际删除清单由用户后续在头脑风暴阶段提供（或直接通过 Web Dashboard 操作）。在脚本上不做硬编码。

### 3.2 关于"30 分钟调度"

`schedule_rule` 是 6 段 cron（含秒）。"每 30 分钟整点" 的标准写法：`0 */30 * * * *`，croner 解析后命中每个半点整（`00`、`30` 分钟）。

---

## 4. 错误处理

| 失败模式 | 触发条件 | 排查 / 回退 |
|---|---|---|
| 步骤 2 容器起不来 | `data/` 权限、TZ env、镜像构建错误 | `docker logs cpb`；macOS 上 `chmod 0777 ./data`；确认 `docker compose config` 通过 |
| 步骤 3 健康检查 404/502 | 容器未监听 8787、端口被占 | `docker ps` 看端口映射；`docker logs` 抓 `[app]` 错误 |
| 步骤 4 登录 401 | `.env` 变量未生效、密码改过 | `docker exec cpb printenv \| grep INIT`；首次登录用 INIT 密码 |
| 步骤 5 settings 400 | zod schema 拒绝（如 `schedule_rule` 不是 6 段） | `GET /api/settings` 看默认值；`schedule_rule` 必须含秒 |
| 步骤 7 飞书未到 | webhook URL 错、网络拦、DoH 解析失败 | 看飞书响应 `StatusCode`/`msg`；检查 `doh=null` 仍生效；可 `curl -X POST <webhook>` 测试 webhook 本身 |
| 步骤 8 cron 没触发 | timezone 不是 Asia/Shanghai、调度未启、`GITHUB_ACTIONS=true` 干扰 | 看 `[scheduler] scheduled: ... next=...` 日志；`GET /api/task/next` 算下次时间 |

---

## 5. 测试策略

不写新单元测试。已有 123 个测试覆盖所有未提交的 `gate_slug` 改动。验证分三层：

### 5.1 回归（vitest 单元测试）

- 步骤 2 启动前跑：`cd server && npx vitest run` —— 期望 123/123 通过。
- 步骤 2 启动后再跑：`docker exec cpb npx vitest run` —— 期望同样通过（用容器内的 tsx 跑）。

### 5.2 冒烟（curl + jq 字段断言）

- 步骤 3 status：`jq '.dbOk == true and .totalCoins >= 11'`
- 步骤 4 login：`jq -e '.data.username'` 且 cookie 文件非空
- 步骤 5 settings：`jq -e '.data.schedule_rule'` 等于 `0 */30 * * * *`
- 步骤 7 task/run：`jq -e '.data.success == true and .data.totalCoins >= 1'`

### 5.3 端到端（真人 + DB）

- 步骤 7/8：人眼看飞书群消息；`sqlite3 ./data/cpb.db "SELECT id, triggered_by, summary FROM reports ORDER BY id DESC LIMIT 2"` 看新增行

---

## 6. 提交策略

**一次原子提交**：把那 9 个未落盘改动 + `function.md` + `infra.md` 一次入版本库。

提交包含：

- `server/src/api/coins.ts`
- `server/src/core/db.ts`
- `server/src/core/message/builder.ts`
- `server/src/core/message/builder.test.ts`
- `server/src/core/models.test.ts`
- `server/src/core/models/coin.ts`
- `server/src/util/validate.ts`
- `web/src/api/client.ts`
- `web/src/pages/Coins.tsx`
- `function.md`（v2 功能清单）
- `infra.md`（v2 架构文档）

提交 message：

```
chore: land v2 gate_slug field + design docs
```

不在本次提交中包含的内容：`Dockerfile` / `docker-compose.yml` / `package*.json` / `tsconfig*.json` / 已 committed 的 17 个历史 commit。

---

## 7. 实现前检查（前置条件）

写实现 plan（调用 `superpowers:writing-plans`）前必须满足：

- [x] v2 实现已在 `crypto-price-bot` 仓库 17 次提交之上 90%+ 完成。
- [x] `vitest run` 123/123 通过。
- [x] 双侧 `tsc --noEmit` exit=0。
- [x] `.env` 已就位（`FEISHU_WEBHOOK_URL` 等）。
- [x] 用户选择部署形态 = Docker。
- [x] 用户接受本设计三节叙述。

写实现 plan 时只覆盖：步骤 1（commit）、步骤 2–4（启动 + 健康 + 登录）、步骤 5–6（settings + 币种）、步骤 7（手动推送验证）、步骤 8（cron 验证）。不写"全模块验收" plan。

---

## 8. 与上一份 v2 设计的关系

上一份 [`2026-06-16-crypto-price-bot-v2-design.md`](./2026-06-16-crypto-price-bot-v2-design.md) 描述了 v2 的功能、模块、数据流、API、M1–M10。本文档不重复它，只回答两个新问题：

- 怎么把这套代码端到端跑通。
- 配置成"30 分钟飞书"窄场景后的预期证据。

如未来要验证 M1–M10 全部模块，应另起一份 "v2 验收设计" 文档，与本文件互不重叠。
