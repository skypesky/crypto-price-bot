# Crypto Price Bot v2 — 跑通 & 30 分钟飞书推送 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `crypto-price-bot` v2 在 macOS + Docker 上端到端跑通，并配置成"每 30 分钟飞书群收到所关注币种的 Markdown 报告"。

**Architecture:** 不重写任何模块；在已存在的 server（TS + better-sqlite3 + croner）+ web（Vite + React + AntD）+ SQLite + Docker 多阶段镜像之上，按 8 步验证矩阵跑通。

**Tech Stack:** Node 22 LTS · TypeScript 5 · vitest · better-sqlite3 · zod · croner · Docker Compose · gate.io API · 飞书 Incoming Webhook

**Spec:** [`../specs/2026-07-06-crypto-price-bot-v2-run-design.md`](../specs/2026-07-06-crypto-price-bot-v2-run-design.md)（已批准）

## Global Constraints

- **macOS + Docker Desktop**：所有构建/运行命令假定在 macOS、Docker Desktop 已启动。
- **TZ=Asia/Shanghai**：`docker-compose.yml` 已配置 `TZ=Asia/Shanghai`，容器内 cron 与时间戳都按此时区。
- **数据库**：`./data/cpb.db` 通过 `./data:/app/data` 卷持久化。
- **飞书 DoH 强制 null**：`server/src/core/notify/feishu.ts:34` 强制 `doh=null`。不允许改动此处。
- **调度热重排**：`server/src/core/scheduler.ts:startScheduler()` 监听 `onConfigChange`。改 `schedule_rule` 后立即生效，不需重启容器。
- **API 端口**：8787。前端开发模式 5173 不部署到 Docker；本次只验证后端 API。
- **不动文件**：`Dockerfile` / `docker-compose.yml` / `package.json` / `tsconfig*.json` / 已 committed 的 17 个历史 commit。
- **settings 键**：12 个 — `tg_bot_token` / `tg_chat_id` / `feishu_webhook_url` / `timezone` / `schedule_rule` / `usdt_to_cny` / `ua` / `doh_enabled` / `doh_server` / `doh_bypass` / `request_timeout_ms` / `max_retries`。
- **commit message 风格**：`chore:` / `feat:` / `fix:` / `docs:` 前缀（仓库历史惯例）。

---

## 文件结构

本次计划只 **落盘未提交代码 + 跑通**，不改任何模块代码。

| 路径 | 操作 | 备注 |
|---|---|---|
| `server/src/api/coins.ts` | 落盘 (Task 1) | 含 `gate_slug` 字段处理 |
| `server/src/core/db.ts` | 落盘 (Task 1) | 加 `gate_slug` 列 + ALTER TABLE 回填 |
| `server/src/core/message/builder.ts` | 落盘 (Task 1) | 含 `gate_slug` 在快照里的位置 |
| `server/src/core/message/builder.test.ts` | 落盘 (Task 1) | 测试更新 |
| `server/src/core/models.test.ts` | 落盘 (Task 1) | 测试更新 |
| `server/src/core/models/coin.ts` | 落盘 (Task 1) | 含 `gate_slug` 模型字段 |
| `server/src/util/validate.ts` | 落盘 (Task 1) | 含 `gate_slug` zod schema |
| `web/src/api/client.ts` | 落盘 (Task 1) | 前端 API client |
| `web/src/pages/Coins.tsx` | 落盘 (Task 1) | 前端币种页 |
| `function.md` | 落盘 (Task 1) | v2 功能清单 |
| `infra.md` | 落盘 (Task 1) | v2 架构文档 |
| `docs/superpowers/plans/2026-07-06-crypto-price-bot-v2-run.md` | 本文件新建 | 实施计划 |
| `./data/cpb.db` | 运行时创建 (Task 4+) | SQLite 持久化文件 |

---

## Task 1: 落盘未提交改动 — 一次原子提交

**Files:**
- Modify / Add: 上述 11 个文件
- Test: `git log -1` 显示新提交

**Interfaces:**
- Consumes: 仓库当前未提交状态（12 个文件）
- Produces: `git log` 新增一条提交；`git status` 干净；工作目录无未提交改动

