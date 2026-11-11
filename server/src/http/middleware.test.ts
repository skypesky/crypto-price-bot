import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Writable, Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './router.js';
import {
  loggerMiddleware,
  errorMiddleware,
  jsonBodyMiddleware,
  authMiddleware,
  staticMiddleware,
  getCookie,
  setCookie,
  clearCookie,
} from './middleware.js';
import { UnauthorizedError } from './errors.js';

/** 可写的伪 ServerResponse，既能记录响应头也能接收文件流 */
class FakeRes extends Writable {
  statusCode = 200;
  headers: Record<string, string | number | string[]> = {};
  body = '';

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.body += chunk.toString();
    cb();
  }

  setHeader(k: string, v: string | number | string[]): this {
    this.headers[k] = v;
    return this;
  }

  getHeader(k: string): string | number | string[] | undefined {
    return this.headers[k];
  }

  writeHead(status: number, headers?: Record<string, string | number>): this {
    this.statusCode = status;
    if (headers) for (const [k, v] of Object.entries(headers)) this.headers[k] = v;
    return this;
  }
}

/** 既是可读流又带有 HTTP 请求元信息的伪 IncomingMessage */
function mockReq(
  method: string | undefined,
  headers: Record<string, string> = {},
  body = '',
): IncomingMessage {
  const stream = Readable.from([Buffer.from(body, 'utf8')]);
  return Object.assign(stream, { method, headers, url: '/' }) as unknown as IncomingMessage;
}

function makeCtx(
  req: IncomingMessage,
  res: ServerResponse | FakeRes,
  pathname = '/',
): RouteContext {
  return {
    req,
    res: res as unknown as ServerResponse,
    pathname,
    query: new URLSearchParams(),
    params: {},
  };
}

async function waitFinished(res: FakeRes): Promise<void> {
  if (res.writableFinished) return;
  await new Promise<void>((resolve) => res.on('finish', () => resolve()));
}

// ---------------------------------------------------------------- 静态资源目录
let staticRoot: string;
let emptyRoot: string;

beforeAll(() => {
  staticRoot = mkdtempSync(join(tmpdir(), 'cpb-http-static-'));
  writeFileSync(join(staticRoot, 'index.html'), '<html>__test_index</html>');
  writeFileSync(join(staticRoot, 'app.js'), 'console.log("__test_js")');
  writeFileSync(join(staticRoot, 'style.css'), 'body{color:red}');
  mkdirSync(join(staticRoot, 'sub'));

  emptyRoot = mkdtempSync(join(tmpdir(), 'cpb-http-empty-'));
});

afterAll(() => {
  rmSync(staticRoot, { recursive: true, force: true });
  rmSync(emptyRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // 屏蔽日志噪音，避免污染测试输出
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- 日志中间件
describe('loggerMiddleware', () => {
  it('调用 next 并在结束时输出请求日志', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const ctx = makeCtx(mockReq('GET'), new FakeRes(), '/api/x');
    const next = vi.fn(async () => undefined);
    await loggerMiddleware(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(out.mock.calls[0]![0]).toContain('GET /api/x');
  });

  it('next 抛出异常时仍然输出日志并向上抛出', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const ctx = makeCtx(mockReq('GET'), new FakeRes(), '/api/x');
    await expect(
      loggerMiddleware(ctx, async () => { throw new Error('__test_boom'); }),
    ).rejects.toThrow('__test_boom');
  });
});

// ---------------------------------------------------------------- 错误兜底中间件
describe('errorMiddleware', () => {
  it('next 正常完成时不产生错误响应', async () => {
    const res = new FakeRes();
    const ctx = makeCtx(mockReq('GET'), res);
    await errorMiddleware(ctx, async () => undefined);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('next 抛出 HttpError 时按其状态码返回错误响应', async () => {
    const res = new FakeRes();
    const ctx = makeCtx(mockReq('GET'), res);
    await errorMiddleware(ctx, async () => { throw new UnauthorizedError('缺少会话'); });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).data.error.code).toBe('unauthorized');
  });

  it('next 抛出普通 Error 时返回 500', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const res = new FakeRes();
    const ctx = makeCtx(mockReq('GET'), res);
    await errorMiddleware(ctx, async () => { throw new Error('__test_boom'); });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).data.error.message).toBe('__test_boom');
  });
});

