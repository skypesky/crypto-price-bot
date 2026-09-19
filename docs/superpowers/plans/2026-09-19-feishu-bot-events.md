# 飞书 Bot + 事件订阅 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在定时推送的飞书卡片上添加「🔄 立即查询」按钮，点击后通过飞书自建应用 Bot 给点击者 DM 一份最新报告。

**Architecture:** Bot 通道优先（用官方 `@larksuiteoapi/node-sdk`），webhook 通道保留作为凭证缺失/失败时的降级路径。事件回调通过新增 `POST /feishu/events` 端点处理，使用 SDK 的 EventDispatcher 解密和验签。

**Tech Stack:** Node.js + TypeScript, `@larksuiteoapi/node-sdk` v1.x, better-sqlite3, vitest

## Global Constraints

- 严格 TDD：每个组件先写失败测试，再写实现，最后 commit
- 不修改现有 webhook 通道的发送逻辑，只在 `sendToFeishu` 顶层加路由
- 用官方 SDK 处理加密和验签，不自己实现 AES
- 所有新增 env 变量缺失时静默降级到 webhook，不阻塞服务启动
- 不引入新依赖的依赖项（only add `@larksuiteoapi/node-sdk`）
- 提交信息遵循 conventional commits（feat/fix/docs/chore）
- 飞书卡片元素 tag 名严格遵循 schema：按钮容器用 `action`（单数），按钮用 `button`
- 6 个新增 Config 字段：`feishu_app_id`, `feishu_app_secret`, `feishu_encrypt_key`, `feishu_verification_token`, `feishu_default_receive_id`, `feishu_default_receive_id_type`
- Spec 文档：`docs/superpowers/specs/2026-09-19-feishu-bot-events-design.md`

---

## Task 1: 安装飞书官方 SDK 依赖

**Files:**
- Modify: `server/package.json`

**Interfaces:**
- Consumes: 无（纯依赖安装）
- Produces: `node_modules/@larksuiteoapi/node-sdk` 可被后续任务 import

- [ ] **Step 1: 安装依赖**

Run:
```bash
cd server && npm install @larksuiteoapi/node-sdk
```

Expected: 输出 `added 1 package` 或类似，package.json 出现 `@larksuiteoapi/node-sdk` 依赖项。

- [ ] **Step 2: 验证 SDK 可导入**

Run:
```bash
node --input-type=module -e "import { EventDispatcher, Client } from '@larksuiteoapi/node-sdk'; console.log(typeof EventDispatcher, typeof Client);"
```

Expected: 输出 `function function`。SDK 模块可正常 import。

- [ ] **Step 3: 检查 SDK 的 EventDispatcher 配置项**

Run:
```bash
node --input-type=module -e "
import { EventDispatcher } from '@larksuiteoapi/node-sdk';
const d = new EventDispatcher({ verificationToken: 't', encryptKey: 'k' });
console.log('EventDispatcher OK');
console.log('dispatch methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(d)));
"
```

Expected: 输出 `EventDispatcher OK` 和方法名列表（包含 `invoke` 或 `dispatch`，具体名称记下供后续 task 使用）。

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/package-lock.json
git commit -m "chore(server): add @larksuiteoapi/node-sdk dependency"
```

---

## Task 2: 扩展 Config 加 6 个飞书 Bot 字段

**Files:**
- Modify: `server/src/core/config.ts:7-22`（Config interface）
- Modify: `server/src/core/config.ts:24-32`（ENV_MAP）
- Modify: `server/src/core/config.ts`（Config 构造函数中赋值的部分）
- Test: `server/src/core/config.test.ts`

**Interfaces:**
- Consumes: `process.env.FEISHU_APP_ID` 等 6 个环境变量
- Produces: `Config` 对象包含 6 个新字段，全部 `string | null` 或受控联合类型

- [ ] **Step 1: 在 Config interface 加 6 个字段**

打开 `server/src/core/config.ts`，在第 7-22 行的 Config interface 末尾添加：

```ts
  feishu_app_id: string | null;
  feishu_app_secret: string | null;
  feishu_encrypt_key: string | null;
  feishu_verification_token: string | null;
  feishu_default_receive_id: string | null;
  feishu_default_receive_id_type: 'chat_id' | 'open_id' | 'union_id' | 'email';
```

- [ ] **Step 2: 在 ENV_MAP 加 6 个映射**

在 `ENV_MAP` 对象里加：

```ts
  feishu_app_id: 'FEISHU_APP_ID',
  feishu_app_secret: 'FEISHU_APP_SECRET',
  feishu_encrypt_key: 'FEISHU_ENCRYPT_KEY',
  feishu_verification_token: 'FEISHU_VERIFICATION_TOKEN',
  feishu_default_receive_id: 'FEISHU_DEFAULT_RECEIVE_ID',
  feishu_default_receive_id_type: 'FEISHU_DEFAULT_RECEIVE_ID_TYPE',
```

- [ ] **Step 3: 在 Config 构造逻辑加赋值**

在 `loadConfig()` 函数里构造 cfg 对象的位置（搜索 `tg_bot_token:` 那一行附近），添加：

```ts
    feishu_app_id: (dbSettings.feishu_app_id as string | null) ?? null,
    feishu_app_secret: (dbSettings.feishu_app_secret as string | null) ?? null,
    feishu_encrypt_key: (dbSettings.feishu_encrypt_key as string | null) ?? null,
    feishu_verification_token: (dbSettings.feishu_verification_token as string | null) ?? null,
    feishu_default_receive_id: (dbSettings.feishu_default_receive_id as string | null) ?? null,
    feishu_default_receive_id_type: ((): 'chat_id' | 'open_id' | 'union_id' | 'email' => {
      const v = dbSettings.feishu_default_receive_id_type;
      if (v === 'chat_id' || v === 'open_id' || v === 'union_id' || v === 'email') return v;
      return 'chat_id';
    })(),
