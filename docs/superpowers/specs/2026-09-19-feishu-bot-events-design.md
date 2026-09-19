# 飞书 Bot + 事件订阅：定时卡片加「一键查询」按钮

**状态**：待评审
**日期**：2026-09-19
**作者**：Claude Code (brainstorming 会话)

## 1. 背景与动机

当前系统通过飞书自定义机器人 (webhook) 定时推送加密货币价格报告 (markdown 纯文本)。用户希望增加"主动查询"能力 —— 在卡片上加「🔄 立即查询」按钮，点击后服务器即时推送一份最新报告给点击者。

**核心约束**：飞书 webhook 机器人**没有事件订阅能力**，无法接收按钮点击事件。飞书自建应用 (Bot) 才能配置回调 URL 接收 `card.action.trigger` 事件。

## 2. 目标

- ✅ 保留现有 webhook 定时推送能力（纯文本，作为降级路径）
- ✅ 新增 Bot 通道：定时推送**可交互卡片**（含「🔄 立即查询」按钮）
- ✅ 用户点击按钮 → 服务器收到事件 → 通过 Bot DM 推送最新报告给点击者
- ✅ Bot 凭证未配置 / 调用失败 → 自动降级到 webhook（无按钮，仅定时文本）
- ✅ 开发期可用 ngrok 反向隧道接入飞书回调

## 3. 非目标

- ❌ 不实现飞书群内的"@bot 触发查询"（仅卡片按钮触发）
- ❌ 不实现多用户权限区分（任何人点按钮都能触发自己 DM）
- ❌ 不实现点击速率限制（用户明确要求不节流）
- ❌ 不重写现有 webhook 通道代码（仅作降级用，原代码保留）
- ❌ 不实现卡片点击的"正在查询..."实时反馈（飞书 3s 回调窗口太短，不实用）

## 4. 架构

### 4.1 数据流

```
                  ┌─ Bot API (im/v1/messages) ← 主送 (凭证齐全时)
[cron-tracker] ──┤
[手动触发 dashboard] ──┤
                  └─ Webhook URL                  ← 降级 (Bot 凭证缺失/失败时)
                                  │
                                  ▼
                           飞书群/用户

[Bot 卡片收到点击]
        │
        ▼
   POST /feishu/events  ── SDK 解密 + 验签 ──► runTaskForUser(openId)
                                              │
                                              ▼ im/v1/messages (DM 给点击者)
```

### 4.2 路由决策矩阵

| 场景 | sendToFeishu 行为 |
|------|-------------------|
| 定时推送（无 receiveId 参数） | Bot 优先；失败 / 未配 → webhook 降级 |
| 手动 DM（带 receiveId） | 必须 Bot；未配 → 报错（不允许降级） |
| 卡片带「立即查询」按钮 | 仅 Bot 模式有效；webhook 模式不发按钮 |

## 5. 组件 & 文件

### 5.1 新增文件

| 路径 | 职责 | 行数估计 |
|------|------|----------|
| `server/src/core/notify/feishu-bot.ts` | Bot 客户端封装：SDK 初始化、token 缓存、sendMessage | ~80 |
| `server/src/api/feishu-events.ts` | `POST /feishu/events` 端点：握手、解密、验签、派发 | ~80 |
| `server/src/core/notify/feishu-bot.test.ts` | Bot 单元测试（mock SDK） | ~120 |
| `server/src/api/feishu-events.test.ts` | 事件端点测试（mock SDK） | ~150 |

### 5.2 修改文件

| 路径 | 修改点 |
|------|--------|
| `server/src/core/notify/feishu.ts` | `sendToFeishu` 加路由：优先 Bot，失败 / 未配 → webhook |
| `server/src/core/config.ts` | Config 加 6 个字段（见 §6） |
| `server/src/core/message/formatter.ts` | `messageToFeishuCard` 末尾追加「🔄 立即查询」按钮 |
| `server/src/core/task.ts` | 新增 `runTaskForUser(reportId, openId)`，DM 给指定用户 |
| `server/src/core/models.test.ts` | 增加 receiveId 相关测试 |
| `server/src/index.ts` | 注册 `feishu-events` 路由；初始化 SDK 客户端 |
| `.env.example` | 文档化 6 个新 env |
| `README.md` | 加"飞书自建应用配置指南"章节 |

