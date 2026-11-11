/**
 * api/settings.ts 单元测试
 *
 * 覆盖：读取设置 / 更新设置的正常路径、鉴权失败（无 token / 错 token / 过期 token）、
 * 参数校验（未知字段、空字符串、非法 cron、非法 URL、非 JSON 请求体）。
 *
 * 约束：
 * - 使用 better-sqlite3 内存库（:memory:），绝不写真实 data/*.db 文件
 * - 不发起任何真实网络请求
 * - 测试数据统一以 `__test_` 前缀
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Router, handleRequest } from '../http/router.js';
import { errorMiddleware, authMiddleware, type Middleware } from '../http/middleware.js';
import { registerSettings } from './settings.js';
import { resolveAuthedUser } from './auth.js';
import { initDb, closeDb, getDb } from '../core/db.js';
import { createUser } from '../core/models/user.js';
import { initDefaults, getSetting } from '../core/models/setting.js';
import { getConfig } from '../core/config.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ============ 测试常量（统一 __test_ 前缀） ============
const USER = '__test_user';
const PASS = '__test_pass';
const TOKEN = '__test_token_valid';
const TOKEN_EXPIRED = '__test_token_expired';
const COOKIE = (token: string): string => `cpb_session=${token}`;

// ============ 测试脚手架：模拟 req / res，直接驱动 Router ============
interface Captured {
  status: number;
  body: { ok: boolean; data?: any; error?: { code: string; message: string } } | null;
  headers: Record<string, unknown>;
}

function makeRes(cap: Captured): ServerResponse {
  const headers: Record<string, unknown> = {};
  cap.headers = headers;
  const res: any = {
    statusCode: 200,
    setHeader(k: string, v: unknown) { headers[k] = v; },
    getHeader(k: string) { return headers[k]; },
    writeHead(status: number) { res.statusCode = status; cap.status = status; },
    end(body?: string) { cap.body = body ? JSON.parse(body) : null; },
    on() { return undefined; },
  };
  return res as ServerResponse;
}

interface CallOptions {
  method: string;
  url: string;
  bodyRaw?: string;
  cookie?: string;
  /** 是否挂载生产环境的 authMiddleware（默认 true；false = 直接测 handler 自身的守卫） */
  useAuthMiddleware?: boolean;
}

async function callApi(router: Router, opts: CallOptions): Promise<Captured> {
  const cap: Captured = { status: 0, body: null, headers: {} };
  const res = makeRes(cap);
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers['cookie'] = opts.cookie;
  const req = { method: opts.method, url: opts.url, headers } as unknown as IncomingMessage;

  const chain: Middleware[] = [
    errorMiddleware,
    async (ctx, next) => {
      if (opts.bodyRaw !== undefined) ctx.bodyRaw = opts.bodyRaw;
      await next();
    },
  ];
  if (opts.useAuthMiddleware !== false) {
    chain.push(authMiddleware(resolveAuthedUser));
  }
  await handleRequest(req, res, router, chain);
  return cap;
}

/** 错误响应的 message（sendError 的载荷结构是 { ok:false, data:{ error:{ code, message } } }） */
function errMsg(cap: Captured): string {
  return String(cap.body?.data?.error?.message ?? '');
}

const router = new Router();
registerSettings(router);

beforeAll(async () => {
  initDb(':memory:');
  initDefaults();
  const u = await createUser(USER, PASS);
  const now = Date.now();
  const ins = getDb().prepare(
    'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  );
  ins.run(TOKEN, u.id, now + 3_600_000, now);
  ins.run(TOKEN_EXPIRED, u.id, now - 3_600_000, now);
});

afterAll(() => {
  closeDb();
});

describe('GET /api/settings', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'GET', url: '/api/settings' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('token 无效返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/settings',
      cookie: COOKIE('__test_token_not_exist'),
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid or expired session');
  });

  it('token 已过期返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/settings',
      cookie: COOKIE(TOKEN_EXPIRED),
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid or expired session');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/settings',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('有效 token 时返回全部设置项及默认值', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/settings',
      cookie: COOKIE(TOKEN),
    });

    expect(cap.status).toBe(200);
    const data = cap.body?.data as any;
    expect(data.timezone).toBe('Asia/Shanghai');
    expect(data.schedule_rule).toBe('0 */10 * * * *');
    expect(data.max_retries).toBe(1);
    expect(data.request_timeout_ms).toBe(15000);
    expect(data.alert_cooldown_hours).toBe(24);
    expect(data.doh_enabled).toBe(true);
    expect(Array.isArray(data.doh_bypass)).toBe(true);
  });
});

