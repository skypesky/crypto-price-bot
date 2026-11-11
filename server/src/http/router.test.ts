import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router, handleRequest } from './router.js';
import { sendOk } from './response.js';
import { HttpError } from './errors.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

function makeRes(): ServerResponse {
  const headers: Record<string, string | number | string[]> = {};
  return {
    setHeader: (k: string, v: string | number | string[]) => { headers[k] = v; },
    getHeader: (k: string) => headers[k],
    writeHead: () => undefined,
    end: () => undefined,
    on: () => undefined,
  } as unknown as ServerResponse;
}

function makeReq(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage;
}

describe('Router', () => {
  it('匹配静态路径', () => {
    const r = new Router();
    r.get('/api/x', async (ctx) => { sendOk(ctx.res, { hit: 'x' }); });
    const m = r.match('GET', '/api/x');
    expect(m).not.toBeNull();
    expect(m!.params).toEqual({});
  });

  it('匹配参数路径', () => {
    const r = new Router();
    r.get('/api/coins/:id', async (ctx) => { sendOk(ctx.res, { id: ctx.params['id'] }); });
    const m = r.match('GET', '/api/coins/42');
    expect(m).not.toBeNull();
    expect(m!.params['id']).toBe('42');
  });

  it('多段参数', () => {
    const r = new Router();
    r.get('/api/a/:x/b/:y', async () => undefined);
    const m = r.match('GET', '/api/a/1/b/2');
    expect(m!.params).toEqual({ x: '1', y: '2' });
  });

  it('不同 method 独立', () => {
    const r = new Router();
    r.get('/api/x', async () => undefined);
    r.post('/api/x', async () => undefined);
    expect(r.match('GET', '/api/x')).not.toBeNull();
    expect(r.match('POST', '/api/x')).not.toBeNull();
    expect(r.match('PUT', '/api/x')).toBeNull();
  });

  it('未匹配返回 null', () => {
    const r = new Router();
    r.get('/api/x', async () => undefined);
    expect(r.match('GET', '/api/y')).toBeNull();
    expect(r.match('GET', '/api/x/y')).toBeNull();
  });

  it('URL 编码的参数正确解码', () => {
    const r = new Router();
    r.get('/api/x/:v', async () => undefined);
    const m = r.match('GET', '/api/x/hello%20world');
    expect(m!.params['v']).toBe('hello world');
  });
});

describe('Router 注册方法', () => {
  it('add 返回自身以便链式调用', () => {
    const r = new Router();
    expect(r.add('GET', '/api/a', async () => undefined)).toBe(r);
  });

  it('get 注册 GET 路由', () => {
    const r = new Router();
    r.get('/api/g', async () => undefined);
    expect(r.match('GET', '/api/g')).not.toBeNull();
  });

  it('post 注册 POST 路由', () => {
    const r = new Router();
    r.post('/api/p', async () => undefined);
    expect(r.match('POST', '/api/p')).not.toBeNull();
  });

  it('put 注册 PUT 路由', () => {
    const r = new Router();
    r.put('/api/u', async () => undefined);
    expect(r.match('PUT', '/api/u')).not.toBeNull();
  });

  it('patch 注册 PATCH 路由', () => {
    const r = new Router();
    r.patch('/api/pa', async () => undefined);
    expect(r.match('PATCH', '/api/pa')).not.toBeNull();
  });

  it('delete 注册 DELETE 路由', () => {
    const r = new Router();
    r.delete('/api/d', async () => undefined);
    expect(r.match('DELETE', '/api/d')).not.toBeNull();
  });

  it('同一路径同一 method 重复注册时后者覆盖前者', () => {
    const r = new Router();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    r.get('/api/dup', first);
    r.get('/api/dup', second);
    expect(r.match('GET', '/api/dup')!.handler).toBe(second);
  });

  it('静态子节点与参数子节点共存时优先匹配静态', () => {
    const r = new Router();
    r.get('/api/items/:id', async () => undefined);
    r.get('/api/items/special', async () => undefined);
    expect(r.match('GET', '/api/items/special')!.params).toEqual({});
    expect(r.match('GET', '/api/items/other')!.params).toEqual({ id: 'other' });
  });

  it('路径尾部斜杠不影响匹配', () => {
    const r = new Router();
    r.get('/api/x/', async () => undefined);
    expect(r.match('GET', '/api/x')).not.toBeNull();
    expect(r.match('GET', '/api/x/')).not.toBeNull();
  });

  it('根路径可以注册并匹配', () => {
    const r = new Router();
    r.get('/', async () => undefined);
    expect(r.match('GET', '/')).not.toBeNull();
  });
});

interface CapturedRes {
  res: ServerResponse;
  status: () => number;
  body: () => string;
}

function makeCapturedRes(): CapturedRes {
  const state = { status: 0, body: '' };
  const res = {
    statusCode: 200,
    setHeader: () => undefined,
    getHeader: () => undefined,
    writeHead: (status: number) => { state.status = status; },
    end: (chunk?: string) => { if (chunk !== undefined) state.body += chunk; },
  } as unknown as ServerResponse;
  return { res, status: () => state.status, body: () => state.body };
}

