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

  it('4xx 不重试：直接抛错且保留 status', async () => {
    requestCount = 0;
    // 未注册的路径 → 404。404 是客户端错误，重试没有意义 → 只请求一次。
    await expect(httpGet(`${baseUrl}/not-exist`, { retries: 3 })).rejects.toThrow(/HTTP 404/);
    expect(requestCount).toBe(1);
  });

  it('4xx 抛出的 HttpError 带 status（调用方据此区分"没有这个数据"）', async () => {
    requestCount = 0;
    try {
      await httpGet(`${baseUrl}/not-exist`, { retries: 0 });
      expect.unreachable('应该抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(404);
    }
  });
});

describe('httpPost', () => {
  it('POST JSON', async () => {
    const res = await httpPost(`${baseUrl}/ok`, { a: 1 }, { retries: 0 });
    expect(res.status).toBe(200);
  });
});

describe('DoH + HTTPS SNI', () => {
  // 用真实网络打 api.gateio.ws，触发 DoH 解析并验证 servername（SNI）正确
  it('DoH 解析为 IP 后 HTTPS 仍能通过（servername 兜底）', async () => {
    disposeHttp(); // 清除缓存，避免上轮把 hostname 缓存为 IP
    const res = await httpGet('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT', {
      retries: 0,
      timeoutMs: 10_000,
      doh: { endpoint: 'https://1.1.1.1/dns-query' },
    });
    expect(res.status).toBe(200);
  }, 15_000);
});

describe('HttpError', () => {
  it('带 status', () => {
    const e = new HttpError('test', 404);
    expect(e.status).toBe(404);
    expect(e.name).toBe('HttpError');
  });
});