### 5.3 新增依赖

```json
{
  "dependencies": {
    "@larksuiteoapi/node-sdk": "^1.x"  // 精确版本号在实施阶段根据 @larksuiteoapi/node-sdk 最新稳定版决定
  }
}
```

## 6. 配置

### 6.1 新增 Config 字段

```ts
interface Config {
  // ... 现有字段
  feishu_app_id:                  string | null;   // FEISHU_APP_ID
  feishu_app_secret:              string | null;   // FEISHU_APP_SECRET
  feishu_encrypt_key:             string | null;   // FEISHU_ENCRYPT_KEY
  feishu_verification_token:      string | null;   // FEISHU_VERIFICATION_TOKEN
  feishu_default_receive_id:      string | null;   // FEISHU_DEFAULT_RECEIVE_ID
  feishu_default_receive_id_type: 'chat_id' | 'open_id' | 'union_id' | 'email';
}
```

### 6.2 ENV 映射

| Config 字段 | ENV 变量 |
|------------|---------|
| `feishu_app_id` | `FEISHU_APP_ID` |
| `feishu_app_secret` | `FEISHU_APP_SECRET` |
| `feishu_encrypt_key` | `FEISHU_ENCRYPT_KEY` |
| `feishu_verification_token` | `FEISHU_VERIFICATION_TOKEN` |
| `feishu_default_receive_id` | `FEISHU_DEFAULT_RECEIVE_ID` |
| `feishu_default_receive_id_type` | `FEISHU_DEFAULT_RECEIVE_ID_TYPE` |

### 6.3 `isBotConfigured()` 判定

返回 `true` 当且仅当 6 个字段**全部**非空。任一缺失 → 降级 webhook。

## 7. 加密与事件处理

### 7.1 加密算法（飞书事件订阅标准）

通过 `@larksuiteoapi/node-sdk` 的 `EventDispatcher` 处理：
```ts
import { EventDispatcher } from '@larksuiteoapi/node-sdk';

const dispatcher = new EventDispatcher({
  verificationToken: cfg.feishu_verification_token,  // 注：精确字段名以 SDK 实际导出为准
  encryptKey: cfg.feishu_encrypt_key,
});

// dispatcher.invoke(rawBody, headers) 返回解密 + 验签后的事件对象
// （精确方法名以 SDK v1.x 文档为准，实施阶段确认）
```

SDK 内部实现：
- Encrypt Key → SHA-256 → 32 字节 AES key + IV（前 16 字节）
- AES-256-CBC + PKCS7 解密

### 7.2 事件分发

```ts
// api/feishu-events.ts（伪代码）
router.post('/feishu/events', async (ctx) => {
  let event;
  try {
    event = dispatcher.invoke(ctx.bodyRaw!, ctx.req.headers);
  } catch (e) {
    log.warn('feishu event decrypt/verify failed', e);
    return { error: 'invalid event' };  // status 400
  }

  switch (event.type) {
    case 'url_verification':
      return { challenge: event.challenge };  // 必须在 3s 内

    case 'card.action.trigger':
    case 'card.action.trigger_v1':
      handleCardClick(event);  // 异步，不 await
      return { ok: true };     // 立即返回，不阻塞飞书

    case 'event.im.message.receive_v1':
      log.info('feishu im.message.received', { text: event.event.text });
      return { ok: true };

    default:
      log.info('unhandled feishu event', { type: event.type });
      return { ok: true };
  }
});
```

### 7.3 按钮 value payload

```json
{
  "tag": "button",
  "text": { "tag": "plain_text", "content": "🔄 立即查询" },
  "type": "primary",
  "value": {
    "action": "query_now",
    "v": 1
  }
}
```