- [ ] **Step 1: 确认 .env 中凭据到位**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
[ -f .env ] && echo "✓ .env exists" || (echo "✗ missing .env" && exit 1)
grep -E '^(FEISHU_WEBHOOK_URL|INIT_USERNAME|INIT_PASSWORD)=' .env | sed 's/=.*/=<redacted>/'
```

Expected: `✓ .env exists` + 三个变量名（非空）。

- [ ] **Step 2: 在 git status 中确认这 11 个文件**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
git status --short server/src/api/coins.ts \
  server/src/core/db.ts \
  server/src/core/message/builder.ts \
  server/src/core/message/builder.test.ts \
  server/src/core/models.test.ts \
  server/src/core/models/coin.ts \
  server/src/util/validate.ts \
  web/src/api/client.ts \
  web/src/pages/Coins.tsx \
  function.md \
  infra.md
```

Expected: 输出每个文件前两列之一是 ` M` (modified) 或 `??` (untracked)。

- [ ] **Step 3: git add 这 11 个文件**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
git add server/src/api/coins.ts \
  server/src/core/db.ts \
  server/src/core/message/builder.ts \
  server/src/core/message/builder.test.ts \
  server/src/core/models.test.ts \
  server/src/core/models/coin.ts \
  server/src/util/validate.ts \
  web/src/api/client.ts \
  web/src/pages/Coins.tsx \
  function.md \
  infra.md
git status --short
```

Expected: 11 行（前面是 `M ` 或 `A `）— 0 行 `??`。

- [ ] **Step 4: 一次原子 commit**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
git commit -m "chore: land v2 gate_slug field + design docs

- server: add gate_slug column with ALTER TABLE migration for legacy DBs
- server: backfill 11 default coins with Gate.com slug
- server: model + zod schema + API patch for gate_slug
- web: client + Coins page send/receive gate_slug
- docs: vendor in v2 functional spec (function.md) and architecture (infra.md)"
```

Expected: 无错误；commit hash 形如 `[master <hash>] chore: land v2 ...`。

- [ ] **Step 5: 验证：git log 显示新提交，git status 干净**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
git log -1 --stat | head -20
git status
```

Expected: 新 commit 顶端；`git status` 输出 "nothing to commit, working tree clean"。

---

## Task 2: 回归基线 — vitest + tsc 双侧 exit=0

**Files:**
- Test: `server/src/**/*.test.ts` (15 spec 文件, 123 测试)
- 静态检查: `server/tsconfig.json` + `web/tsconfig.app.json`

**Interfaces:**
- Consumes: Task 1 后的 working tree
- Produces: 3 条 PASS 证据（`vitest run`、server `tsc`、`web tsc -p tsconfig.app.json`）

- [ ] **Step 1: 运行 server vitest**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot/server
npx vitest run --reporter=basic 2>&1 | tail -10
```

Expected: `Test Files  15 passed (15)` `Tests  123 passed (123)`。

- [ ] **Step 2: 运行 server tsc**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot/server
npx tsc --noEmit; echo "EXIT=$?"
```

Expected: 输出末尾是 `EXIT=0`，无 error TSxxxx 报告。

- [ ] **Step 3: 运行 web tsc**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot/web
npx tsc --noEmit -p tsconfig.app.json; echo "EXIT=$?"
```

Expected: `EXIT=0`。

- [ ] **Step 4: 如有任一失败，定位修复**

> 失败定位建议（按概率序）：
> - vitest 单文件失败 → 看断言失败点，可能要回退 `gate_slug` 改动或补测试
> - tsc server 失败 → 多半是 `db.ts` 或 `models/coin.ts` 新字段类型未对齐；与最近 diff 比对
> - tsc web 失败 → 多半是 `Coins.tsx` 或 `api/client.ts` 类型未对齐

修复后回 Step 1 重新跑。

---

## Task 3: 构建 Docker 镜像

**Files:**
- Build context: 项目根
- Output: Docker image `crypto-price-bot:latest`

**Interfaces:**
- Consumes: Task 2 后的代码 + 已填好的 `.env`
- Produces: 本地有 `crypto-price-bot:latest` 镜像

- [ ] **Step 1: 确认 Docker Desktop 在跑**

```bash
docker info > /dev/null 2>&1 && echo "✓ docker up" || (echo "✗ docker not running" && exit 1)
```

Expected: `✓ docker up`。