```

- [ ] **Step 4: 写失败测试**

打开 `server/src/core/config.test.ts`，在末尾添加：

```ts
describe('Config feishu Bot fields', () => {
  beforeEach(() => {
    // 清空相关 env
    delete process.env['FEISHU_APP_ID'];
    delete process.env['FEISHU_APP_SECRET'];
    delete process.env['FEISHU_ENCRYPT_KEY'];
    delete process.env['FEISHU_VERIFICATION_TOKEN'];
    delete process.env['FEISHU_DEFAULT_RECEIVE_ID'];
    delete process.env['FEISHU_DEFAULT_RECEIVE_ID_TYPE'];
  });

  it('env 缺失时所有字段都是 null', () => {
    // ... 测试逻辑
  });

  it('env 提供时字段被正确读取', () => {
    process.env['FEISHU_APP_ID'] = 'cli_test';
    process.env['FEISHU_APP_SECRET'] = 'secret_test';
    process.env['FEISHU_ENCRYPT_KEY'] = 'encrypt_test';
    process.env['FEISHU_VERIFICATION_TOKEN'] = 'token_test';
    process.env['FEISHU_DEFAULT_RECEIVE_ID'] = 'oc_test';
    process.env['FEISHU_DEFAULT_RECEIVE_ID_TYPE'] = 'open_id';
    // 调用 loadConfig() 并断言 cfg.feishu_app_id === 'cli_test' 等
  });

  it('receive_id_type 不是 4 选 1 时默认 chat_id', () => {
    process.env['FEISHU_DEFAULT_RECEIVE_ID_TYPE'] = 'invalid_value';
    // 调用 loadConfig() 并断言 cfg.feishu_default_receive_id_type === 'chat_id'
  });
});
```

具体的测试实现需要查看 `config.test.ts` 的现有 fixture 模式，复用相同的 setup/teardown 风格。

- [ ] **Step 5: 运行测试确认初始状态下失败或通过**

Run: `cd server && npx vitest run src/core/config.test.ts`

预期：如果之前测试中 Config 对象没有新字段，运行会编译失败（TypeScript error）→ 这是预期的"红"状态。如果成功，说明之前已经有兼容代码，则测试应该是 PASSING 或 FAILING（视断言而定）。

- [ ] **Step 6: 修正测试直到 PASSING**

调整测试 setup 直到所有断言通过。

- [ ] **Step 7: 跑全量测试确认无回归**

Run: `cd server && npx vitest run`

Expected: 168+ 个测试通过（原本 + 3 个新增）。

- [ ] **Step 8: Commit**

```bash
git add server/src/core/config.ts server/src/core/config.test.ts
git commit -m "feat(server): add 6 feishu Bot config fields"
```

---

## Task 3: 实现 feishu-bot.ts 客户端封装

**Files:**
- Create: `server/src/core/notify/feishu-bot.ts`
- Test: `server/src/core/notify/feishu-bot.test.ts`

**Interfaces:**
- Consumes: `cfg.feishu_app_id`, `cfg.feishu_app_secret`（来自 Task 2）
- Produces:
  - `isBotConfigured(cfg: Config): boolean` — 全字段非空才返回 true
  - `sendViaBot(cfg: Config, payload: FeishuCardPayload | { msg_type: 'text'; content: { text: string } }, receiveId: string, receiveIdType: string): Promise<{ ok: boolean; error?: string }>`

- [ ] **Step 1: 写失败测试**

创建 `server/src/core/notify/feishu-bot.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock SDK
vi.mock('@larksuiteoapi/node-sdk', () => {
  const mockRequest = vi.fn();
  return {
    Client: class {
      request = mockRequest;
    },
    EventDispatcher: class {},
  };
});

import { isBotConfigured, sendViaBot } from './feishu-bot.js';
import type { Config } from '../config.js';

const mockRequest = (await import('@larksuiteoapi/node-sdk')).Client.prototype.request as unknown as ReturnType<typeof vi.fn>;

const baseCfg = (): Config => ({
  // ... 其他字段用 default
  tg_bot_token: null,
  tg_chat_id: null,
  feishu_webhook_url: 'https://webhook.example.com',
  feishu_app_id: 'cli_test',
  feishu_app_secret: 'secret_test',
  feishu_encrypt_key: 'encrypt_test',
  feishu_verification_token: 'token_test',
  feishu_default_receive_id: 'oc_test',
  feishu_default_receive_id_type: 'chat_id',
  timezone: 'Asia/Shanghai',
  schedule_rule: '0 */10 * * * *',
  ua: 'test',
  doh_enabled: true,
  doh_server: 'https://1.1.1.1/dns-query',
  doh_bypass: [],
  request_timeout_ms: 10000,
  max_retries: 3,
  alert_cooldown_hours: 1,
});

describe('isBotConfigured', () => {
  it('全字段非空 → true', () => {
    expect(isBotConfigured(baseCfg())).toBe(true);
  });

  it('app_id 缺失 → false', () => {
    const cfg = baseCfg();
    cfg.feishu_app_id = null;
    expect(isBotConfigured(cfg)).toBe(false);
  });

  // ... 其他 5 个字段各一个 test
});