点击后回传给服务器的 `event.action.value` 是 `{ "action": "query_now", "v": 1 }`。

### 7.4 时序要求

| 时刻 | 服务器 | 飞书 | 用户 |
|------|--------|------|------|
| 0s | 收到 POST /feishu/events | | |
| 0.05s | SDK 解密 + 验签 + 派发 handleCardClick | | |
| 0.1s | 返回 `{ok:true}` | 200 OK → 按钮 toast 消失 | |
| 1s | 异步触发 runTaskForUser | | |
| 8s | runTask 完成（7 币种典型耗时） | | |
| 8.1s | im/v1/messages DM 给 open_id | | 📩 收到 DM 卡片 |

**关键**：3s 内必须返回 200，否则飞书重试回调。

## 8. 错误处理

### 8.1 失败场景矩阵

| 场景 | 行为 |
|------|------|
| Bot 凭证缺失（任一 env 未填） | sendToFeishu → webhook 降级；事件端点返回 401 |
| SDK 解密失败 | log error，返回 400 |
| Verification Token 不匹配 | log warn，返回 403 |
| tenant_access_token 过期 | SDK 自动 refresh，调用方无感 |
| im/v1/messages 调用失败 | runTask 仍完成（DM 失败不重试），报告 `feishu_dm_sent=0` 入 DB |
| 飞书 3s 内没收到 200 | 飞书自动重试回调，最多 3 次（按文档） |
| 卡片收到点击但 `value.action` 不是 `query_now` | log warn，忽略，返回 `{ok:true}` |

### 8.2 并发安全

- 多个用户同时点按钮 → 多个 runTask 并行触发
- runTask 内部 DB 写已串行（better-sqlite3）
- tenant_access_token 缓存：内存 `Map<appId, {token, expiresAt}>`，SDK 自动管理
- DM 发送失败 ≤1 次 → 不重试，避免对点击者刷屏

## 9. 测试策略

### 9.1 单元测试（mock SDK）

| 测试文件 | 覆盖场景 |
|---------|---------|
| `feishu-bot.test.ts` | sendMessage 调 `im/v1/messages`；token 缓存命中；token 过期自动刷新；网络失败抛错 |
| `feishu-events.test.ts` | `url_verification` 返回 challenge；token 不匹配 → 403；`card.action.trigger` 派发；解密失败 → 400；未知事件类型 → 200 |
| `feishu.ts` (扩展) | `isBotConfigured()` 全字段非空 → Bot；任一字段空 → webhook；Bot 调用 throw → webhook 降级 |
| `formatter.test.ts` (扩展) | 卡片末尾有「🔄 立即查询」按钮；按钮 value 含 `action:"query_now", v:1`；value 经过 JSON.stringify |
| `config.test.ts` (扩展) | 6 个 env 字段正确读取；DB settings 不覆盖 env；类型校验（receive_id_type 必须是 4 选 1） |

### 9.2 手动验证清单（部署后必做）

| # | 操作 | 期望 |
|---|------|------|
| 1 | 飞书后台保存回调 URL | server 日志 `url_verification handled`；飞书后台显示「已通过验证」 |
| 2 | 等一个调度周期（或 dashboard 手点）| 群里收到卡片，**看到「🔄 立即查询」按钮** |
| 3 | 点按钮 | 飞书 toast 转圈消失（3s 内）；6-10s 后手机收到 DM 卡片 |
| 4 | 把 `FEISHU_APP_SECRET` 改成错的 | 下次调度走 webhook 纯文本（无按钮）|
| 5 | curl 伪造 POST（token 不对）| 返回 403，DB 无新报告 |
| 6 | 手动构造错误 encrypt | 返回 400 |
| 7 | 同时点 3 次按钮 | 3 次都收到 DM（无节流） |

## 10. 部署步骤

### 10.1 飞书开放平台侧

