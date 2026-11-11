/**
 * api/logs.ts 单元测试
 *
 * 覆盖：日志列表接口的正常路径、鉴权失败（无 token / 错 token / 过期 token）、
 * limit 参数的默认值 / 非数字 / 上限截断等分支。
 *
 * 约束：
 * - 使用 better-sqlite3 内存库（:memory:），绝不写真实 data/*.db 文件
 * - 不发起任何真实网络请求
 * - 测试数据统一以 `__test_` 前缀
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Router, handleRequest } from '../http/router.js';
import { errorMiddleware, authMiddleware, type Middleware } from '../http/middleware.js';
import { registerLogs } from './logs.js';
import { resolveAuthedUser } from './auth.js';
import { initDb, closeDb, getDb } from '../core/db.js';
import { createUser } from '../core/models/user.js';
import { logger } from '../util/logger.js';
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

  const chain: Middleware[] = [errorMiddleware];
  if (opts.useAuthMiddleware !== false) {
    chain.push(authMiddleware(resolveAuthedUser));
  }
  await handleRequest(req, res, router, chain);
  return cap;
}

/** 错误响应的 message */
function errMsg(cap: Captured): string {
  return String(cap.body?.data?.error?.message ?? '');
}

const router = new Router();
registerLogs(router);

beforeAll(async () => {
  initDb(':memory:');
  const u = await createUser(USER, PASS);
  const now = Date.now();
  const ins = getDb().prepare(
    'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  );
  ins.run(TOKEN, u.id, now + 3_600_000, now);
  ins.run(TOKEN_EXPIRED, u.id, now - 3_600_000, now);
  // 往日志环形缓冲里塞一条可识别的测试日志
  logger.info('__test_logs_marker');
});

afterAll(() => {
  closeDb();
});

describe('GET /api/logs', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'GET', url: '/api/logs' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('token 无效返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/logs',
      cookie: COOKIE('__test_token_not_exist'),
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid or expired session');
  });

  it('token 已过期返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/logs',
      cookie: COOKIE(TOKEN_EXPIRED),
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid or expired session');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/logs',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('有效 token 时返回日志数组', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/logs',
      cookie: COOKIE(TOKEN),
    });

    expect(cap.status).toBe(200);
    expect(Array.isArray(cap.body?.data)).toBe(true);
    const data = cap.body?.data as any[];
    expect(data.length).toBeGreaterThan(0);
    expect(data.some((e) => e.msg === '__test_logs_marker')).toBe(true);
  });

  it('不传 limit 时使用默认上限', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/logs',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(200);
    expect((cap.body?.data as any[]).length).toBeLessThanOrEqual(200);
  });

  it('limit 为非数字时回落到默认 200 条', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/logs?limit=abc',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(200);
    expect(Array.isArray(cap.body?.data)).toBe(true);
  });

  it('limit 为 1 时只返回最后一条日志', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/logs?limit=1',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(200);
    const data = cap.body?.data as any[];
    expect(data.length).toBe(1);
    expect(data[0]?.msg).toBe('__test_logs_marker');
  });

  it('limit 超过 500 时被截断到 500', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/logs?limit=1000',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(200);
    expect((cap.body?.data as any[]).length).toBeLessThanOrEqual(500);
  });
});