describe('sendViaBot', () => {
  beforeEach(() => mockRequest.mockReset());

  it('成功返回 ok=true', async () => {
    mockRequest.mockResolvedValue({ code: 0, msg: 'success' });
    const result = await sendViaBot(baseCfg(), { msg_type: 'text', content: { text: 'hi' } }, 'oc_xxx', 'chat_id');
    expect(result).toEqual({ ok: true });
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining('/im/v1/messages'),
      method: 'POST',
    }));
  });

  it('失败 code !== 0 → ok=false with error', async () => {
    mockRequest.mockResolvedValue({ code: 230020, msg: 'permission denied' });
    const result = await sendViaBot(baseCfg(), { msg_type: 'text', content: { text: 'hi' } }, 'oc_xxx', 'chat_id');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('permission denied');
  });

  it('SDK 抛错 → ok=false with error', async () => {
    mockRequest.mockRejectedValue(new Error('network down'));
    const result = await sendViaBot(baseCfg(), { msg_type: 'text', content: { text: 'hi' } }, 'oc_xxx', 'chat_id');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('network down');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx vitest run src/core/notify/feishu-bot.test.ts`

Expected: 全部 FAIL（isBotConfigured / sendViaBot not exported from feishu-bot.js）。

- [ ] **Step 3: 实现 feishu-bot.ts**

创建 `server/src/core/notify/feishu-bot.ts`：

```ts
import { Client } from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../util/logger.js';
import type { Config } from '../config.js';

const log = createLogger({ isTTY: false }).child('feishu-bot');

/**
 * Bot 凭证齐全判定：6 个字段全部非空才算配置成功。
 * 任一缺失 → 降级到 webhook 通道。
 */
export function isBotConfigured(cfg: Config): boolean {
  return Boolean(
    cfg.feishu_app_id &&
    cfg.feishu_app_secret &&
    cfg.feishu_encrypt_key &&
    cfg.feishu_verification_token &&
    cfg.feishu_default_receive_id &&
    cfg.feishu_default_receive_id_type
  );
}

interface SendPayload {
  msg_type: 'text' | 'interactive';
  content?: { text: string };
  card?: unknown;
}

export async function sendViaBot(
  cfg: Config,
  payload: SendPayload,
  receiveId: string,
  receiveIdType: 'chat_id' | 'open_id' | 'union_id' | 'email'
): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new Client({
      appId: cfg.feishu_app_id!,
      appSecret: cfg.feishu_app_secret!,
      domain: 'https://open.feishu.cn',
    });
    const res = await client.request({
      url: `/im/v1/messages?receive_id_type=${receiveIdType}`,
      method: 'POST',
      data: {
        receive_id: receiveId,
        msg_type: payload.msg_type,
        content: payload.msg_type === 'text' ? payload.content : JSON.stringify(payload.card),
      },
    });
    const data = res as { code?: number; msg?: string };
    if (typeof data.code === 'number' && data.code !== 0) {
      return { ok: false, error: `feishu bot code=${data.code} msg=${data.msg}` };
    }
    return { ok: true };
  } catch (err) {
    log.warn('sendViaBot failed', err);
    return { ok: false, error: (err as Error).message };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run src/core/notify/feishu-bot.test.ts`

Expected: 全部 PASS。

- [ ] **Step 5: 跑全量测试**

Run: `cd server && npx vitest run`

Expected: 无回归。

- [ ] **Step 6: Commit**

```bash
git add server/src/core/notify/feishu-bot.ts server/src/core/notify/feishu-bot.test.ts
git commit -m "feat(server): add feishu-bot client with isBotConfigured + sendViaBot"
```

---

## Task 4: feishu.ts 加 Bot 优先 + webhook 降级路由

**Files:**
- Modify: `server/src/core/notify/feishu.ts:17-66`
- Test: `server/src/core/notify/feishu.test.ts`（如果不存在则创建）

**Interfaces:**
- Consumes: `sendToFeishu(message: string)` 现有签名；`sendViaBot` 来自 Task 3
- Produces: `sendToFeishu` 行为变化：
  - Bot 配置 + 凭证齐全 → 优先 sendViaBot
  - Bot 失败 / 未配 → 走原有 webhook 通道

- [ ] **Step 1: 写失败测试**

创建 `server/src/core/notify/feishu.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./feishu-bot.js', () => ({
  isBotConfigured: vi.fn(),
  sendViaBot: vi.fn(),
}));

vi.mock('../../util/http.js', () => ({
  httpPost: vi.fn(),
  HttpError: class extends Error {},
}));

import { sendToFeishu } from './feishu.js';
import { isBotConfigured, sendViaBot } from './feishu-bot.js';
import { httpPost } from '../../util/http.js';

const mockIsBotConfigured = isBotConfigured as unknown as ReturnType<typeof vi.fn>;
const mockSendViaBot = sendViaBot as unknown as ReturnType<typeof vi.fn>;
const mockHttpPost = httpPost as unknown as ReturnType<typeof vi.fn>;

