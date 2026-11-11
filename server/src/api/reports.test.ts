/**
 * api/reports.ts 单元测试
 *
 * 覆盖：报表列表 / 详情 / 重发 / 单条删除 / 批量删除 / 清空 的正常路径、
 * 鉴权失败（无 token / 错 token / 过期 token）、参数校验与业务错误（报表不存在 → 404、id 非法 → 400）。
 *
 * 约束：
 * - 使用 better-sqlite3 内存库（:memory:），绝不写真实 data/*.db 文件
 * - core/task.ts（会真实发飞书 / telegram）整体 mock 掉，绝不发起任何真实网络请求
 * - 测试数据统一以 `__test_` 前缀
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Router, handleRequest, type RouteContext } from '../http/router.js';
import { errorMiddleware, authMiddleware, type Middleware } from '../http/middleware.js';
import { HttpError } from '../http/errors.js';
import { registerReports } from './reports.js';
import { resolveAuthedUser } from './auth.js';
import { initDb, closeDb, getDb } from '../core/db.js';
import { createUser } from '../core/models/user.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// core/task.ts 会真实推送消息，整体 mock；resendReport 变成可断言的 mock
vi.mock('../core/task.js', () => ({
  resendReport: vi.fn(async () => ({ tg: false, feishu: false })),
  runTask: vi.fn(async () => ({
    reportId: 0, triggered_by: 'manual', success: true, totalCoins: 0, okCoins: 0,
    tgSent: false, feishuSent: false, message: '',
  })),
}));
import { resendReport } from '../core/task.js';

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

/** 直接调用 handler（绕过 Router 的路径解析），用于构造「缺参数」这类防御性分支 */
async function callHandler(
  router: Router,
  method: string,
  url: string,
  overrides: Partial<RouteContext> = {},
): Promise<Captured> {
  const matched = router.match(method, url);
  if (!matched) throw new Error(`route not found: ${method} ${url}`);
  const cap: Captured = { status: 0, body: null, headers: {} };
  const res = makeRes(cap);
  const req = { method, url, headers: {} } as unknown as IncomingMessage;
  const ctx: RouteContext = {
    req,
    res,
    pathname: url.split('?')[0] ?? '/',
    query: new URLSearchParams(url.split('?')[1] ?? ''),
    params: matched.params,
    user: { id: 1, username: USER },
    ...overrides,
  };
  try {
    await matched.handler(ctx);
  } catch (err) {
    const e = err as HttpError;
    cap.status = typeof e.status === 'number' ? e.status : 500;
    cap.body = {
      ok: false,
      data: { error: { code: e.code ?? 'internal_error', message: e.message } },
    };
  }
  return cap;
}

/** 错误响应的 message（sendError 的载荷结构是 { ok:false, data:{ error:{ code, message } } }） */
function errMsg(cap: Captured): string {
  return String(cap.body?.data?.error?.message ?? '');
}

const router = new Router();
registerReports(router);

/** 插入一条测试报表（id / created_at 固定，保证列表顺序可预期） */
function insertReport(id: number, createdAt: number, message: string): void {
  getDb().prepare(
    'INSERT INTO reports (id, triggered_by, success, total_coins, ok_coins, tg_sent, feishu_sent, message, summary, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'test', 1, 3, 3, 1, 1, message, JSON.stringify({ __test: true }), createdAt);
}

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

// 每个用例前把报表表重置成已知状态，保证用例之间互不依赖（可任意顺序执行）
beforeEach(() => {
  getDb().prepare('DELETE FROM reports').run();
  insertReport(1, 1_000, '__test_报告一');
  insertReport(2, 2_000, '__test_报告二');
  insertReport(3, 3_000, '__test_报告三');
  vi.mocked(resendReport).mockReset();
  vi.mocked(resendReport).mockResolvedValue({ tg: true, feishu: false });
});

afterAll(() => {
  closeDb();
});

describe('GET /api/reports', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'GET', url: '/api/reports' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('token 无效返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/reports',
      cookie: COOKIE('__test_token_not_exist'),
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid or expired session');
  });

  it('token 已过期返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/reports',
      cookie: COOKIE(TOKEN_EXPIRED),
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid or expired session');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/reports',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('有效 token 时按创建时间倒序返回报表列表', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/reports',
      cookie: COOKIE(TOKEN),
    });

    expect(cap.status).toBe(200);
    const data = cap.body?.data as any[];
    expect(data.length).toBe(3);
    expect(data.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(data[0]?.message).toBe('__test_报告三');
  });

  it('limit=1 时只返回最新一条', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/reports?limit=1',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(200);
    const data = cap.body?.data as any[];
    expect(data.length).toBe(1);
    expect(data[0]?.id).toBe(3);
  });

  it('limit 为非数字时回落到默认 50 条', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/reports?limit=abc',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(200);
    expect((cap.body?.data as any[]).length).toBe(3);
  });
});