describe('PUT /api/settings', () => {
  // 注：JSON 无法表达 undefined，且 zod 解析后未提供的可选键不会出现在结果里，
  // 源码 `if (v === undefined) continue;` 的分支不可达（死代码，见最终报告）。
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'PUT', url: '/api/settings' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('token 无效返回 401', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/settings',
      cookie: COOKIE('__test_token_not_exist'),
      bodyRaw: JSON.stringify({ timezone: 'UTC' }),
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid or expired session');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/settings',
      useAuthMiddleware: false,
      bodyRaw: JSON.stringify({ timezone: 'UTC' }),
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('包含未知字段返回 400（strict schema）', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/settings',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ __test_unknown_key: 'x' }),
    });
    expect(cap.status).toBe(400);
  });

  it('timezone 为空字符串返回 400', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/settings',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ timezone: '' }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('timezone');
  });

  it('schedule_rule 不是 6 段 cron 返回 400', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/settings',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ schedule_rule: '0 * * * *' }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('schedule_rule');
  });

  it('feishu_webhook_url 不是合法 URL 返回 400', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/settings',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ feishu_webhook_url: 'not-a-url' }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('feishu_webhook_url');
  });

  it('max_retries 超过上限返回 400', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/settings',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ max_retries: 99 }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('max_retries');
  });

  it('完全没有请求体返回 400', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/settings',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('invalid JSON');
  });

  it('更新成功：返回值与数据库都被更新', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/settings',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ timezone: 'UTC', max_retries: 3 }),
    });

    expect(cap.status).toBe(200);
    const data = cap.body?.data as any;
    expect(data.timezone).toBe('UTC');
    expect(data.max_retries).toBe(3);
    expect(getSetting('timezone')).toBe('UTC');
    expect(getSetting('max_retries')).toBe(3);
  });

  it('更新成功后会 reloadConfig，运行时配置同步更新', async () => {
    await callApi(router, {
      method: 'PUT',
      url: '/api/settings',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ timezone: 'Asia/Tokyo', schedule_rule: '0 0 9 * * *' }),
    });

    const cfg = getConfig();
    expect(cfg.timezone).toBe('Asia/Tokyo');
    expect(cfg.schedule_rule).toBe('0 0 9 * * *');
  });

  it('把某项设置为 null 也能落库', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/settings',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ tg_bot_token: null, tg_chat_id: null }),
    });

    expect(cap.status).toBe(200);
    const data = cap.body?.data as any;
    expect(data.tg_bot_token).toBeNull();
    expect(data.tg_chat_id).toBeNull();
    expect(getSetting('tg_bot_token')).toBeNull();
  });

  it('数组类型设置项（doh_bypass）可以更新', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/settings',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ doh_bypass: ['__test_dns_1', '__test_dns_2'] }),
    });

    expect(cap.status).toBe(200);
    expect((cap.body?.data as any).doh_bypass).toEqual(['__test_dns_1', '__test_dns_2']);
    expect(getSetting('doh_bypass')).toEqual(['__test_dns_1', '__test_dns_2']);
  });

  it('布尔类型设置项（doh_enabled）可以更新', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/settings',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ doh_enabled: false }),
    });

    expect(cap.status).toBe(200);
    expect((cap.body?.data as any).doh_enabled).toBe(false);
    expect(getSetting('doh_enabled')).toBe(false);
  });
});