describe('sendToFeishu routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Bot 配置齐全且 sendViaBot 成功 → 走 Bot，不调 webhook', async () => {
    mockIsBotConfigured.mockReturnValue(true);
    mockSendViaBot.mockResolvedValue({ ok: true });
    const result = await sendToFeishu('test message');
    expect(result.ok).toBe(true);
    expect(mockSendViaBot).toHaveBeenCalled();
    expect(mockHttpPost).not.toHaveBeenCalled();
  });

  it('Bot 未配置 → 走 webhook', async () => {
    mockIsBotConfigured.mockReturnValue(false);
    mockHttpPost.mockResolvedValue({ data: { code: 0 } });
    const result = await sendToFeishu('test message');
    expect(result.ok).toBe(true);
    expect(mockSendViaBot).not.toHaveBeenCalled();
    expect(mockHttpPost).toHaveBeenCalled();
  });

  it('Bot 调用失败 → 降级到 webhook', async () => {
    mockIsBotConfigured.mockReturnValue(true);
    mockSendViaBot.mockResolvedValue({ ok: false, error: 'bot fail' });
    mockHttpPost.mockResolvedValue({ data: { code: 0 } });
    const result = await sendToFeishu('test message');
    expect(result.ok).toBe(true);
    expect(mockSendViaBot).toHaveBeenCalled();
    expect(mockHttpPost).toHaveBeenCalled();
  });

  it('webhook 也失败 → 返回失败', async () => {
    mockIsBotConfigured.mockReturnValue(true);
    mockSendViaBot.mockResolvedValue({ ok: false, error: 'bot fail' });
    mockHttpPost.mockResolvedValue({ data: { code: 11246, msg: 'bad' } });
    const result = await sendToFeishu('test message');
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx vitest run src/core/notify/feishu.test.ts`

Expected: 失败（isBotConfigured / sendViaBot 还没被 sendToFeishu 使用）。

- [ ] **Step 3: 修改 sendToFeishu 加路由**

打开 `server/src/core/notify/feishu.ts`，替换 `sendToFeishu` 函数（约 17-66 行）：

```ts
export async function sendToFeishu(message: string): Promise<FeishuSendResult> {
  const cfg = getConfig();
  if (!cfg.feishu_webhook_url && !isBotConfigured(cfg)) {
    return { ok: false, error: 'feishu not configured (no webhook and no bot credentials)' };
  }

  // Bot 主送路径
  if (isBotConfigured(cfg)) {
    try {
      const card = isFullReportMessage(message) ? messageToFeishuCard(message) : null;
      const payload = card ?? { msg_type: 'text' as const, content: { text: normalizeMessageForTextChannel(message) } };
      const result = await sendViaBot(
        cfg,
        payload,
        cfg.feishu_default_receive_id!,
        cfg.feishu_default_receive_id_type!
      );
      if (result.ok) return { ok: true };
      log.warn(`Bot send failed, falling back to webhook: ${result.error}`);
    } catch (err) {
      log.warn('Bot send threw, falling back to webhook', err);
    }
  }

  // Webhook 降级路径（现有逻辑保留）
  if (!cfg.feishu_webhook_url) {
    return { ok: false, error: 'feishu webhook not configured' };
  }
  try {
    const body = isFullReportMessage(message)
      ? (messageToFeishuCard(message) ?? {
          msg_type: 'text' as const,
          content: { text: normalizeMessageForTextChannel(message) },
        })
      : {
          msg_type: 'text' as const,
          content: { text: normalizeMessageForTextChannel(message) },
        };
    const bodyJson = JSON.stringify(body);
    log.info(`send msg_type=${(body as { msg_type: string }).msg_type} bytes=${bodyJson.length}`);
    if (process.env['FEISHU_DEBUG_BODY'] === '1') {
      log.info(`body=${bodyJson}`);
    }
    const res = await httpPost<{ StatusCode?: number; code?: number; msg?: string; StatusMessage?: string }>(
      cfg.feishu_webhook_url,
      body,
      {
        timeoutMs: cfg.request_timeout_ms,
        retries: cfg.max_retries,
        headers: { 'User-Agent': cfg.ua },
        doh: null,
      },
    );
    log.info(`response: ${JSON.stringify(res.data)}`);
    if (res.data.StatusCode && res.data.StatusCode !== 0) {
      return { ok: false, error: `feishu StatusCode=${res.data.StatusCode} msg=${res.data.msg}` };
    }
    if (typeof res.data.code === 'number' && res.data.code !== 0) {
      return { ok: false, error: `feishu code=${res.data.code} msg=${res.data.msg}` };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof HttpError) {
      return { ok: false, error: `${err.message} (HTTP ${err.status})` };
    }
    return { ok: false, error: (err as Error).message };
  }
}
```

并在文件顶部加 import：

```ts
import { isBotConfigured, sendViaBot } from './feishu-bot.js';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run src/core/notify/feishu.test.ts`

Expected: 全部 PASS。

- [ ] **Step 5: 跑全量测试**

Run: `cd server && npx vitest run`

Expected: 无回归。

- [ ] **Step 6: Commit**

```bash
git add server/src/core/notify/feishu.ts server/src/core/notify/feishu.test.ts
git commit -m "feat(server): route feishu send via Bot with webhook fallback"
```

---

## Task 5: formatter 给卡片末尾加「🔄 立即查询」按钮

**Files:**
- Modify: `server/src/core/message/formatter.ts:104`
- Test: `server/src/core/message/formatter.test.ts`

**Interfaces:**
- Consumes: 现有 `messageToFeishuCard(message)` 签名
- Produces: 卡片末尾追加 `tag: 'action'` 元素，含 1 个按钮 `value: { action: 'query_now', v: 1 }`

- [ ] **Step 1: 写失败测试**

打开 `server/src/core/message/formatter.test.ts`，找到 `messageToFeishuCard` 的 describe 块，在末尾添加：

```ts
it('卡片末尾有「立即查询」按钮', () => {
  const card = messageToFeishuCard(SAMPLE_REPORT);
  expect(card).not.toBeNull();
  if (!card) return;

  // 找到最后一个 action 元素
  const lastActionIdx = card.card.elements.findIndex(
    e => e.tag === 'action' && e.actions.some(a => a.text.content === '🔄 立即查询')
  );
  expect(lastActionIdx).toBeGreaterThanOrEqual(0);

  const lastAction = card.card.elements[lastActionIdx];
  if (lastAction.tag !== 'action') return;
  expect(lastAction.actions).toHaveLength(1);
  expect(lastAction.actions[0]).toMatchObject({
    tag: 'button',
    text: { tag: 'plain_text', content: '🔄 立即查询' },
    type: 'primary',
    value: { action: 'query_now', v: 1 },
  });

  // 「立即查询」按钮必须在 trailer 之后
  const trailerIdx = card.card.elements.findIndex(e => e.tag === 'markdown' && e.content.includes('⏰ 更新时间'));
  expect(lastActionIdx).toBeGreaterThan(trailerIdx);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx vitest run src/core/message/formatter.test.ts`

Expected: 失败（elements 数组里没有"立即查询"按钮）。

- [ ] **Step 3: 修改 formatter.ts**

打开 `server/src/core/message/formatter.ts`，找到 `messageToFeishuCard` 函数里 trailer 渲染的位置（约 109-111 行）：

```ts
  if (trailerSections.length > 0) {
    elements.push({ tag: 'markdown', content: trailerSections.join('\n\n') });
  }
```

替换为：

```ts
  if (trailerSections.length > 0) {
    elements.push({ tag: 'markdown', content: trailerSections.join('\n\n') });
  }

  // 末尾加「立即查询」按钮：用户点击后飞书回调 server 重新拉一次报告并 DM 给点击者
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '🔄 立即查询' },
        type: 'primary',
        value: { action: 'query_now', v: 1 } as unknown as string,  // Feishu 接受任意 JSON；类型放宽
      },
    ],
  });
