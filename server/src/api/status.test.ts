/**
 * api/status.ts 单元测试
 *
 * 覆盖：状态接口的正常路径、公开路由（无需登录）、无报表 / 有报表两种 lastReportAt 分支、
 * nextRunAt 为 null 的分支，以及 sqlite 版本查询失败时的降级分支。
 *
 * 约束：
 * - 使用 better-sqlite3 内存库（:memory:），绝不写真实 data/*.db 文件
 * - scheduler（cron 定时器）整体 mock，避免真实定时任务与事件循环残留
 * - 不发起任何真实网络请求
 * - 测试数据统一以 `__test_` 前缀
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Router, handleRequest } from '../http/router.js';
import { errorMiddleware, authMiddleware, type Middleware } from '../http/middleware.js';
import { registerStatus } from './status.js';
import { resolveAuthedUser } from './auth.js';
import { initDb, closeDb, getDb } from '../core/db.js';
import { createUser } from '../core/models/user.js';
import { initDefaults } from '../core/models/setting.js';
import { initDefaultCoins } from '../core/models/coin.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ============ mock：调度器（避免真实 cron 定时器） ============
vi.mock('../core/scheduler.js', () => ({
  nextRunAt: vi.fn(() => new Date('2026-01-01T00:00:00.000Z')),
}));
import { nextRunAt } from '../core/scheduler.js';

// ============ mock：DB（只为覆盖 sqlite_version() 查询失败的降级分支） ============
const dbState = vi.hoisted(() => ({ failVersionQuery: false }));

vi.mock('../core/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/db.js')>();
  return {
    ...actual,
    getDb: () => {
      const real = actual.getDb();
      if (!dbState.failVersionQuery) return real;
      // 只让 sqlite_version() 查询抛错，其它查询照常走真实内存库
      return {
        prepare: (sql: string) =>
          sql.includes('sqlite_version()')
            ? { get: () => { throw new Error('__test_sqlite_version_failed'); } }
            : real.prepare(sql),
        pragma: (p: string) => real.pragma(p),
        exec: (sql: string) => real.exec(sql),
        transaction: (fn: any) => (real as any).transaction(fn),
        close: () => real.close(),
      };
    },
  };
});

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

const router = new Router();
registerStatus(router);

beforeAll(async () => {
  initDb(':memory:');
  initDefaults();
  initDefaultCoins();
  const u = await createUser(USER, PASS);
  const now = Date.now();
  const ins = getDb().prepare(
    'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  );
  ins.run(TOKEN, u.id, now + 3_600_000, now);
  ins.run(TOKEN_EXPIRED, u.id, now - 3_600_000, now);
});

afterAll(() => {
  dbState.failVersionQuery = false;
  closeDb();
});

describe('GET /api/status', () => {
  it('公开路由：不带任何 cookie 也能返回状态', async () => {
    const cap = await callApi(router, { method: 'GET', url: '/api/status' });

    expect(cap.status).toBe(200);
    expect(cap.body?.ok).toBe(true);
    const data = cap.body?.data as any;
    expect(typeof data.version).toBe('string');
    expect(data.version.length).toBeGreaterThan(0);
    expect(typeof data.uptime).toBe('number');
    expect(data.uptime).toBeGreaterThan(0);
    expect(data.dbOk).toBe(true);
    expect(typeof data.sqliteVersion).toBe('string');
    expect(data.totalCoins).toBe(11);
    expect(data.userCount).toBe(1);
    expect(data.timezone).toBe('Asia/Shanghai');
    expect(data.scheduleRule).toBe('0 */10 * * * *');
  });

  it('公开路由：带着无效 token 也返回 200', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/status',
      cookie: COOKIE('__test_token_not_exist'),
    });
    expect(cap.status).toBe(200);
  });

  it('还没有任何报表时 lastReportAt 为 null', async () => {
    getDb().prepare('DELETE FROM reports').run();
    const cap = await callApi(router, { method: 'GET', url: '/api/status' });
    expect(cap.status).toBe(200);
    expect((cap.body?.data as any).lastReportAt).toBeNull();
  });

  it('有报表时 lastReportAt 为报表创建时间的 ISO 字符串', async () => {
    const createdAt = 1_700_000_000_000;
    getDb().prepare('DELETE FROM reports').run();
    getDb().prepare(
      'INSERT INTO reports (id, triggered_by, success, total_coins, ok_coins, tg_sent, feishu_sent, message, summary, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(1, 'test', 1, 1, 1, 1, 1, '__test_报告', '{}', createdAt);

    const cap = await callApi(router, { method: 'GET', url: '/api/status' });
    expect(cap.status).toBe(200);
    expect((cap.body?.data as any).lastReportAt).toBe(new Date(createdAt).toISOString());
  });

  it('调度器没有下一次运行时间时 nextRunAt 为 null', async () => {
    vi.mocked(nextRunAt).mockReturnValueOnce(null);
    const cap = await callApi(router, { method: 'GET', url: '/api/status' });
    expect(cap.status).toBe(200);
    expect((cap.body?.data as any).nextRunAt).toBeNull();
  });

  it('调度器有下一次运行时间时 nextRunAt 为 ISO 字符串', async () => {
    vi.mocked(nextRunAt).mockReturnValueOnce(new Date('2026-02-03T04:05:06.000Z'));
    const cap = await callApi(router, { method: 'GET', url: '/api/status' });
    expect(cap.status).toBe(200);
    expect((cap.body?.data as any).nextRunAt).toBe('2026-02-03T04:05:06.000Z');
  });

  it('sqlite 版本查询失败时降级为 null，其余字段仍然正常', async () => {
    dbState.failVersionQuery = true;
    try {
      const cap = await callApi(router, { method: 'GET', url: '/api/status' });
      expect(cap.status).toBe(200);
      const data = cap.body?.data as any;
      expect(data.sqliteVersion).toBeNull();
      expect(data.dbOk).toBe(true);
      expect(data.totalCoins).toBe(11);
    } finally {
      dbState.failVersionQuery = false;
    }
  });
});
