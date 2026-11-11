/**
 * api/coins.ts 单元测试
 *
 * 覆盖：币种列表 / 新建 / 更新 / 删除 / 排序 的正常路径、鉴权失败、参数校验与业务错误
 * （symbol 重复 → 409、id 不存在 → 404、id 非法 → 400）。
 *
 * 约束：
 * - 使用 better-sqlite3 内存库（:memory:），绝不写真实 data/*.db 文件
 * - 不发起任何真实网络请求
 * - 测试数据统一以 `__test_` 前缀（symbol 受 `/^[A-Z0-9]+$/` 约束无法带下划线，
 *   改由 name / cg_id 字段承载 `__test_` 前缀）
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Router, handleRequest, type RouteContext } from '../http/router.js';
import { errorMiddleware, authMiddleware, type Middleware } from '../http/middleware.js';
import { HttpError } from '../http/errors.js';
import { registerCoins } from './coins.js';
import { resolveAuthedUser } from './auth.js';
import { initDb, closeDb, getDb } from '../core/db.js';
import { createUser } from '../core/models/user.js';
import { createCoin as realCreateCoin, initDefaultCoins, listCoins } from '../core/models/coin.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// 只把 createCoin 换成可 mock 的版本，其余 model 函数保持真实实现
vi.mock('../core/models/coin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/models/coin.js')>();
  return { ...actual, createCoin: vi.fn(actual.createCoin) };
});
import { createCoin } from '../core/models/coin.js';

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
registerCoins(router);

beforeAll(async () => {
  initDb(':memory:');
  initDefaultCoins();
  const u = await createUser(USER, PASS);
  const db = getDb();
  const ins = db.prepare(
    'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  );
  const now = Date.now();
  ins.run(TOKEN, u.id, now + 3_600_000, now);
  ins.run(TOKEN_EXPIRED, u.id, now - 3_600_000, now);
});

afterAll(() => {
  closeDb();
});

describe('GET /api/coins', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'GET', url: '/api/coins' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('token 无效返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/coins',
      cookie: COOKIE('__test_token_not_exist'),
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid or expired session');
  });

  it('token 已过期返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/coins',
      cookie: COOKIE(TOKEN_EXPIRED),
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('invalid or expired session');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/coins',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('有效 token 时返回币种列表', async () => {
    const cap = await callApi(router, {
      method: 'GET',
      url: '/api/coins',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(200);
    expect(Array.isArray(cap.body?.data)).toBe(true);
    const data = cap.body?.data as any[];
    expect(data.length).toBe(11);
    expect(data[0]?.symbol).toBe('QNT');
    expect(data.some((c) => c.symbol === 'BTC')).toBe(true);
  });
});

describe('POST /api/coins', () => {
  // 注：coinSchema.sort_order 带 `.default(0)`，zod 解析后 parsed.data.sort_order 恒有值，
  // 源码 `parsed.data.sort_order ?? 0` 的兜底分支不可达（死代码，见最终报告）。
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'POST', url: '/api/coins' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('缺少 symbol 字段返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ name: '__test_币', gate_pair: 'TEST_USDT', cg_id: '__test_cg' }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('symbol');
  });

  it('symbol 含小写字母返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({
        symbol: 'test', name: '__test_币', gate_pair: 'TEST_USDT', cg_id: '__test_cg',
      }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('symbol');
  });

  it('gate_pair 格式非法返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({
        symbol: 'TESTX', name: '__test_币', gate_pair: 'bad-pair', cg_id: '__test_cg',
      }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('gate_pair');
  });

  it('完全没有请求体返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('invalid JSON');
  });

  it('有效 token 时创建币种成功并返回完整字段', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({
        symbol: 'TESTA',
        name: '__test_测试币A',
        gate_pair: 'TESTA_USDT',
        gate_slug: 'testa',
        binance_pair: 'TESTA_USDT',
        cg_id: '__test_cg_a',
        sort_order: 50,
        enabled: true,
        alert_above: 123.5,
        alert_below: 1.5,
      }),
    });

    expect(cap.status).toBe(200);
    const data = cap.body?.data as any;
    expect(data.symbol).toBe('TESTA');
    expect(data.name).toBe('__test_测试币A');
    expect(data.gate_pair).toBe('TESTA_USDT');
    expect(data.gate_slug).toBe('testa');
    expect(data.binance_pair).toBe('TESTA_USDT');
    expect(data.cg_id).toBe('__test_cg_a');
    expect(data.sort_order).toBe(50);
    expect(data.enabled).toBe(1);
    expect(data.alert_above).toBe(123.5);
    expect(data.alert_below).toBe(1.5);
  });

  it('省略可选字段时 gate_slug / binance_pair / 阈值为 null、排序为 0、启用为 1', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({
        symbol: 'TESTB', name: '__test_测试币B', gate_pair: null, cg_id: '__test_cg_b',
      }),
    });

    expect(cap.status).toBe(200);
    const data = cap.body?.data as any;
    expect(data.gate_pair).toBeNull();
    expect(data.gate_slug).toBeNull();
    expect(data.binance_pair).toBeNull();
    expect(data.alert_above).toBeNull();
    expect(data.alert_below).toBeNull();
    expect(data.sort_order).toBe(0);
    expect(data.enabled).toBe(1);
  });

  it('enabled 为 false 时落库为 0', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({
        symbol: 'TESTC', name: '__test_测试币C', gate_pair: 'TESTC_USDT', cg_id: '__test_cg_c',
        enabled: false,
      }),
    });

    expect(cap.status).toBe(200);
    expect((cap.body?.data as any).enabled).toBe(0);
  });

  it('symbol 已存在返回 409', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({
        symbol: 'BTC', name: '__test_重复币', gate_pair: 'BTC_USDT', cg_id: '__test_cg_dup',
      }),
    });

    expect(cap.status).toBe(409);
    expect(errMsg(cap)).toBe('symbol already exists');
  });

  it('非 UNIQUE 的底层错误原样抛出（500）', async () => {
    vi.mocked(createCoin).mockImplementationOnce(() => {
      throw new Error('__test_底层数据库错误');
    });

    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({
        symbol: 'TESTD', name: '__test_测试币D', gate_pair: 'TESTD_USDT', cg_id: '__test_cg_d',
      }),
    });

    expect(cap.status).toBe(500);
    expect(errMsg(cap)).toBe('__test_底层数据库错误');
    expect(createCoin).toBeDefined();
    expect(realCreateCoin).toBeDefined();
  });
});

describe('PUT /api/coins/:id', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'PUT', url: '/api/coins/1' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/coins/1',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('id 不是数字返回 400', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/coins/abc',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ name: '__test_改名' }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toBe('invalid id');
  });

  it('缺少 id 参数时返回 400（防御性分支）', async () => {
    const cap = await callHandler(router, 'PUT', '/api/coins/1', { params: {} });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toBe('invalid id');
  });

  it('完全没有请求体返回 400', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/coins/1',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('invalid JSON');
  });

  it('请求体校验失败返回 400', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/coins/1',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ symbol: 'lower' }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('symbol');
  });

  it('只更新 name 时其它字段保持不变', async () => {
    const created = realCreateCoin({
      symbol: 'TESTE', name: '__test_原名', gate_pair: 'TESTE_USDT', gate_slug: 'teste',
      binance_pair: 'TESTE_USDT', cg_id: '__test_cg_e', sort_order: 7, enabled: 1,
      alert_above: null, alert_below: null,
    });

    const cap = await callApi(router, {
      method: 'PUT',
      url: `/api/coins/${created.id}`,
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ name: '__test_新名' }),
    });

    expect(cap.status).toBe(200);
    const data = cap.body?.data as any;
    expect(data.name).toBe('__test_新名');
    expect(data.symbol).toBe('TESTE');
    expect(data.gate_pair).toBe('TESTE_USDT');
    expect(data.gate_slug).toBe('teste');
    expect(data.binance_pair).toBe('TESTE_USDT');
    expect(data.cg_id).toBe('__test_cg_e');
    expect(data.sort_order).toBe(7);
    expect(data.enabled).toBe(1);
  });

  it('全字段更新成功并清空阈值提醒冷却', async () => {
    const created = realCreateCoin({
      symbol: 'TESTF', name: '__test_待更新', gate_pair: 'TESTF_USDT', gate_slug: 'testf',
      binance_pair: 'TESTF_USDT', cg_id: '__test_cg_f', sort_order: 8, enabled: 1,
      alert_above: 10, alert_below: 1,
    });
    // 模拟「之前已经发过一次阈值提醒」
    getDb()
      .prepare('UPDATE coins SET last_alert_at = ?, last_alert_dir = ? WHERE id = ?')
      .run(1234567890, 'above', created.id);

    const cap = await callApi(router, {
      method: 'PUT',
      url: `/api/coins/${created.id}`,
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({
        symbol: 'TESTG',
        name: '__test_全字段更新',
        gate_pair: 'TESTG_USDT',
        gate_slug: 'testg',
        binance_pair: 'TESTG_USDT',
        cg_id: '__test_cg_g',
        sort_order: 9,
        enabled: false,
        alert_above: 999,
        alert_below: 0.5,
      }),
    });

    expect(cap.status).toBe(200);
    const data = cap.body?.data as any;
    expect(data.symbol).toBe('TESTG');
    expect(data.name).toBe('__test_全字段更新');
    expect(data.gate_pair).toBe('TESTG_USDT');
    expect(data.gate_slug).toBe('testg');
    expect(data.binance_pair).toBe('TESTG_USDT');
    expect(data.cg_id).toBe('__test_cg_g');
    expect(data.sort_order).toBe(9);
    expect(data.enabled).toBe(0);
    expect(data.alert_above).toBe(999);
    expect(data.alert_below).toBe(0.5);
    // 调整阈值后冷却被清空
    expect(data.last_alert_at).toBe(0);
    expect(data.last_alert_dir).toBeNull();
  });

  it('只更新 alert_below 也会清空冷却', async () => {
    const created = realCreateCoin({
      symbol: 'TESTH', name: '__test_只改下限', gate_pair: 'TESTH_USDT', gate_slug: 'testh',
      binance_pair: null, cg_id: '__test_cg_h', sort_order: 10, enabled: 1,
      alert_above: null, alert_below: null,
    });
    getDb()
      .prepare('UPDATE coins SET last_alert_at = ?, last_alert_dir = ? WHERE id = ?')
      .run(1234567890, 'below', created.id);

    const cap = await callApi(router, {
      method: 'PUT',
      url: `/api/coins/${created.id}`,
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ alert_below: 3 }),
    });

    expect(cap.status).toBe(200);
    const data = cap.body?.data as any;
    expect(data.alert_below).toBe(3);
    expect(data.last_alert_at).toBe(0);
    expect(data.last_alert_dir).toBeNull();
  });

  it('enabled 传 true 时落库为 1', async () => {
    const created = realCreateCoin({
      symbol: 'TESTI', name: '__test_启用', gate_pair: 'TESTI_USDT', gate_slug: 'testi',
      binance_pair: null, cg_id: '__test_cg_i', sort_order: 11, enabled: 0,
      alert_above: null, alert_below: null,
    });

    const cap = await callApi(router, {
      method: 'PUT',
      url: `/api/coins/${created.id}`,
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ enabled: true }),
    });

    expect(cap.status).toBe(200);
    expect((cap.body?.data as any).enabled).toBe(1);
  });

  it('币种不存在返回 404', async () => {
    const cap = await callApi(router, {
      method: 'PUT',
      url: '/api/coins/999999',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ name: '__test_不存在' }),
    });
    expect(cap.status).toBe(404);
    expect(errMsg(cap)).toBe('coin 999999 not found');
  });
});

describe('DELETE /api/coins/:id', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'DELETE', url: '/api/coins/1' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'DELETE',
      url: '/api/coins/1',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('id 不是数字返回 400', async () => {
    const cap = await callApi(router, {
      method: 'DELETE',
      url: '/api/coins/abc',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toBe('invalid id');
  });

  it('缺少 id 参数时返回 400（防御性分支）', async () => {
    const cap = await callHandler(router, 'DELETE', '/api/coins/1', { params: {} });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toBe('invalid id');
  });

  it('币种不存在返回 404', async () => {
    const cap = await callApi(router, {
      method: 'DELETE',
      url: '/api/coins/999999',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(404);
    expect(errMsg(cap)).toBe('coin 999999 not found');
  });

  it('删除成功返回 ok', async () => {
    const created = realCreateCoin({
      symbol: 'TESTJ', name: '__test_待删除', gate_pair: 'TESTJ_USDT', gate_slug: 'testj',
      binance_pair: null, cg_id: '__test_cg_j', sort_order: 12, enabled: 1,
      alert_above: null, alert_below: null,
    });

    const cap = await callApi(router, {
      method: 'DELETE',
      url: `/api/coins/${created.id}`,
      cookie: COOKIE(TOKEN),
    });

    expect(cap.status).toBe(200);
    expect(cap.body?.data).toEqual({ ok: true });
    expect(listCoins().some((c) => c.id === created.id)).toBe(false);
  });
});

describe('POST /api/coins/reorder', () => {
  it('没有 session cookie 返回 401', async () => {
    const cap = await callApi(router, { method: 'POST', url: '/api/coins/reorder' });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('missing session cookie');
  });

  it('handler 自身守卫：没有 ctx.user 时返回 401', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins/reorder',
      useAuthMiddleware: false,
    });
    expect(cap.status).toBe(401);
    expect(errMsg(cap)).toBe('login required');
  });

  it('完全没有请求体返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins/reorder',
      cookie: COOKIE(TOKEN),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('invalid JSON');
  });

  it('ids 为空数组返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins/reorder',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ ids: [] }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('ids');
  });

  it('ids 含非正整数返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins/reorder',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ ids: [0] }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('ids');
  });

  it('ids 含非数字返回 400', async () => {
    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins/reorder',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ ids: ['abc'] }),
    });
    expect(cap.status).toBe(400);
    expect(errMsg(cap)).toContain('ids');
  });

  it('排序成功：返回按新顺序排列的列表', async () => {
    const before = listCoins();
    const reversed = before.slice().reverse().map((c) => c.id);

    const cap = await callApi(router, {
      method: 'POST',
      url: '/api/coins/reorder',
      cookie: COOKIE(TOKEN),
      bodyRaw: JSON.stringify({ ids: reversed }),
    });

    expect(cap.status).toBe(200);
    const data = cap.body?.data as any[];
    expect(data.map((c) => c.id)).toEqual(reversed);
  });
});