```

注：`FeishuCardButton` interface 当前 type 不包含 `value`，需要扩展：

打开 `server/src/core/message/formatter.ts`，修改 `FeishuCardButton` interface（约 23-28 行）：

```ts
export interface FeishuCardButton {
  tag: 'button';
  text: { tag: 'plain_text'; content: string };
  type: 'primary' | 'default' | 'danger';
  url?: string;
  value?: Record<string, unknown>;  // 用于 callback 按钮携带上下文
}
```

并将 union 类型里 `value` 改为可选（如已用 `url` 一样）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run src/core/message/formatter.test.ts`

Expected: 全部 PASS（17+ 个，新增 1 个）。

- [ ] **Step 5: 跑全量测试**

Run: `cd server && npx vitest run`

Expected: 无回归。

- [ ] **Step 6: Commit**

```bash
git add server/src/core/message/formatter.ts server/src/core/message/formatter.test.ts
git commit -m "feat(message): add 'one-click query' button to feishu cards"
```

---

## Task 6: 在 task.ts 加 runTaskForUser（点按钮专用路径）

**Files:**
- Modify: `server/src/core/task.ts`
- Test: `server/src/core/task.test.ts`（如果不存在则创建）

**Interfaces:**
- Consumes: `cfg.feishu_app_id` 等来自 Task 2；`runTask` 现有签名
- Produces:
  - `runTaskForUser(openId: string, openIdType: 'open_id' | 'union_id' | 'email'): Promise<{ ok: boolean; reportId?: number; error?: string }>`
  - 行为：调用现有 `runTask('manual')`，然后用 `sendViaBot` 把结果 DM 给 `openId`

- [ ] **Step 1: 写失败测试**

创建 `server/src/core/task.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 部分 mock：保留 runTaskForUser 真实实现，只 mock 它的依赖（runTask + sendViaBot）
vi.mock('./task.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task.js')>();
  return {
    ...actual,
    runTask: vi.fn(),
  };
});

vi.mock('./notify/feishu-bot.js', () => ({
  sendViaBot: vi.fn(),
  isBotConfigured: vi.fn(() => true),
}));

import { runTaskForUser, runTask, type TaskRunResult } from './task.js';
import { sendViaBot } from './notify/feishu-bot.js';

const mockRunTask = runTask as unknown as ReturnType<typeof vi.fn>;
const mockSendViaBot = sendViaBot as unknown as ReturnType<typeof vi.fn>;

const fakeResult = (overrides: Partial<TaskRunResult> = {}): TaskRunResult => ({
  reportId: 100,
  triggered_by: 'manual',
  success: true,
  totalCoins: 7,
  okCoins: 7,
  tgSent: false,
  feishuSent: false,
  message: '📊 *测试报告* from local\n\n🔹 *比特币* (BTC)\n   💰 人民币：`¥1.00`\n   🔗 [Gate](https://gate.com/btc) | [CoinGecko](https://cg.com/btc)\n\n⏰ 更新时间',
  ...overrides,
});

describe('runTaskForUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功：runTask + sendViaBot 都返回 ok → ok=true', async () => {
    mockRunTask.mockResolvedValue(fakeResult());
    mockSendViaBot.mockResolvedValue({ ok: true });
    const result = await runTaskForUser('ou_user', 'open_id');
    expect(result.ok).toBe(true);
    expect(result.reportId).toBe(100);
    expect(mockSendViaBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ msg_type: expect.stringMatching(/text|interactive/) }),
      'ou_user',
      'open_id'
    );
  });

  it('runTask 失败 → ok=false, error', async () => {
    mockRunTask.mockResolvedValue(fakeResult({ success: false, okCoins: 0 }));
    const result = await runTaskForUser('ou_user', 'open_id');
    expect(result.ok).toBe(false);
    expect(mockSendViaBot).not.toHaveBeenCalled();
  });

  it('sendViaBot 失败 → ok=true（report 已生成）, error 仅警告', async () => {
    mockRunTask.mockResolvedValue(fakeResult());
    mockSendViaBot.mockResolvedValue({ ok: false, error: 'bot fail' });
    const result = await runTaskForUser('ou_user', 'open_id');
    expect(result.ok).toBe(true);  // 报告生成了就算成功
    expect(result.reportId).toBe(100);
    expect(result.error).toBe('bot fail');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx vitest run src/core/task.test.ts`