- [ ] **Step 2: 构建镜像**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
make build.docker
```

Expected: 末尾输出 `✅ Image built: crypto-price-bot:latest`。首次构建 1–2 分钟（取决于网络）。

- [ ] **Step 3: 验证镜像存在**

```bash
docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' | grep crypto-price-bot
```

Expected: 一行 `crypto-price-bot:latest <size>`，size 在 150–200MB 范围。

---

## Task 4: 启动容器

**Files:**
- Runtime: `docker-compose.yml` + `.env` + `Dockerfile`
- Output: 容器 `crypto-price-bot` `Up (healthy)`

**Interfaces:**
- Consumes: Task 3 镜像 + `.env` 中凭据
- Produces: 容器监听 8787；healthcheck 通过；`./data/cpb.db` 自动创建

- [ ] **Step 1: 启动容器**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
make dev.docker
```

Expected: `docker compose up -d` 成功，无报错。

- [ ] **Step 2: 等待服务 ready**

```bash
for i in {1..30}; do
  if docker inspect --format='{{.State.Health.Status}}' crypto-price-bot 2>/dev/null | grep -q healthy; then
    echo "✓ healthy after ${i}s"; break
  fi
  sleep 1
done
```

Expected: 在 30 秒内输出 `✓ healthy after Ns`（健康检查每 30s 一次，最多等到下一次）。

- [ ] **Step 3: 查看启动日志**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
make logs.docker
# 在日志出现 `[app] listening on :8787` 后 Ctrl-C 退出
```

Expected: 日志中含 `[app] listening on :8787`、`[app:scheduler] scheduled: ... tz=Asia/Shanghai next=...`。

> 若日志中没看到 listening 行：
> - 检查 .env 中 FEISHU_WEBHOOK_URL 是否能解析（不能有非法字符）
> - `docker exec crypto-price-bot printenv | grep FEISHU` 验证 env 已注入
> - `docker logs crypto-price-bot 2>&1 | head -50` 查看完整错误

- [ ] **Step 4: 验证 ./data/cpb.db 自动创建**

```bash
ls -la /Users/skypesky/workSpaces/javascript/github/crypto-price-bot/data/
```

Expected: `cpb.db` 文件存在，size > 0，权限 `-rw-r--r--` 或容器 uid 对应权限。

---

## Task 5: 健康检查

**Files:**
- Runtime: `/api/status` 端点

**Interfaces:**
- Consumes: 容器监听 8787
- Produces: status JSON 含 `dbOk=true`、`totalCoins>=11`

- [ ] **Step 1: curl /api/status**

```bash
curl -s http://localhost:8787/api/status | tee /tmp/status.json | jq .
```

Expected: JSON 形如：

```json
{
  "version": "...",
  "uptime": <number>,
  "dbOk": true,
  "sqliteVersion": "...",
  "totalCoins": 11,
  "userCount": 1,
  "nextRunAt": "2026-07-06T...",
  "lastReportAt": null,
  "timezone": "Asia/Shanghai",
  "scheduleRule": "0 */30 * * * *"
}
```

- [ ] **Step 2: 字段断言**

```bash
jq -e '.dbOk == true and .totalCoins >= 11 and .version != null and .timezone == "Asia/Shanghai"' /tmp/status.json
```

Expected: 输出 `true`（exit=0）。

- [ ] **Step 3: 如果 dbOk=false 或 totalCoins==0**

> 排查：
> - `dbOk=false` → 看 `data/cpb.db` 权限；`docker exec crypto-price-bot ls -la /app/data` 查看
> - `totalCoins==0` → 看容器启动日志有无 `default coins seeded` 之类消息；DB schema 可能不一致
> - 失败最常见原因：`dbOk=false` + 写权限问题 → `chmod 0777 ./data` 后 `docker compose restart`

---

## Task 6: 登录取 session cookie

**Files:**
- Runtime: `/api/auth/login` 端点
- Output: `cookies.txt` (curl cookie jar) 含 `cpb_session`

**Interfaces:**
- Consumes: `.env` 中 `INIT_USERNAME` / `INIT_PASSWORD` 首启创建的默认管理员
- Produces: 一个 7 天有效的 session cookie

- [ ] **Step 1: 读取登录凭据（仅 key，不读 value）**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
grep -E '^(INIT_USERNAME|INIT_PASSWORD)' .env | sed 's/=.*/=<redacted>/'
```