// ---------------------------------------------------------------- JSON body 中间件
describe('jsonBodyMiddleware', () => {
  it('POST + application/json 时解析 body 并挂到 ctx', async () => {
    const req = mockReq('POST', { 'content-type': 'application/json' }, '{"name":"__test_value"}');
    const ctx = makeCtx(req, new FakeRes());
    const next = vi.fn(async () => undefined);
    await jsonBodyMiddleware(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.bodyRaw).toBe('{"name":"__test_value"}');
    expect(ctx.body).toEqual({ name: '__test_value' });
  });

  it('PUT + application/json 时同样解析 body', async () => {
    const req = mockReq('PUT', { 'content-type': 'application/json' }, '{"id":1}');
    const ctx = makeCtx(req, new FakeRes());
    await jsonBodyMiddleware(ctx, async () => undefined);
    expect(ctx.body).toEqual({ id: 1 });
  });

  it('PATCH + application/json 时同样解析 body', async () => {
    const req = mockReq('PATCH', { 'content-type': 'application/json' }, '{"id":1}');
    const ctx = makeCtx(req, new FakeRes());
    await jsonBodyMiddleware(ctx, async () => undefined);
    expect(ctx.body).toEqual({ id: 1 });
  });

  it('DELETE + application/json 时同样解析 body', async () => {
    const req = mockReq('DELETE', { 'content-type': 'application/json' }, '{"id":1}');
    const ctx = makeCtx(req, new FakeRes());
    await jsonBodyMiddleware(ctx, async () => undefined);
    expect(ctx.body).toEqual({ id: 1 });
  });

  it('content-type 带有 charset 时依然解析 body', async () => {
    const req = mockReq('POST', { 'content-type': 'application/json; charset=utf-8' }, '{"a":1}');
    const ctx = makeCtx(req, new FakeRes());
    await jsonBodyMiddleware(ctx, async () => undefined);
    expect(ctx.body).toEqual({ a: 1 });
  });

  it('非法 JSON 时 body 置为 null 且继续调用 next', async () => {
    const req = mockReq('POST', { 'content-type': 'application/json' }, '{不是 json');
    const ctx = makeCtx(req, new FakeRes());
    const next = vi.fn(async () => undefined);
    await jsonBodyMiddleware(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.bodyRaw).toBe('{不是 json');
    expect(ctx.body).toBeNull();
  });

  it('空 body 时只写入 bodyRaw 不设置 body', async () => {
    const req = mockReq('POST', { 'content-type': 'application/json' }, '');
    const ctx = makeCtx(req, new FakeRes());
    await jsonBodyMiddleware(ctx, async () => undefined);
    expect(ctx.bodyRaw).toBe('');
    expect(ctx.body).toBeUndefined();
  });

  it('content-type 不是 json 时不解析 body', async () => {
    const req = mockReq('POST', { 'content-type': 'text/plain' }, '{"a":1}');
    const ctx = makeCtx(req, new FakeRes());
    const next = vi.fn(async () => undefined);
    await jsonBodyMiddleware(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.bodyRaw).toBeUndefined();
    expect(ctx.body).toBeUndefined();
  });

  it('缺少 content-type 头时不解析 body', async () => {
    const req = mockReq('POST', {}, '{"a":1}');
    const ctx = makeCtx(req, new FakeRes());
    await jsonBodyMiddleware(ctx, async () => undefined);
    expect(ctx.bodyRaw).toBeUndefined();
  });

  it('GET 请求不解析 body', async () => {
    const req = mockReq('GET', { 'content-type': 'application/json' }, '{"a":1}');
    const ctx = makeCtx(req, new FakeRes());
    const next = vi.fn(async () => undefined);
    await jsonBodyMiddleware(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.bodyRaw).toBeUndefined();
  });

  it('method 缺省时按 GET 处理不解析 body', async () => {
    const req = mockReq(undefined, { 'content-type': 'application/json' }, '{"a":1}');
    const ctx = makeCtx(req, new FakeRes());
    await jsonBodyMiddleware(ctx, async () => undefined);
    expect(ctx.bodyRaw).toBeUndefined();
  });

  it('body 超限时返回 500 错误且不再调用 next', async () => {
    const res = new FakeRes();
    const req = mockReq('POST', { 'content-type': 'application/json' }, 'x'.repeat(1024 * 1024 + 1));
    const ctx = makeCtx(req, res);
    const next = vi.fn(async () => undefined);
    await jsonBodyMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).data.error.message).toContain('request body exceeds');
  });
});