Expected: 失败（runTaskForUser not exported）。

- [ ] **Step 3: 修改 task.ts 加 runTaskForUser**

打开 `server/src/core/task.ts`。注意：现有 `runTask` 已经返回 `TaskRunResult`，**已经包含 `message` 字段**（task.ts:23 + task.ts:120），所以无需重新拼装，直接用 `result.message`。

在文件顶部加 import：

```ts
import { sendViaBot, isBotConfigured } from './notify/feishu-bot.js';
import { messageToFeishuCard, isFullReportMessage, normalizeMessageForTextChannel } from './message/formatter.js';
```

（`getConfig`、`createLogger` 已经在文件顶部，不必重复。）

在文件末尾加：

```ts
const logUser = createLogger({ isTTY: false }).child('task-user');

/**
 * 飞书卡片「立即查询」按钮回调专用：调用 runTask 拉最新数据，DM 给点击者。
 * 与定时推送不同：必须用 Bot 通道（不能降级到 webhook，因为 webhook 不能指定收件人）。
 */
export async function runTaskForUser(
  openId: string,
  receiveIdType: 'open_id' | 'union_id' | 'email' = 'open_id'
): Promise<{ ok: boolean; reportId?: number; error?: string }> {
  const cfg = getConfig();
  if (!isBotConfigured(cfg)) {
    logUser.warn('Bot not configured, cannot run task for user');
    return { ok: false, error: 'bot not configured' };
  }

  try {
    const result = await runTask('manual');
    if (!result.success) {
      return { ok: false, reportId: result.reportId, error: 'coin fetch failed' };
    }

    const message = result.message;
    const card = isFullReportMessage(message) ? messageToFeishuCard(message) : null;
    const payload = card ?? { msg_type: 'text' as const, content: { text: normalizeMessageForTextChannel(message) } };

    const sendResult = await sendViaBot(cfg, payload, openId, receiveIdType);
    if (!sendResult.ok) {
      logUser.warn(`DM failed for ${openId}: ${sendResult.error}`);
      return { ok: true, reportId: result.reportId, error: sendResult.error };
    }
    return { ok: true, reportId: result.reportId };
  } catch (err) {
    logUser.error('runTaskForUser failed', err);
    return { ok: false, error: (err as Error).message };
  }
}
```

注：现有 `runTask` 已经会触发 `sendToTG` / `sendToFeishu` 把报告推送到默认渠道，这意味着点击按钮后**既会 DM，也会在原群/原 chat 再发一份**（因为 `feishu_default_receive_id` 通常就是所在群）。这是有意的——保留现有推送路径 + 额外 DM 给点击者。如未来想"只 DM 不重复推"，可加一个 `skipNotify` 参数到 `runTask`，但本任务不做。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run src/core/task.test.ts`

Expected: 全部 PASS。

- [ ] **Step 5: 跑全量测试**

Run: `cd server && npx vitest run`

Expected: 无回归。

- [ ] **Step 6: Commit**

```bash
git add server/src/core/task.ts server/src/core/task.test.ts
git commit -m "feat(server): add runTaskForUser for feishu button click"
```

---

## Task 7: 实现 POST /feishu/events 端点

**Files:**
- Create: `server/src/api/feishu-events.ts`
- Modify: `server/src/index.ts`（注册路由）
- Test: `server/src/api/feishu-events.test.ts`

**Interfaces:**
- Consumes: SDK 的 `EventDispatcher`；`runTaskForUser` 来自 Task 6
- Produces: `POST /feishu/events` 处理 `url_verification` / `card.action.trigger` / `event.im.message.receive_v1`

- [ ] **Step 1: 写失败测试**

创建 `server/src/api/feishu-events.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  const mockInvoke = vi.fn();
  return {
    EventDispatcher: class {
      invoke = mockInvoke;
    },
    Client: class {},
  };
});

vi.mock('../core/task.js', () => ({
  runTaskForUser: vi.fn(),
}));

import { registerFeishuEvents } from './feishu-events.js';
import { runTaskForUser } from '../core/task.js';

const mockInvoke = (await import('@larksuiteoapi/node-sdk')).EventDispatcher.prototype.invoke as unknown as ReturnType<typeof vi.fn>;
const mockRunTaskForUser = runTaskForUser as unknown as ReturnType<typeof vi.fn>;

// 找一个简单的 Router mock 或参考现有 registerX 函数风格

