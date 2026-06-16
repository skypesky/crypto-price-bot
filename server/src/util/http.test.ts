import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { httpGet, httpPost, HttpError, disposeHttp } from './http.js';

let server: Server;
let baseUrl: string;
let requestCount = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    requestCount++;
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world' }));
    } else if (req.url === '/fail') {
      res.writeHead(500);
      res.end('boom');
    } else if (req.url === '/flaky') {
      // 第一次 500，第二次 200
      if (requestCount <= 1) {
        res.writeHead(500);
        res.end('flaky');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ recovered: true }));
      }
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  disposeHttp();
});

describe('httpGet', () => {
  it('200 返回 JSON 解析', async () => {
    const res = await httpGet(`${baseUrl}/ok`, { retries: 0 });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ hello: 'world' });
  });

  it('5xx 不重试直接报错', async () => {
    await expect(httpGet(`${baseUrl}/fail`, { retries: 0 })).rejects.toThrow(/HTTP 500/);
  });

  it('重试成功', async () => {
    requestCount = 0; // 重置计数，让 /flaky 第一次 500
    const res = await httpGet(`${baseUrl}/flaky`, { retries: 1 });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ recovered: true });
  });

  it('自定义 headers 透传', async () => {
    const res = await httpGet(`${baseUrl}/ok`, { retries: 0, headers: { 'X-Test': 'yes' } });
    expect(res.status).toBe(200);
  });
});

describe('httpPost', () => {
  it('POST JSON', async () => {
    const res = await httpPost(`${baseUrl}/ok`, { a: 1 }, { retries: 0 });
    expect(res.status).toBe(200);
  });
});

describe('HttpError', () => {
  it('带 status', () => {
    const e = new HttpError('test', 404);
    expect(e.status).toBe(404);
    expect(e.name).toBe('HttpError');
  });
});