Expected: 两行 `INIT_USERNAME=<redacted>` 和 `INIT_PASSWORD=<redacted>`。

> 私密加载凭据到环境变量（不写到命令行历史）：

```bash
set -a; source .env; set +a
```

- [ ] **Step 2: POST /api/auth/login**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
curl -s -c cookies.txt -X POST http://localhost:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$INIT_USERNAME\",\"password\":\"$INIT_PASSWORD\"}" | tee /tmp/login.json
```

Expected: 200，body 含 `{"data":{"username":"..."}}`。

- [ ] **Step 3: 验证 cookie 已写入**

```bash
grep cpb_session cookies.txt | awk '{print $6, "= <redacted, length=" length($7) ">"}'
```

Expected: `cpb_session = <redacted, length=64+>`（默认 token 64 字符）。

- [ ] **Step 4: 如果 401 或 cookie 为空**

> 排查：
> - 401 → 密码错误；`docker exec crypto-price-bot sqlite3 /app/data/cpb.db "SELECT username FROM users LIMIT 1"` 验证用户存在
> - 改过 `.env` 但 DB 已建过：用现有管理员密码或 `rm ./data/cpb.db` 让容器重启时重建（会丢失历史 report 和币种配置）

---

## Task 7: 配置 30 分钟调度

**Files:**
- Runtime: `/api/settings` (PUT + GET) 和 `/api/task/next` (GET)

**Interfaces:**
- Consumes: Task 6 的 session cookie + 12 个 setting keys
- Produces: scheduler 在 `0 */30 * * * *` 时间表上跑；下个半点触发

- [ ] **Step 1: 看当前默认 settings**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
curl -s -b cookies.txt http://localhost:8787/api/settings | jq .data.schedule_rule,.data.timezone,.data.feishu_webhook_url | head -10
```

Expected: `schedule_rule` 当前值（默认 `0 */30 * * * *`，确认即可）；`timezone` 是 `Asia/Shanghai`；`feishu_webhook_url` 已设置。

- [ ] **Step 2: PUT 30 分钟调度**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
curl -s -b cookies.txt -X PUT http://localhost:8787/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"schedule_rule":"0 */30 * * * *","timezone":"Asia/Shanghai"}' | jq .
```

Expected: 200，body 形如 `{"data":{"schedule_rule":"0 */30 * * * *","timezone":"Asia/Shanghai"}}`。

- [ ] **Step 3: 验证 scheduler 重排生效**

```bash
curl -s -b cookies.txt http://localhost:8787/api/task/next | jq .
```

Expected: `{"data":{"nextRunAt":"<ISO 时间>"}}`，时间应当在最近的下一个半点（分钟字段为 `00` 或 `30`）。

> 若 nextRunAt 为 null → cron 解析失败；用 `GET /api/settings` 看回写入是否生效；可 `docker logs crypto-price-bot | grep scheduler` 看 `[scheduler] scheduled: ...` 行

---

## Task 8: 确认并裁剪币种到用户所关注列表

**Files:**
- Runtime: `/api/coins` (GET + DELETE)

**Interfaces:**
- Consumes: 默认 11 个币种 + 用户决定的"我关注的"列表
- Produces: DB 中 `enabled=1` 的币种 ⊆ 用户所关注列表

- [ ] **Step 1: 看当前币种列表**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
curl -s -b cookies.txt http://localhost:8787/api/coins | jq '.data | length, .[] | {id, symbol, name, enabled}'
```

Expected: 11 个币种，全 `enabled=true`，id 形如 1–11。

- [ ] **Step 2: 询问用户"你关注的币种"清单**

> **必须在此处停下来等用户回答**。Brainstorm 阶段需要用户提供至少一个 symbol 列表。常见选项：
> - "全部 11 个都保留"
> - "保留 BTC、ETH、USDT 三个"
> - "保留 BTC、ETH、SOL"
>
> 用户回答后，记录到当前会话的"保持列表"，记到下游 Step 4 用。

- [ ] **Step 3: （条件）DELETE 不要的币种**

仅当用户给的保留列表 ≠ 默认 11 个全部时执行：

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
# 例：保留 BTC/ETH/USDT，删除其它。id 通过 Step 1 拿。
KEEP_SYMBOLS='BTC ETH USDT'
IDS_TO_DELETE=$(curl -s -b cookies.txt http://localhost:8787/api/coins \
  | jq -r ".data[] | select(.symbol | IN($KEEP_SYMBOLS) | not) | .id")