describe('feishu-events handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('url_verification → 返回 challenge', async () => {
    mockInvoke.mockReturnValue({ type: 'url_verification', challenge: 'abc' });
    // 调路由 handler，断言返回 { challenge: 'abc' }
  });

  it('card.action.trigger → runTaskForUser 调用 → 返回 {ok:true}', async () => {
    mockInvoke.mockReturnValue({
      type: 'card.action.trigger',
      event: {
        action: { value: { action: 'query_now' } },
        sender: { sender_id: { open_id: 'ou_user' } },
      },
    });
    mockRunTaskForUser.mockResolvedValue({ ok: true });
    // 调路由 handler
    // 断言 runTaskForUser 被调 with 'ou_user', 'open_id'
  });

  it('解密失败 → 返回错误（4xx）', async () => {
    mockInvoke.mockImplementation(() => { throw new Error('decrypt failed'); });
    // 调路由 handler
    // 断言返回 4xx
  });

  it('未知事件类型 → 返回 {ok:true} 不报错', async () => {
    mockInvoke.mockReturnValue({ type: 'unknown.type', event: {} });
    // 调路由 handler
    // 断言返回 {ok:true}
  });
});
```

具体的 router mock 需要参考 `server/src/api/coins.ts` 等现有 register 函数的写法，复用模式。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx vitest run src/api/feishu-events.test.ts`

Expected: 失败（registerFeishuEvents 未导出）。

- [ ] **Step 3: 实现 feishu-events.ts**

创建 `server/src/api/feishu-events.ts`：

```ts
import { Router, type RouteContext } from '../http/router.js';
import { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { getConfig } from '../core/config.js';
import { createLogger } from '../util/logger.js';
import { runTaskForUser } from '../core/task.js';

const log = createLogger({ isTTY: false }).child('feishu-events');

let _dispatcher: EventDispatcher | null = null;

function getDispatcher(): EventDispatcher | null {
  const cfg = getConfig();
  if (!cfg.feishu_encrypt_key || !cfg.feishu_verification_token) return null;
  if (!_dispatcher) {
    _dispatcher = new EventDispatcher({
      verificationToken: cfg.feishu_verification_token,
      encryptKey: cfg.feishu_encrypt_key,
    });
  }
  return _dispatcher;
}

export function registerFeishuEvents(r: Router): void {
  r.post('/feishu/events', async (ctx: RouteContext) => {
    const dispatcher = getDispatcher();
    if (!dispatcher) {
      log.warn('feishu events endpoint hit but bot not configured');
      ctx.res.statusCode = 401;
      return { error: 'bot not configured' };
    }

    let event: { type: string; challenge?: string; event?: { action?: { value?: Record<string, unknown> }; sender?: { sender_id?: { open_id?: string } }; text?: { text?: string } }; token?: string };
    try {
      // SDK 签名：dispatcher.invoke(rawBody, headers)
      event = dispatcher.invoke(ctx.bodyRaw ?? '', ctx.req.headers as Record<string, string>) as typeof event;
    } catch (err) {
      log.warn('feishu event decrypt/verify failed', err);
      ctx.res.statusCode = 400;
      return { error: 'invalid event' };
    }

    // url_verification 握手
    if (event.type === 'url_verification') {
      return { challenge: event.challenge };
    }

    // card.action.trigger：用户点了按钮
    if (event.type === 'card.action.trigger' || event.type === 'card.action.trigger_v1') {
      const value = event.event?.action?.value;
      const openId = event.event?.sender?.sender_id?.open_id;
      if (value?.['action'] === 'query_now' && openId) {
        // 异步执行，不 await（必须在 3s 内返回飞书）
        runTaskForUser(openId, 'open_id').catch(err => {
          log.error(`runTaskForUser failed for ${openId}`, err);
        });
      } else {
        log.info('unrecognized card action', { value, openId });
      }
      return { ok: true };
    }

    // im.message.received（备用通道，未使用但要 ack）
    if (event.type === 'event.im.message.receive_v1') {
      log.info('feishu im.message.received', { text: event.event?.text?.text });
      return { ok: true };
    }

    log.info('unhandled feishu event type', { type: event.type });
    return { ok: true };
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run src/api/feishu-events.test.ts`

Expected: 全部 PASS。

- [ ] **Step 5: 跑全量测试**

Run: `cd server && npx vitest run`

Expected: 无回归。

- [ ] **Step 6: Commit**

```bash
git add server/src/api/feishu-events.ts server/src/api/feishu-events.test.ts
git commit -m "feat(api): add POST /feishu/events endpoint for card click callbacks"
```

---

## Task 8: 在 index.ts 注册新路由

**Files:**
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `registerFeishuEvents` 来自 Task 7
- Produces: HTTP 服务能处理 `POST /feishu/events`

- [ ] **Step 1: 在 import 块添加**

打开 `server/src/index.ts`，在 import 块（约 30-40 行附近）添加：

```ts
import { registerFeishuEvents } from './api/feishu-events.js';
```

- [ ] **Step 2: 在路由注册位置添加**

搜索 `registerTask(r)` 这一行附近（应该在 bootstrap 函数中），添加：

```ts
  registerFeishuEvents(r);
```

建议放在 `registerTask(r);` 之后（顺序不重要，但放一起方便阅读）。

- [ ] **Step 3: 验证 dev server 启动后路由可达**

Run: `npm run dev`（后台运行）

Expected: 服务起来后日志包含 `app:http:server listening on 0.0.0.0:8787`

Run: `curl -i -X POST http://localhost:8787/feishu/events -d '{}'`

Expected: 401 Unauthorized（未配 Bot 凭证，因为 endpoint handler 第一步就 reject）

- [ ] **Step 4: 停掉 dev server**

