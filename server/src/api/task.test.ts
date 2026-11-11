/**
 * api/task.ts 单元测试
 *
 * 覆盖：手动触发任务 / 查询下次运行时间的正常路径、鉴权失败（无 token / 错 token / 过期 token）、
 * nextRunAt 为 null 的分支，以及任务执行异常时的 500 兜底。
 *
 * 约束：
 * - 使用 better-sqlite3 内存库（:memory:），绝不写真实 data/*.db 文件
 * - core/task.ts（会真实抓行情 / 发消息）整体 mock，绝不发起任何真实网络请求
 * - scheduler（cron 定时器）整体 mock，避免真实定时任务与事件循环残留
 * - 测试数据统一以 `__test_` 前缀
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Router, handleRequest } from '../http/router.js';
import { errorMiddleware, authMiddleware, type Middleware } from '../http/middleware.js';
import { registerTask } from './task.js';
import { resolveAuthedUser } from './auth.js';
import { initDb, closeDb, getDb } from '../core/db.js';
import { createUser } from '../core/models/user.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ============ mock：任务执行（会真实抓行情 / 发 telegram、飞书） ============
vi.mock('../core/task.js', () => ({
  runTask: vi.fn(async () => ({
    reportId: 42,
    triggered_by: 'manual',
    success: true,
    totalCoins: 3,
    okCoins: 2,
    tgSent: true,
    feishuSent: false,
    message: '__test_任务消息',
  })),
}));
import { runTask } from '../core/task.js';

// ============ mock：调度器（避免真实 cron 定时器） ============
vi.mock('../core/scheduler.js', () => ({
  nextRunAt: vi.fn(() => new Date('2026-03-04T05:06:07.000Z')),
}));
import { nextRunAt } from '../core/scheduler.js';

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
  cookie?: string;
  useAuthMiddleware?: boolean;
}

async function callApi(router: Router, opts: CallOptions): Promise<Captured> {
  const cap: Captured = { status: 0, body: null, headers: {} };
  const res = makeRes(cap);
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers['cookie'] = opts.cookie;
  const req = { method: opts.method, url: opts.url, headers } as unknown as IncomingMessage;

  const chain: Middleware[] = [errorMiddleware];
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
registerTask(router);

beforeAll(async () => {
  initDb(':memory:');
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

describe('POST /api/task/run', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'POST', url: '/api/task/run' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('token 无效返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/task/run',
      cookie: COOKIE('__test_token_not_exist'),
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid or expired session');
  });

  it('token 已过期返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/task/run',
      cookie: COOKIE(TOKEN_EXPIRED),
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid or expired session');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/task/run',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('有效 token 时以 manual 触发任务并返回摘要', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/task/run',
      cookie: COOKIE(TOKEN),
    });

    expect(cap.status).toBe(200);
    expect(cap.body?.data).toEqual({
      reportId: 42,
      success: true,
      totalCoins: 3,
      okCoins: 2,
      tgSent: true,
      feishuSent: false,
    });
    expect(runTask).toHaveBeenCalledWith('manual');
  });

  it('任务执行抛错时返回 500', async () => {
    vi.mocked(runTask).mockRejectedValueOnce(new Error('__test_任务失败'));

    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/task/run',
      cookie: COOKIE(TOKEN),
    });

    expect(cap.status).toBe(500);
    expect(errMsg(cap)).toBe('__test_任务失败');
  });
});

describe('GET /api/task/next', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'GET', url: '/api/task/next' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('token 无效返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/task/next',
      cookie: COOKIE('__test_token_not_exist'),
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid or expired session');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/task/next',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('有下次运行时间时返回 ISO 字符串', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/task/next',
      cookie: COOKIE(TOKEN),
    });

    expect(cap.status).toBe(200);
    expect(cap.body?.data).toEqual({ nextRunAt: '2026-03-04T05:06:07.000Z' });
  });

  it('没有下次运行时间时返回 null', async () => {
    vi.mocked(nextRunAt).mockReturnValueOnce(null);
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/task/next',
      cookie: COOKIE(TOKEN),
    });

    expect(cap.status).toBe(200);
    expect(cap.body?.data).toEqual({ nextRunAt: null });
  });
});
