import { describe, it, expect } from 'vitest';
import { Router } from './router.js';
import { sendOk } from './response.js';
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