for id in $IDS_TO_DELETE; do
  curl -s -b cookies.txt -X DELETE "http://localhost:8787/api/coins/$id" | jq -c .
done
```

Expected: 每个删除返回 `{"data":{"ok":true}}`。

- [ ] **Step 4: 验证最终列表**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
curl -s -b cookies.txt http://localhost:8787/api/coins \
  | jq '.data | map(select(.enabled == true)) | length'
```

Expected: 输出数字 = 用户保留列表的长度。

---

## Task 9: 立即触发任务 + 验证飞书推送

**Files:**
- Runtime: `/api/task/run` (POST) + `data/cpb.db` reports 表

**Interfaces:**
- Consumes: Task 8 的币种列表 + Task 7 的 30 分钟调度
- Produces: 飞书群收到一份合规 Markdown；DB reports 表新增 1 行（`triggered_by='manual'` 或 `'test'`）

- [ ] **Step 1: POST /api/task/run**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
curl -s -b cookies.txt -X POST http://localhost:8787/api/task/run \
  -H 'Content-Type: application/json' \
  -d '{}' | tee /tmp/run.json | jq .
```

Expected: body 形如 `{"data":{"reportId":1,"success":true,"totalCoins":N,"okCoins":N,"tgSent":false,"feishuSent":true}}`。

- [ ] **Step 2: 字段断言**

```bash
jq -e '.data.success == true and .data.totalCoins >= 1 and .data.feishuSent == true' /tmp/run.json
```

Expected: 输出 `true`。

- [ ] **Step 3: 等飞书消息到达（最多 30 秒）**

```bash
sleep 30
```

> 凭肉眼去飞书群确认有没有收到一份"价格报告"消息（含 Markdown 表格、双计价、技术指标）。

- [ ] **Step 4: 查询 reports 表新增一行**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
docker exec crypto-price-bot sqlite3 /app/data/cpb.db \
  "SELECT id, triggered_by, datetime(created_at) FROM reports ORDER BY id DESC LIMIT 5"
```

Expected: 至少 1 行带 `triggered_by='test'`（手动跑用 `runTask('test')`，具体以 `core/task.ts` 为准），时间戳最近。

- [ ] **Step 5: 如果飞书没收到**

> 排查优先级：
> - 看 `/tmp/run.json` 的 `feishuSent` 字段
> - 查 `data/cpb.db` reports.summary JSON 里的 feishu 状态
> - `docker logs crypto-price-bot | grep -i feishu` 看具体错误
> - 直接试飞书 webhook：`curl -X POST "$FEISHU_WEBHOOK_URL" -H 'Content-Type: application/json' -d '{"msg_type":"text","content":{"text":"hello"}}'` —— 必须 `StatusCode=0`
> - 若 webhook 直连正常但 bot 推送失败：很可能是网关或代理层问题

---

## Task 10: 等待 cron 自动触发（最长 30 分钟）

**Files:**
- Runtime: scheduler + croner + reports 表

**Interfaces:**
- Consumes: 容器持续运行 + `0 */30 * * * *` 调度
- Produces: 第二份推送（自动触发）；DB reports 表新增第 2 行（`triggered_by='cron'`）

- [ ] **Step 1: 计算到下一个半点还有多久**

```bash
NOW_MIN=$(date +%M)
NOW_SEC=$(date +%S)
WAIT_MIN=$((30 - 10#$NOW_MIN % 30))
WAIT_TOTAL=$((WAIT_MIN * 60 - 10#$NOW_SEC))
echo "next half-hour in ~${WAIT_TOTAL}s"
```

Expected: `WAIT_TOTAL` 在 0–1800 之间（0 已过半点的会立即触发）。

- [ ] **Step 2: 持续跟踪 reports 表直到多一行**

```bash
cd /Users/skypesky/workSpaces/javascript/github/crypto-price-bot
BEFORE=$(docker exec crypto-price-bot sqlite3 /app/data/cpb.db "SELECT COUNT(*) FROM reports")
echo "before=$BEFORE; waiting ${WAIT_TOTAL}s..."
sleep $WAIT_TOTAL
# 再等 30s 让推送落地
sleep 30
AFTER=$(docker exec crypto-price-bot sqlite3 /app/data/cpb.db "SELECT COUNT(*) FROM reports")
echo "after=$AFTER"
```

