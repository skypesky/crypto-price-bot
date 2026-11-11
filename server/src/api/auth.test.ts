/**
 * api/auth.ts 单元测试
 *
 * 覆盖：登录 / 退出 / 修改密码 / resolveAuthedUser 的正常路径、鉴权失败（无 token / 错 token / 过期 token）、
 * 参数校验（缺字段、非法值、非 JSON）与业务错误（旧密码错误、用户不存在）。
 *
 * 约束：
 * - 使用 better-sqlite3 内存库（:memory:），绝不写真实 data/*.db 文件
 * - 不发起任何真实网络请求
 * - 所有测试数据（账号名 / token）统一以 `__test_` 前缀，便于批量清理
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Router, handleRequest } from '../http/router.js';
import { errorMiddleware, authMiddleware, type Middleware } from '../http/middleware.js';
import { registerAuth, resolveAuthedUser } from './auth.js';
import { initDb, closeDb, getDb } from '../core/db.js';
import { createUser, verifyLogin } from '../core/models/user.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ============ 测试常量（统一 __test_ 前缀） ============
const USER_A = '__test_user_a';
const PASS_A = '__test_pass_a';
const USER_B = '__test_user_b';
const PASS_B = '__test_pass_b';
const USER_C = '__test_user_c';
const PASS_C = '__test_pass_c';

const TOKEN_A = '__test_token_a';
const TOKEN_B = '__test_token_b';
const TOKEN_C = '__test_token_c';
const TOKEN_EXPIRED = '__test_token_expired';
const TOKEN_ORPHAN = '__test_token_orphan';
const TOKEN_LOGOUT = '__test_token_logout';
const TOKEN_LOGOUT2 = '__test_token_logout_2';

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
registerAuth(router);

beforeAll(async () => {
  initDb(':memory:');
  const ua = await createUser(USER_A, PASS_A);
  const ub = await createUser(USER_B, PASS_B);
  const uc = await createUser(USER_C, PASS_C);

  const db = getDb();
  const ins = db.prepare(
    'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  );
  const now = Date.now();
  ins.run(TOKEN_A, ua.id, now + 3_600_000, now);
  ins.run(TOKEN_B, ub.id, now + 3_600_000, now);
  ins.run(TOKEN_C, uc.id, now + 3_600_000, now);
  ins.run(TOKEN_LOGOUT, ua.id, now + 3_600_000, now);
  ins.run(TOKEN_LOGOUT2, ua.id, now + 3_600_000, now);
  ins.run(TOKEN_EXPIRED, ua.id, now - 3_600_000, now);
  // 孤儿 session：token 有效但 user_id 在 users 表里不存在（需临时关掉外键约束）
  db.pragma('foreign_keys = OFF');
  ins.run(TOKEN_ORPHAN, 999999, now + 3_600_000, now);
  db.pragma('foreign_keys = ON');
});

afterAll(() => {
  closeDb();
});

describe('POST /api/auth/login', () => {
  it('账号密码正确时登录成功并下发 session cookie', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/login',
      bodyRaw: JSON.stringify({ username: USER_A, password: PASS_A }),
    });

    expect(cap.status).toBe(200);
    expect(cap.body?.ok).toBe(true);
    expect(cap.body?.data).toEqual({ username: USER_A });

    const cookie = String(cap.headers['Set-Cookie']);
    expect(cookie).toContain('cpb_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=604800');
  });

  it('登录成功后数据库里新增了一条 session 记录', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c;
    await callApi(router, {
      method: 'POST',
      url: '/api/auth/login',
      bodyRaw: JSON.stringify({ username: USER_A, password: PASS_A }),
    });
    const after = (getDb().prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c;
    expect(after).toBe(before + 1);
  });

  it('密码错误返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/login',
      bodyRaw: JSON.stringify({ username: USER_A, password: '__test_wrong_password' }),
    });

    expect(cap.status).toBe(401);
    expect(cap.body?.ok).toBe(false);
    expect(errMsg(cap)).toBe('invalid username or password');
  });

  it('用户不存在返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/login',
      bodyRaw: JSON.stringify({ username: '__test_no_such_user', password: PASS_A }),
    });

    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid username or password');
  });

  it('缺少 username 字段返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/login',
      bodyRaw: JSON.stringify({ password: PASS_A }),
    });

    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('username');
  });

  it('username 为空字符串返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/login',
      bodyRaw: JSON.stringify({ username: '', password: PASS_A }),
    });

    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('username');
  });

  it('请求体不是合法 JSON 返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/login',
      bodyRaw: '{not-json',
    });

    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('invalid JSON');
  });

  it('完全没有请求体返回 400', async () => {
    const cap = await callApi(router, { method: 'POST', url: '/api/auth/login' });

    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('invalid JSON');
  });
});

describe('POST /api/auth/logout', () => {
  it('携带有效 token 时删除对应 session 并返回成功', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/logout',
      cookie: COOKIE(TOKEN_LOGOUT),
    });

    expect(cap.status).toBe(200);
    expect(cap.body?.data).toEqual({ ok: true });

    const row = getDb().prepare('SELECT * FROM sessions WHERE token = ?').get(TOKEN_LOGOUT);
    expect(row).toBeUndefined();
  });

  it('退出时清空 cookie（Max-Age=0）', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/logout',
      cookie: COOKIE(TOKEN_LOGOUT2),
    });

    expect(cap.status).toBe(200);
    expect(String(cap.headers['Set-Cookie'])).toContain('Max-Age=0');
  });

  it('没有 session cookie 时依然幂等返回成功', async () => {
    // 说明：生产环境里 authMiddleware 会先拦下无 cookie 的请求（返回 401），
    // 这里直接驱动 handler，验证「没有 token 时不删任何 session、仍然返回 ok」。
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/logout',
      useAuthMiddleware: false,
    });

    expect(cap.status).toBe(200);
    expect(cap.body?.data).toEqual({ ok: true });
    expect(String(cap.headers['Set-Cookie'])).toContain('Max-Age=0');
  });

  it('没有 session cookie 时走完整中间件链返回 401', async () => {
    const cap = await callApi(router, { method: 'POST', url: '/api/auth/logout' });

    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });
});

describe('POST /api/auth/change-password', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/change-password',
      bodyRaw: JSON.stringify({ oldPassword: PASS_B, newPassword: '__test_new_pass_1' }),
    });

    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/change-password',
      useAuthMiddleware: false,
      bodyRaw: JSON.stringify({ oldPassword: PASS_B, newPassword: '__test_new_pass_1' }),
    });

    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('完全没有请求体返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/change-password',
      cookie: COOKIE(TOKEN_B),
    });

    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('invalid JSON');
  });

  it('token 不存在返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/change-password',
      cookie: COOKIE('__test_token_not_exist'),
      bodyRaw: JSON.stringify({ oldPassword: PASS_B, newPassword: '__test_new_pass_1' }),
    });

    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid or expired session');
  });

  it('token 已过期返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/change-password',
      cookie: COOKIE(TOKEN_EXPIRED),
      bodyRaw: JSON.stringify({ oldPassword: PASS_B, newPassword: '__test_new_pass_1' }),
    });

    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid or expired session');
  });

  it('旧密码错误返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/change-password',
      cookie: COOKIE(TOKEN_B),
      bodyRaw: JSON.stringify({ oldPassword: '__test_wrong_old', newPassword: '__test_new_pass_1' }),
    });

    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('old password is incorrect');
  });

  it('新密码长度不足返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/change-password',
      cookie: COOKIE(TOKEN_B),
      bodyRaw: JSON.stringify({ oldPassword: PASS_B, newPassword: 'short' }),
    });

    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('newPassword');
  });

  it('缺少 oldPassword 字段返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/change-password',
      cookie: COOKIE(TOKEN_B),
      bodyRaw: JSON.stringify({ newPassword: '__test_new_pass_1' }),
    });

    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('oldPassword');
  });

  it('改密成功：新密码生效且该用户所有 session 被清空', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/auth/change-password',
      cookie: COOKIE(TOKEN_C),
      bodyRaw: JSON.stringify({ oldPassword: PASS_C, newPassword: '__test_new_pass_c' }),
    });

    expect(cap.status).toBe(200);
    expect(cap.body?.data?.ok).toBe(true);
    expect(cap.body?.data?.message).toContain('password changed');

    // 新密码可登录、旧密码不可登录
    expect(await verifyLogin(USER_C, '__test_new_pass_c')).not.toBeNull();
    expect(await verifyLogin(USER_C, PASS_C)).toBeNull();

    // 该用户的所有 session 都被删除
    const rows = getDb().prepare('SELECT * FROM sessions WHERE user_id = ?').all(userIdOf(USER_C));
    expect(rows.length).toBe(0);
  });
});

describe('resolveAuthedUser', () => {
  it('有效 token 返回用户 id 与用户名', async () => {
    const user = await resolveAuthedUser(TOKEN_A);
    expect(user).not.toBeNull();
    expect(user?.username).toBe(USER_A);
    expect(user?.id).toBe(userIdOf(USER_A));
  });

  it('token 不存在返回 null', async () => {
    expect(await resolveAuthedUser('__test_token_not_exist')).toBeNull();
  });

  it('token 已过期返回 null', async () => {
    expect(await resolveAuthedUser(TOKEN_EXPIRED)).toBeNull();
  });

  it('session 有效但用户已被删除返回 null', async () => {
    expect(await resolveAuthedUser(TOKEN_ORPHAN)).toBeNull();
  });
});

/** 查某个用户名的 id（测试辅助） */
function userIdOf(username: string): number {
  const row = getDb().prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
  return row.id;
}