Run: 在后台运行 task 窗口里 Ctrl-C，或 `pkill -f "tsx watch"`

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts
git commit -m "chore(server): register POST /feishu/events route"
```

---

## Task 9: 更新 .env.example 和 README

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: 6 个新 env 变量名（来自 Task 2）
- Produces: 用户能根据文档完成飞书自建应用配置

- [ ] **Step 1: 在 .env.example 加 6 行**

打开 `.env.example`，在 `FEISHU_WEBHOOK_URL` 行附近添加：

```bash
# === Feishu 自建应用 Bot (可选，留空则降级到 webhook 纯文本推送) ===
# 飞书开放平台 → 应用 → 凭证：https://open.feishu.cn/app
FEISHU_APP_ID=
FEISHU_APP_SECRET=
# 事件订阅 → 加密配置：自定义字符串
FEISHU_ENCRYPT_KEY=
# 事件订阅 → Verification Token：自定义字符串
FEISHU_VERIFICATION_TOKEN=
# 定时推送的目标 ID（chat_id 或 open_id）
FEISHU_DEFAULT_RECEIVE_ID=
# chat_id | open_id | union_id | email
FEISHU_DEFAULT_RECEIVE_ID_TYPE=chat_id
```

- [ ] **Step 2: 在 README 加飞书自建应用配置章节**

打开 `README.md`，找到现有"飞书推送配置"或类似章节（如果不存在，新建章节），添加：

````markdown
## 飞书自建应用配置（可选，「立即查询」按钮功能）

定时推送默认走 **webhook 自定义机器人**（纯文本）。
要开启「🔄 立即查询」按钮（卡片可点击、点完 DM 给你），需要额外配置飞书自建应用 Bot。

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

### 4. 配置事件订阅

事件订阅 → 填写：
- 请求 URL：`https://你的域名/feishu/events`（开发期用 ngrok：`https://xxx.ngrok-free.app/feishu/events`）
- 勾选「Verification Token」→ 自定义字符串
- 勾选「Encrypt Key」→ 自定义字符串
- 添加事件：`card.action.trigger`（v1、v2）、`im.message.receive_v1`

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

参考 `.env.example` 的 Bot 字段，填上 6 个变量。重启服务即可。

### 8. 验证

- 等下次调度（或 dashboard 手点）→ 群里收到带按钮的卡片
- 点按钮 → 几秒后收到 DM
- 若凭证缺失 / 失败 → 自动降级 webhook 纯文本（无按钮）
````

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "docs: add feishu Bot app configuration guide"
```

---

## Task 10: 端到端手动验证

**Files:**
- 无（纯手工验证）

**Goal:** 全部 §9.2 手动验证清单通过（spec 文档）

- [ ] **Step 1: 部署 ngrok 反向隧道**

Run:
```bash
ngrok http 8787
```

Expected: ngrok 输出 `https://xxxx.ngrok-free.app → http://localhost:8787`

把 https URL 记下来：`$NGROK_URL`

- [ ] **Step 2: 在飞书后台填回调 URL**

飞书开放平台 → 事件订阅 → 请求 URL 填 `$NGROK_URL/feishu/events` → 保存

Expected: 飞书后台显示「已通过验证」（如果显示未通过，看 server 日志是否有 `url_verification handled` 错误）

- [ ] **Step 3: 触发定时推送**

Run: dashboard 手点「手动」，或等下一个调度周期

Expected: 群里收到**带「🔄 立即查询」按钮**的卡片（不是纯文本）

- [ ] **Step 4: 点按钮测试**

点击卡片上的「🔄 立即查询」按钮

Expected:
- 飞书 toast 转圈消失（3s 内）
- 6-10s 后你的手机收到 DM 卡片（含同样按钮）

- [ ] **Step 5: 验证降级路径**

```bash
# 临时改坏 APP_SECRET
sed -i '' 's/FEISHU_APP_SECRET=.*/FEISHU_APP_SECRET=wrong/' .env
# 重启服务
pkill -f "tsx watch" && npm run dev &
# 触发一次任务
curl -X POST http://localhost:8787/api/task/run -b "cpb_session=..."
```

Expected: 群里收到**纯文本**报告（无按钮）—— webhook 降级生效

```bash
# 改回正确值
sed -i '' 's/FEISHU_APP_SECRET=.*/FEISHU_APP_SECRET=<正确值>/' .env
```

- [ ] **Step 6: 验证 token 校验**

```bash
# 伪造一个不带 token 的 POST
curl -i -X POST http://localhost:8787/feishu/events \
  -H "Content-Type: application/json" \
  -d '{"type":"card.action.trigger"}'
```

Expected: 返回 401（Bot 未配时） 或 403（Bot 配了但 token 不匹配）

- [ ] **Step 7: 验证多用户并发**

连续点 3 次「立即查询」按钮（间隔 < 1s）

Expected: 收到 3 条 DM 报告（无节流，spec §4 已确认）

- [ ] **Step 8: 全部通过后写验收报告**

在仓库 `docs/superpowers/specs/2026-09-19-feishu-bot-events-design.md` 末尾的 §12 验收标准列表里把每个 checkbox 勾上，并标注日期。

- [ ] **Step 9: 提交验收状态**

```bash
git add docs/superpowers/specs/2026-09-19-feishu-bot-events-design.md
git commit -m "docs(spec): mark feishu bot events acceptance criteria complete"
```

---

## Summary

10 个任务，1 个 spec 文档，3 个新文件（`feishu-bot.ts`, `feishu-events.ts`, 各自测试），5 个修改文件（`config.ts`, `feishu.ts`, `formatter.ts`, `task.ts`, `index.ts`），2 个文档更新（`.env.example`, `README.md`），1 个依赖（`@larksuiteoapi/node-sdk`）。

每个任务独立可测、独立可回滚，遵循 TDD（先红后绿）。最终在生产环境通过 §10 全部验证清单后，spec §12 验收标准全部勾选。