// ---------------------------------------------------------------- 鉴权中间件
describe('authMiddleware', () => {
  it('公开路径 /api/status 直接放行且不解析会话', async () => {
    const resolveSession = vi.fn(async () => null);
    const ctx = makeCtx(mockReq('GET'), new FakeRes(), '/api/status');
    const next = vi.fn(async () => undefined);
    await authMiddleware(resolveSession)(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('公开路径 /api/auth/login 直接放行', async () => {
    const resolveSession = vi.fn(async () => null);
    const ctx = makeCtx(mockReq('POST'), new FakeRes(), '/api/auth/login');
    const next = vi.fn(async () => undefined);
    await authMiddleware(resolveSession)(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('缺少 session cookie 时抛出未授权错误', async () => {
    const resolveSession = vi.fn(async () => null);
    const ctx = makeCtx(mockReq('GET', {}), new FakeRes(), '/api/private');
    await expect(authMiddleware(resolveSession)(ctx, async () => undefined)).rejects.toThrow(
      'missing session cookie',
    );
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('会话无效时抛出未授权错误', async () => {
    const resolveSession = vi.fn(async () => null);
    const req = mockReq('GET', { cookie: 'cpb_session=__test_invalid_token' });
    const ctx = makeCtx(req, new FakeRes(), '/api/private');
    await expect(authMiddleware(resolveSession)(ctx, async () => undefined)).rejects.toThrow(
      'invalid or expired session',
    );
    expect(resolveSession).toHaveBeenCalledWith('__test_invalid_token');
  });

  it('会话有效时把用户挂到 ctx 并继续执行', async () => {
    const resolveSession = vi.fn(async () => ({ id: 1, username: '__test_user' }));
    const req = mockReq('GET', { cookie: 'cpb_session=__test_valid_token' });
    const ctx = makeCtx(req, new FakeRes(), '/api/private');
    const next = vi.fn(async () => undefined);
    await authMiddleware(resolveSession)(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.user).toEqual({ id: 1, username: '__test_user' });
    expect(resolveSession).toHaveBeenCalledWith('__test_valid_token');
  });
});

// ---------------------------------------------------------------- 静态文件中间件
describe('staticMiddleware', () => {
  it('非 GET/HEAD 请求交给后续处理', async () => {
    const ctx = makeCtx(mockReq('POST'), new FakeRes(), '/app.js');
    const next = vi.fn(async () => undefined);
    await staticMiddleware(staticRoot)(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('/api/ 前缀的路径交给路由层', async () => {
    const ctx = makeCtx(mockReq('GET'), new FakeRes(), '/api/coins');
    const next = vi.fn(async () => undefined);
    await staticMiddleware(staticRoot)(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('/api 路径本身交给路由层', async () => {
    const ctx = makeCtx(mockReq('GET'), new FakeRes(), '/api');
    const next = vi.fn(async () => undefined);
    await staticMiddleware(staticRoot)(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('路径穿越的请求被拒绝并交给后续处理', async () => {
    const ctx = makeCtx(mockReq('GET'), new FakeRes(), '/../__test_secret.txt');
    const next = vi.fn(async () => undefined);
    await staticMiddleware(staticRoot)(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('存在的静态文件被直接返回且不调用 next', async () => {
    const res = new FakeRes();
    const ctx = makeCtx(mockReq('GET'), res, '/app.js');
    const next = vi.fn(async () => undefined);
    await staticMiddleware(staticRoot)(ctx, next);
    await waitFinished(res);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/javascript; charset=utf-8');
    expect(res.headers['Cache-Control']).toBe('public, max-age=3600');
    expect(res.body).toContain('__test_js');
  });

  it('html 类型的静态文件使用 no-cache 缓存策略', async () => {
    const res = new FakeRes();
    const ctx = makeCtx(mockReq('GET'), res, '/index.html');
    await staticMiddleware(staticRoot)(ctx, async () => undefined);
    await waitFinished(res);
    expect(res.headers['Cache-Control']).toBe('no-cache');
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
  });

  it('HEAD 请求只返回响应头不返回内容', async () => {
    const res = new FakeRes();
    const ctx = makeCtx(mockReq('HEAD'), res, '/app.js');
    const next = vi.fn(async () => undefined);
    await staticMiddleware(staticRoot)(ctx, next);
    // HEAD 场景下文件流被销毁，响应不会结束，这里只断言没有写入任何内容
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('根路径在 SPA 模式下返回 index.html', async () => {
    const res = new FakeRes();
    const ctx = makeCtx(mockReq('GET'), res, '/');
    await staticMiddleware(staticRoot)(ctx, async () => undefined);
    await waitFinished(res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('__test_index');
  });

  it('根路径在非 SPA 模式下交给后续处理', async () => {
    const ctx = makeCtx(mockReq('GET'), new FakeRes(), '/');
    const next = vi.fn(async () => undefined);
    await staticMiddleware(staticRoot, false)(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('目录路径不是文件时交给后续处理', async () => {
    const ctx = makeCtx(mockReq('GET'), new FakeRes(), '/sub');
    const next = vi.fn(async () => undefined);
    await staticMiddleware(staticRoot, false)(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('文件不存在时 SPA 兜底返回 index.html', async () => {
    const res = new FakeRes();
    const ctx = makeCtx(mockReq('GET'), res, '/not-exist.html');
    const next = vi.fn(async () => undefined);
    await staticMiddleware(staticRoot)(ctx, next);
    await waitFinished(res);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('__test_index');
  });

  it('文件不存在且非 SPA 模式时交给后续处理', async () => {
    const ctx = makeCtx(mockReq('GET'), new FakeRes(), '/not-exist.html');
    const next = vi.fn(async () => undefined);
    await staticMiddleware(staticRoot, false)(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('SPA 模式下缺少 index.html 时交给后续处理', async () => {
    const ctx = makeCtx(mockReq('GET'), new FakeRes(), '/not-exist.html');
    const next = vi.fn(async () => undefined);
    await staticMiddleware(emptyRoot)(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- Cookie 工具
describe('getCookie', () => {
  it('返回指定名称的 cookie 值', () => {
    const req = mockReq('GET', { cookie: 'a=1; cpb_session=__test_token' });
    const ctx = makeCtx(req, new FakeRes());
    expect(getCookie(ctx, 'cpb_session')).toBe('__test_token');
  });

  it('cookie 不存在时返回 undefined', () => {
    const req = mockReq('GET', { cookie: 'a=1' });
    const ctx = makeCtx(req, new FakeRes());
    expect(getCookie(ctx, 'cpb_session')).toBeUndefined();
  });
});

describe('setCookie', () => {
  it('默认写入 Path=/ HttpOnly SameSite=Lax', () => {
    const res = new FakeRes();
    setCookie(res as unknown as ServerResponse, '__test_name', '__test_value');
    expect(res.getHeader('Set-Cookie')).toBe(
      '__test_name=__test_value; Path=/; HttpOnly; SameSite=Lax',
    );
  });

  it('写入 Max-Age 属性', () => {
    const res = new FakeRes();
    setCookie(res as unknown as ServerResponse, '__test_name', '__test_value', { maxAge: 3600 });
    expect(res.getHeader('Set-Cookie')).toBe(
      '__test_name=__test_value; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax',
    );
  });

  it('写入自定义 Path 属性', () => {
    const res = new FakeRes();
    setCookie(res as unknown as ServerResponse, '__test_name', '__test_value', { path: '/app' });
    expect(res.getHeader('Set-Cookie')).toBe(
      '__test_name=__test_value; Path=/app; HttpOnly; SameSite=Lax',
    );
  });

  it('httpOnly 为 false 时不写入 HttpOnly 属性', () => {
    const res = new FakeRes();
    setCookie(res as unknown as ServerResponse, '__test_name', '__test_value', { httpOnly: false });
    expect(res.getHeader('Set-Cookie')).toBe(
      '__test_name=__test_value; Path=/; SameSite=Lax',
    );
  });

  it('secure 为 true 时写入 Secure 属性', () => {
    const res = new FakeRes();
    setCookie(res as unknown as ServerResponse, '__test_name', '__test_value', { secure: true });
    expect(res.getHeader('Set-Cookie')).toBe(
      '__test_name=__test_value; Path=/; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('可以指定 SameSite 为 Strict', () => {
    const res = new FakeRes();
    setCookie(res as unknown as ServerResponse, '__test_name', '__test_value', { sameSite: 'Strict' });
    expect(res.getHeader('Set-Cookie')).toBe(
      '__test_name=__test_value; Path=/; HttpOnly; SameSite=Strict',
    );
  });

  it('可以组合所有可选属性', () => {
    const res = new FakeRes();
    setCookie(res as unknown as ServerResponse, '__test_name', '__test_value', {
      maxAge: 60,
      path: '/app',
      httpOnly: false,
      secure: true,
      sameSite: 'None',
    });
    expect(res.getHeader('Set-Cookie')).toBe(
      '__test_name=__test_value; Max-Age=60; Path=/app; Secure; SameSite=None',
    );
  });

  it('cookie 值会被 URL 编码', () => {
    const res = new FakeRes();
    setCookie(res as unknown as ServerResponse, '__test_name', 'a b');
    expect(res.getHeader('Set-Cookie')).toBe(
      '__test_name=a%20b; Path=/; HttpOnly; SameSite=Lax',
    );
  });

  it('已存在单个 Set-Cookie 头时追加为数组', () => {
    const res = new FakeRes();
    res.setHeader('Set-Cookie', '__test_a=1');
    setCookie(res as unknown as ServerResponse, '__test_name', '__test_value');
    expect(res.getHeader('Set-Cookie')).toEqual([
      '__test_a=1',
      '__test_name=__test_value; Path=/; HttpOnly; SameSite=Lax',
    ]);
  });

  it('已存在 Set-Cookie 数组时继续追加', () => {
    const res = new FakeRes();
    res.setHeader('Set-Cookie', ['__test_a=1', '__test_b=2']);
    setCookie(res as unknown as ServerResponse, '__test_name', '__test_value');
    expect(res.getHeader('Set-Cookie')).toEqual([
      '__test_a=1',
      '__test_b=2',
      '__test_name=__test_value; Path=/; HttpOnly; SameSite=Lax',
    ]);
  });
});

describe('clearCookie', () => {
  it('写入空的 cookie 值并设置 Max-Age=0', () => {
    const res = new FakeRes();
    clearCookie(res as unknown as ServerResponse, '__test_name');
    expect(res.getHeader('Set-Cookie')).toBe(
      '__test_name=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
    );
  });
});
