import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import { sendJson, sendOk, sendError, mimeFor } from './response.js';
import { HttpError, NotFoundError } from './errors.js';

interface CapturedRes {
  res: ServerResponse;
  status: () => number;
  headers: () => Record<string, string | number>;
  body: () => string;
}

function makeRes(): CapturedRes {
  const state = {
    status: 0,
    headers: {} as Record<string, string | number>,
    body: '',
  };
  const res = {
    statusCode: 200,
    setHeader: (k: string, v: string | number) => {
      state.headers[k] = v;
    },
    getHeader: (k: string) => state.headers[k],
    writeHead: (status: number, headers?: Record<string, string | number>) => {
      state.status = status;
      if (headers) for (const [k, v] of Object.entries(headers)) state.headers[k] = v;
    },
    end: (chunk?: string) => {
      if (chunk !== undefined) state.body += chunk;
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => state.status,
    headers: () => state.headers,
    body: () => state.body,
  };
}

describe('sendJson', () => {
  it('写入状态码 200 且 ok 为 true', () => {
    const c = makeRes();
    sendJson(c.res, 200, { hello: 'world' });
    expect(c.status()).toBe(200);
    expect(JSON.parse(c.body())).toEqual({ ok: true, data: { hello: 'world' } });
  });

  it('状态码小于 400 时 ok 为 true', () => {
    const c = makeRes();
    sendJson(c.res, 201, { id: 1 });
    expect(JSON.parse(c.body()).ok).toBe(true);
  });

  it('状态码大于等于 400 时 ok 为 false', () => {
    const c = makeRes();
    sendJson(c.res, 400, { bad: true });
    expect(JSON.parse(c.body()).ok).toBe(false);
  });

  it('设置 Content-Type / Content-Length / Cache-Control 响应头', () => {
    const c = makeRes();
    sendJson(c.res, 200, { a: '中文' });
    const h = c.headers();
    expect(h['Content-Type']).toBe('application/json; charset=utf-8');
    expect(h['Cache-Control']).toBe('no-store');
    expect(h['Content-Length']).toBe(Buffer.byteLength(c.body(), 'utf8'));
  });
});

describe('sendOk', () => {
  it('固定使用 200 状态码并返回数据', () => {
    const c = makeRes();
    sendOk(c.res, { ok: 1 });
    expect(c.status()).toBe(200);
    expect(JSON.parse(c.body())).toEqual({ ok: true, data: { ok: 1 } });
  });
});

describe('sendError', () => {
  beforeEach(() => {
    // 屏蔽错误日志噪音，避免污染测试输出
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('HttpError 使用其自带的状态码与错误码', () => {
    const c = makeRes();
    sendError(c.res, new NotFoundError('找不到路由'));
    expect(c.status()).toBe(404);
    expect(JSON.parse(c.body())).toEqual({
      ok: false,
      data: { error: { code: 'not_found', message: '找不到路由' } },
    });
  });

  it('普通 Error 统一转为 500 internal_error', () => {
    const c = makeRes();
    sendError(c.res, new Error('boom'));
    expect(c.status()).toBe(500);
    expect(JSON.parse(c.body())).toEqual({
      ok: false,
      data: { error: { code: 'internal_error', message: 'boom' } },
    });
  });

  it('非 Error 的抛出值转换为字符串消息', () => {
    const c = makeRes();
    sendError(c.res, '字符串错误');
    expect(c.status()).toBe(500);
    expect(JSON.parse(c.body())).toEqual({
      ok: false,
      data: { error: { code: 'internal_error', message: '字符串错误' } },
    });
  });

  it('自定义 HttpError 的状态码被保留', () => {
    const c = makeRes();
    sendError(c.res, new HttpError(429, 'too_many', 'too many requests'));
    expect(c.status()).toBe(429);
    expect(JSON.parse(c.body()).data.error.code).toBe('too_many');
  });
});

describe('mimeFor', () => {
  it('返回已知扩展名对应的 MIME 类型', () => {
    expect(mimeFor('/a/index.html')).toBe('text/html; charset=utf-8');
    expect(mimeFor('/a/app.js')).toBe('application/javascript; charset=utf-8');
    expect(mimeFor('/a/app.mjs')).toBe('application/javascript; charset=utf-8');
    expect(mimeFor('/a/app.css')).toBe('text/css; charset=utf-8');
    expect(mimeFor('/a/data.json')).toBe('application/json; charset=utf-8');
    expect(mimeFor('/a/logo.svg')).toBe('image/svg+xml');
    expect(mimeFor('/a/pic.png')).toBe('image/png');
    expect(mimeFor('/a/pic.jpg')).toBe('image/jpeg');
    expect(mimeFor('/a/pic.jpeg')).toBe('image/jpeg');
    expect(mimeFor('/a/pic.gif')).toBe('image/gif');
    expect(mimeFor('/a/favicon.ico')).toBe('image/x-icon');
    expect(mimeFor('/a/f.woff')).toBe('font/woff');
    expect(mimeFor('/a/f.woff2')).toBe('font/woff2');
    expect(mimeFor('/a/bundle.map')).toBe('application/json');
    expect(mimeFor('/a/readme.txt')).toBe('text/plain; charset=utf-8');
  });

  it('扩展名大小写不敏感', () => {
    expect(mimeFor('/a/INDEX.HTML')).toBe('text/html; charset=utf-8');
    expect(mimeFor('/a/APP.JS')).toBe('application/javascript; charset=utf-8');
  });

  it('未知扩展名返回 application/octet-stream', () => {
    expect(mimeFor('/a/file.xyz')).toBe('application/octet-stream');
  });

  it('没有扩展名时返回 application/octet-stream', () => {
    expect(mimeFor('/a/README')).toBe('application/octet-stream');
    expect(mimeFor('/a/dir.name/')).toBe('application/octet-stream');
  });
});