describe('GET /api/reports/:id', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'GET', url: '/api/reports/1' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/reports/1',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('有效 token 时返回报表详情', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/reports/1',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(200);
    expect((cap.body?.data as any).id).toBe(1);
    expect((cap.body?.data as any).message).toBe('__test_报告一');
  });

  it('id 不是数字返回 400', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/reports/abc',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toBe('invalid id');
  });

  it('缺少 id 参数时返回 400（防御性分支）', async () => {
    const cap = await callHandler(router, 'GET', '/api/reports/1', { params: {} });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toBe('invalid id');
  });

  it('报表不存在返回 404', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/reports/999',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(404);
    expect(errMsg(cap)).toBe('report 999 not found');
  });
});

describe('POST /api/reports/:id/resend', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'POST', url: '/api/reports/1/resend' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/1/resend',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('重发成功：把报表原文和渠道传给 resendReport', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/1/resend',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ channels: ['tg', 'feishu'] }),
    });

    expect(cap.status).toBe(200);
    expect(cap.body?.data).toEqual({ tg: true, feishu: false });
    expect(resendReport).toHaveBeenCalledTimes(1);
    expect(resendReport).toHaveBeenCalledWith('__test_报告一', ['tg', 'feishu']);
  });

  it('只重发 telegram 时只传一个渠道', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/2/resend',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ channels: ['tg'] }),
    });

    expect(cap.status).toBe(200);
    expect(resendReport).toHaveBeenCalledWith('__test_报告二', ['tg']);
  });

  it('channels 为空数组返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/1/resend',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ channels: [] }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('channels');
  });

  it('channels 含非法渠道返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/1/resend',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ channels: ['sms'] }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('channels');
  });

  it('完全没有请求体返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/1/resend',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('invalid JSON');
  });

  it('id 不是数字返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/abc/resend',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ channels: ['tg'] }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toBe('invalid id');
  });

  it('缺少 id 参数时返回 400（防御性分支）', async () => {
    const cap = await callHandler(router, 'POST', '/api/reports/1/resend', { params: {} });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toBe('invalid id');
  });

  it('报表不存在返回 404', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/999/resend',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ channels: ['tg'] }),
    });
    expect(cap.status).toBe(404);
    expect(errMsg(cap)).toBe('report 999 not found');
  });
});

describe('DELETE /api/reports/:id', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'DELETE', url: '/api/reports/1' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'DELETE',
      url: '/api/reports/1',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('删除成功返回 deleted=1', async () => {
    const cap = await callApi(router, {
      method: 'DELETE',
      url: '/api/reports/1',
      cookie: COOKIE(TOKEN),
    });

    expect(cap.status).toBe(200);
    expect(cap.body?.data).toEqual({ ok: true, deleted: 1 });
    expect(getDb().prepare('SELECT * FROM reports WHERE id = 1').get()).toBeUndefined();
  });

  it('id 不是数字返回 400', async () => {
    const cap = await callApi(router, {
      method: 'DELETE',
      url: '/api/reports/abc',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toBe('invalid id');
  });

  it('缺少 id 参数时返回 400（防御性分支）', async () => {
    const cap = await callHandler(router, 'DELETE', '/api/reports/1', { params: {} });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toBe('invalid id');
  });

  it('报表不存在返回 404', async () => {
    const cap = await callApi(router, {
      method: 'DELETE',
      url: '/api/reports/999',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(404);
    expect(errMsg(cap)).toBe('report 999 not found');
  });
});

describe('POST /api/reports/delete-batch', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'POST', url: '/api/reports/delete-batch' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/delete-batch',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('批量删除成功返回删除条数', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/delete-batch',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ ids: [1, 2] }),
    });

    expect(cap.status).toBe(200);
    expect(cap.body?.data).toEqual({ ok: true, deleted: 2 });
    expect((getDb().prepare('SELECT COUNT(*) as c FROM reports').get() as { c: number }).c).toBe(1);
  });

  it('ids 为空数组返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/delete-batch',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ ids: [] }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('ids');
  });

  it('含未知字段返回 400（strict schema）', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/delete-batch',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ ids: [1], __test_unknown: true }),
    });
    expect(cap.status).toBe(400);
  });

  it('完全没有请求体返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/delete-batch',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('invalid JSON');
  });
});

describe('POST /api/reports/clear', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'POST', url: '/api/reports/clear' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/clear',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('清空全部报表成功', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/reports/clear',
      cookie: COOKIE(TOKEN),
    });

    expect(cap.status).toBe(200);
    expect(cap.body?.data).toEqual({ ok: true, deleted: 3 });
    expect((getDb().prepare('SELECT COUNT(*) as c FROM reports').get() as { c: number }).c).toBe(0);
  });
});