1. 创建企业自建应用：https://open.feishu.cn/app
2. 「应用能力」→「机器人」→ 添加
3. 「权限管理」→ 开通 scope：
   - `im:message`（接收消息）
   - `im:message:send_as_bot`（以 Bot 名义发）
   - `im:message.p2p_msg`（单聊）
   - `im:chat:readonly`（查询所在群）
4. 「事件订阅」：
   - 请求 URL：`https://你的域名/feishu/events`
   - 勾选「Verification Token」→ 输入自定义串
   - 勾选「Encrypt Key」→ 飞书生成或自定义
   - 添加事件：`card.action.trigger`（v1/v2）、`im.message.receive_v1`
5. 「版本管理与发布」→ 创建版本 → 申请发布（需企业管理员审批）
6. 把 App ID / App Secret / Encrypt Key / Verification Token 记下来填到 .env

### 10.2 获取 receive_id

```bash
# 用 app_id/app_secret 拿 tenant_access_token
curl -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \
  -H "Content-Type: application/json" \
  -d '{"app_id":"cli_xxx","app_secret":"xxx"}'

# 列出 bot 所在的所有群，取 chat_id
curl -G "https://open.feishu.cn/open-apis/im/v1/chats" \
  -H "Authorization: Bearer <tenant_access_token>" \
  --data-urlencode "user_id_type=open_id"
```

### 10.3 服务器侧

```bash
# 1. 装依赖
npm install @larksuiteoapi/node-sdk

# 2. 填 .env
cat >> .env <<'EOF'
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxFEISHU_ENCRYPT_KEY=xxxxxxxxxxxxxxxxxxxxxxxxFEISHU_VERIFICATION_TOKEN=cpb-verify-2026
FEISHU_DEFAULT_RECEIVE_ID=oc_xxxxxxxxxxxxx
FEISHU_DEFAULT_RECEIVE_ID_TYPE=chat_id
EOF

# 3. 本地开发：ngrok 反向隧道
ngrok http 8787
# 把 ngrok https URL 填到飞书后台「事件订阅」请求 URL

# 4. 生产环境：直接用正式域名
```

### 10.4 降级路径验证（生产前必做）

```bash
# 临时把 APP_SECRET 改成错的，重启服务
sed -i '' 's/FEISHU_APP_SECRET=.*/FEISHU_APP_SECRET=wrong/' .env
# 触发一次任务
curl -X POST http://localhost:8787/api/task/run -b "cpb_session=..."
# 期望：群里收到 webhook 纯文本，无按钮
# 改回正确值
```

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Bot 应用未发布（仅测试版）| 只有 developer 自己能交互；其他群成员点按钮 → DM 失败（log warn）|
| 飞书 API 限流 | tenant_access_token 1000 次/分钟配额，远超需求 |
| 加密/验签代码 bug 导致安全漏洞 | 用官方 SDK，不自己实现加密；外部测试用真实飞书样例 round-trip |
| 卡片按钮点击后 DM 超时 | runTask 加 15s 超时；超时则不发 DM，不报错 |
| 用户误删 Bot | 下次 sendToFeishu 调用失败 → webhook 降级；admin 可手动修 |
| 飞书 Bot API v1 → v2 升级 | SDK 跟进；业务代码不动 |

## 12. 验收标准

功能完成（Definition of Done）：
- [ ] 全部 §9 单元测试通过（覆盖率 ≥ 80% 新增代码）
- [ ] 全部 §9.2 手动验证清单通过
- [ ] 飞书后台「事件订阅」显示已通过验证
- [ ] 生产部署后第一次调度周期收到带按钮的卡片
- [ ] 至少一次真实按钮点击成功收到 DM
- [ ] 至少一次降级路径（改错凭证）验证成功
- [ ] README 含完整的飞书应用配置指南

## 13. 未来扩展（不实现，仅记录）

- 多用户权限白名单（只允许 admin 触发）
- 点击节流（每用户 5 分钟一次）
- 卡片实时更新（"查询中..." → "已发送"）
- 群内 @bot 触发查询
- 飞书开放平台卡片回调自定义模板（v2 schema）