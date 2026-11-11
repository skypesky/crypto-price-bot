import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

// 用假的 http 模块替换真实实现，避免监听真实端口
const h = vi.hoisted(() => {
  const state = {
    handler: null as null | ((req: unknown, res: unknown) => void),
    listenArgs: [] as unknown[],
    closed: false,
  };
  const createServer = vi.fn((handler: (req: unknown, res: unknown) => void) => {
    state.handler = handler;
    return {
      listen: (...args: unknown[]) => {
        state.listenArgs = args;
        const cb = args[args.length - 1] as () => void;
        cb();
      },
      close: (cb: () => void) => {
        state.closed = true;
        cb();
      },
    };
  });
  return { state, createServer };
});

vi.mock('node:http', () => ({ createServer: h.createServer }));

import { buildApp, listen } from './server.js';
import { Router } from './router.js';
import { sendOk } from './response.js';

interface CapturedRes {
  res: ServerResponse;
  status: () => number;
  body: () => string;
}

function makeRes(): CapturedRes {
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

function makeReq(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage;
}

/** 等待 handleRequest 的异步 catch 分支执行完毕 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  h.state.handler = null;
  h.state.listenArgs = [];
  h.state.closed = false;
  h.createServer.mockClear();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildApp', () => {
  it('未指定 staticDir 时只注册三个内置中间件', () => {
    const app = buildApp({ resolveSession: async () => null });
    expect(app.middlewares).toHaveLength(3);
    expect(app.router).toBeInstanceOf(Router);
  });

  it('指定存在的 staticDir 时追加静态文件中间件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpb-http-app-'));
    try {
      const app = buildApp({ resolveSession: async () => null, staticDir: dir });
      expect(app.middlewares).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('staticDir 不存在时不追加静态文件中间件', () => {
    const app = buildApp({ resolveSession: async () => null, staticDir: '/__test_not_exist_dir__' });
    expect(app.middlewares).toHaveLength(3);
  });
});

describe('listen', () => {
  it('默认监听 0.0.0.0 且端口来自配置', async () => {
    const app = buildApp({ resolveSession: async () => null });
    const result = await listen(app, { port: 8787, resolveSession: async () => null });
    expect(h.createServer).toHaveBeenCalledTimes(1);
    expect(h.state.listenArgs[0]).toBe(8787);
    expect(h.state.listenArgs[1]).toBe('0.0.0.0');
    expect(result.server).toBeTruthy();
  });

  it('指定 host 时透传给底层 server', async () => {
    const app = buildApp({ resolveSession: async () => null });
    await listen(app, { port: 8788, host: '127.0.0.1', resolveSession: async () => null });
    expect(h.state.listenArgs[0]).toBe(8788);
    expect(h.state.listenArgs[1]).toBe('127.0.0.1');
  });

  it('close 会关闭底层 server', async () => {
    const app = buildApp({ resolveSession: async () => null });
    const result = await listen(app, { port: 8789, resolveSession: async () => null });
    await result.close();
    expect(h.state.closed).toBe(true);
  });
});

describe('服务器请求处理', () => {
  it('命中路由时返回处理结果', async () => {
    const app = buildApp({ resolveSession: async () => null });
    app.router.get('/api/ping', async (ctx) => { sendOk(ctx.res, { pong: true }); });
    await listen(app, { port: 8790, resolveSession: async () => null });

    const c = makeRes();
    h.state.handler!(makeReq('GET', '/api/ping'), c.res);
    await flush();
    expect(c.status()).toBe(200);
    expect(JSON.parse(c.body()).data).toEqual({ pong: true });
  });

  it('未命中路由时返回 404', async () => {
    const app = buildApp({ resolveSession: async () => null });
    await listen(app, { port: 8791, resolveSession: async () => null });

    const c = makeRes();
    h.state.handler!(makeReq('GET', '/api/missing'), c.res);
    await flush();
    expect(c.status()).toBe(404);
  });

  it('handleRequest 抛错时兜底返回 500 internal error', async () => {
    const app = {
      router: new Router(),
      middlewares: [async () => { throw new Error('__test_boom'); }],
    };
    await listen(app as never, { port: 8792, resolveSession: async () => null });

    const c = makeRes();
    h.state.handler!(makeReq('GET', '/api/x'), c.res);
    await flush();
    expect(c.status()).toBe(500);
    expect(c.body()).toBe('internal error');
  });

  it('兜底写入响应时抛异常也不会向外抛出', async () => {
    const app = {
      router: new Router(),
      middlewares: [async () => { throw new Error('__test_boom'); }],
    };
    await listen(app as never, { port: 8793, resolveSession: async () => null });

    let ended = false;
    const res = {
      statusCode: 200,
      setHeader: () => undefined,
      getHeader: () => undefined,
      writeHead: () => { throw new Error('__test_write_head_failed'); },
      end: () => { ended = true; },
    } as unknown as ServerResponse;

    expect(() => h.state.handler!(makeReq('GET', '/api/x'), res)).not.toThrow();
    await flush();
    expect(ended).toBe(false);
  });
});