Expected: `AFTER > BEFORE`（至少多 1 行）。

- [ ] **Step 3: 验证 cron 触发的行**

```bash
docker exec crypto-price-bot sqlite3 /app/data/cpb.db \
  "SELECT id, triggered_by, datetime(created_at) FROM reports WHERE triggered_by='cron' ORDER BY id DESC LIMIT 3"
```

Expected: 至少 1 行 `triggered_by='cron'`，时间戳是最近半点。

- [ ] **Step 4: 飞书群收到第二份消息**

> 凭肉眼确认飞书群再次收到推送（与手动触发的内容相似，币种/指标一致，时间戳更新）。

- [ ] **Step 5: 如果到点没触发**

> 排查：
> - `docker logs crypto-price-bot | grep -E 'scheduler|triggered'` —— 看 `[app:scheduler] cron triggered` 是否出现
> - `GET /api/task/next` 看下一次时间是否合理（Asia/Shanghai）
> - 容器重启一次看：`docker compose restart crypto-price-bot` —— scheduler 会重新跑
> - 若容器已重启但仍未触发：确认是 `runTask('cron')` 而不是别的字符串分支

---

## 完成 = 4 条证据

- [ ] `git log` 新增一次提交（Task 1）
- [ ] 容器 Up + `/api/status` `dbOk=true` + `totalCoins≥11`（Tasks 4–5）
- [ ] 飞书群收到手动推送 + reports 表多 1 行 `triggered_by='test'`（Task 9）
- [ ] 飞书群收到 cron 自动推送 + reports 表又多 1 行 `triggered_by='cron'`（Task 10）

---

## Self-Review

### 1. Spec 覆盖检查

| Spec 章节 | 对应任务 |
|---|---|
| §1 背景 | 全计划 |
| §1.1 目标 | 全部 Tasks |
| §1.2 非目标 | Global Constraints + Task 边界 |
| §1.3 成功判据 | 文档末尾 4 条证据 |
| §2 组件边界 | Global Constraints "不动文件" + Task 1 仅落盘 |
| §3.1 默认 11 个币种 | Task 8 默认+裁剪 |
| §3.2 30 分钟调度 | Task 7 |
| §3 8 步验证矩阵 | Tasks 1–10（10 个任务对应 8 步 + 回归基线 Task 2） |
| §4 错误处理 | 各 Task 的"如果...则..."分支 |
| §5 测试策略 | Task 2 (回归) + Task 5/6/7 (冒烟) + Task 9/10 (端到端) |
| §6 提交策略 | Task 1 + §6 commit message 严格遵循 |
| §7 前置条件 | Tasks 0 之前的对话已确认（用户选 Docker、批准 spec） |
| §8 与上一份设计关系 | Global Constraints + Task 3 + Task 4 引用 compose/Dockerfile |

✓ 全覆盖。

### 2. 占位符扫描

- 无 "TBD" / "TODO" / "类似 Task N" / "见上"
- 凭据以 `$INIT_USERNAME` 形式引用 `.env`（不写死）
- 容器名 `crypto-price-bot` / 镜像 `crypto-price-bot:latest` 与 Makefile 一致
- 端口 8787 与 docker-compose.yml 一致
- 没有"应用此项"之类的空泛步骤

### 3. 类型 / 名字一致性

- 端点路径：`/api/status`、`/api/auth/login`、`/api/settings`、`/api/task/next`、`/api/coins/:id`、`/api/task/run` 与 server `src/api/*.ts` 一致
- Cookie 名：`cpb_session` 与 server `src/http/middleware` 一致
- 字段名：`dbOk`、`totalCoins`、`version`、`schedule_rule`、`timezone`、`feishuSent`、`triggered_by` 与代码 + DB schema 一致
- Makefile 目标：`build.docker`、`dev.docker`、`logs.docker` — 全部存在于 Makefile
- 容器名：`crypto-price-bot`（短名也匹配 `cpb` 缩写）— 与 `docker-compose.yml:container_name` 一致
- DB 路径：`/app/data/cpb.db` — 与 `DATABASE_PATH=/app/data/cpb.db` 默认一致

无冲突。