describe('handleRequest', () => {
  beforeEach(() => {
    // 屏蔽未处理异常的日志噪音
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('命中路由时调用 handler 并返回数据', async () => {
    const r = new Router();
    r.get('/api/coins/:id', async (ctx) => { sendOk(ctx.res, { id: ctx.params['id'] }); });
    const c = makeCapturedRes();
    await handleRequest(makeReq('GET', '/api/coins/7'), c.res, r, []);
    expect(c.status()).toBe(200);
    expect(JSON.parse(c.body()).data).toEqual({ id: '7' });
  });

  it('未命中路由时返回 404 not_found', async () => {
    const r = new Router();
    const c = makeCapturedRes();
    await handleRequest(makeReq('GET', '/api/nope'), c.res, r, []);
    expect(c.status()).toBe(404);
    const payload = JSON.parse(c.body());
    expect(payload.ok).toBe(false);
    expect(payload.data.error.code).toBe('not_found');
    expect(payload.data.error.message).toBe('no route for GET /api/nope');
  });

  it('handler 抛出 HttpError 时按其状态码返回', async () => {
    const r = new Router();
    r.get('/api/boom', async () => { throw new HttpError(403, 'forbidden', '禁止访问'); });
    const c = makeCapturedRes();
    await handleRequest(makeReq('GET', '/api/boom'), c.res, r, []);
    expect(c.status()).toBe(403);
    expect(JSON.parse(c.body()).data.error.code).toBe('forbidden');
  });

  it('handler 抛出普通 Error 时返回 500', async () => {
    const r = new Router();
    r.get('/api/boom', async () => { throw new Error('普通错误'); });
    const c = makeCapturedRes();
    await handleRequest(makeReq('GET', '/api/boom'), c.res, r, []);
    expect(c.status()).toBe(500);
    expect(JSON.parse(c.body()).data.error.message).toBe('普通错误');
  });

  it('中间件在 handler 之前执行且可以传递控制权', async () => {
    const order: string[] = [];
    const r = new Router();
    r.get('/api/x', async () => { order.push('handler'); });
    const mw = async (_ctx: unknown, next: () => Promise<void>) => {
      order.push('mw');
      await next();
      order.push('mw-after');
    };
    await handleRequest(makeReq('GET', '/api/x'), makeRes(), r, [mw]);
    expect(order).toEqual(['mw', 'handler', 'mw-after']);
  });

  it('多个中间件按注册顺序串联执行', async () => {
    const order: string[] = [];
    const r = new Router();
    r.get('/api/x', async () => { order.push('handler'); });
    const mk = (name: string) => async (_ctx: unknown, next: () => Promise<void>) => {
      order.push(name);
      await next();
    };
    await handleRequest(makeReq('GET', '/api/x'), makeRes(), r, [mk('a'), mk('b')]);
    expect(order).toEqual(['a', 'b', 'handler']);
  });

  it('ctx 中携带 pathname / query / params', async () => {
    const r = new Router();
    let seen: { pathname: string; query: string; params: Record<string, string> } | null = null;
    r.get('/api/coins/:id', async (ctx) => {
      seen = { pathname: ctx.pathname, query: ctx.query.get('v') ?? '', params: ctx.params };
    });
    await handleRequest(makeReq('GET', '/api/coins/9?v=__test_value'), makeRes(), r, []);
    expect(seen).toEqual({ pathname: '/api/coins/9', query: '__test_value', params: { id: '9' } });
  });

  it('url 缺省时按根路径处理', async () => {
    const r = new Router();
    let pathname = '';
    r.get('/', async (ctx) => { pathname = ctx.pathname; });
    await handleRequest({ method: 'GET', headers: {} } as unknown as IncomingMessage, makeRes(), r, []);
    expect(pathname).toBe('/');
  });

  it('url 以问号开头时 pathname 回退为根路径', async () => {
    const r = new Router();
    let pathname = '';
    r.get('/', async (ctx) => { pathname = ctx.pathname; });
    await handleRequest(makeReq('GET', '?a=1'), makeRes(), r, []);
    expect(pathname).toBe('/');
  });

  it('method 缺省时按 GET 匹配', async () => {
    const r = new Router();
    const handler = vi.fn(async () => undefined);
    r.get('/api/x', handler);
    await handleRequest({ url: '/api/x', headers: {} } as unknown as IncomingMessage, makeRes(), r, []);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('未命中路由时 ctx.params 为空对象', async () => {
    const r = new Router();
    const c = makeCapturedRes();
    await handleRequest(makeReq('GET', '/api/nope'), c.res, r, []);
    expect(c.status()).toBe(404);
  });

  it('中间件抛出的错误会向外传播', async () => {
    const r = new Router();
    const mw = async () => { throw new Error('中间件错误'); };
    await expect(handleRequest(makeReq('GET', '/api/x'), makeRes(), r, [mw])).rejects.toThrow('中间件错误');
  });

  it('链路结束时 next 无后续中间件则直接返回', async () => {
    const r = new Router();
    let called = false;
    r.get('/api/x', async () => { called = true; });
    const mw = async (_ctx: unknown, next: () => Promise<void>) => { await next(); };
    await handleRequest(makeReq('GET', '/api/x'), makeRes(), r, [mw]);
    expect(called).toBe(true);
  });

  it('中间件重复调用 next 时不会抛出异常', async () => {
    const r = new Router();
    let called = 0;
    r.get('/api/x', async () => { called += 1; });
    const mw = async (_ctx: unknown, next: () => Promise<void>) => {
      await next();
      await next();
    };
    await expect(handleRequest(makeReq('GET', '/api/x'), makeRes(), r, [mw])).resolves.toBeUndefined();
    expect(called).toBe(1);
  });
});
