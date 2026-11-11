import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 本文件完全 mock 掉 undici 的 fetch —— 测试期间不产生任何真实网络请求。
 * undici 的 Agent / setGlobalDispatcher 也一并 mock，避免真实连接池泄漏。
 */
const { mockFetch, mockSetGlobalDispatcher, agentRegistry } = vi.hoisted(() => {
  const mockFetch = vi.fn();
  const mockSetGlobalDispatcher = vi.fn();
  const agentRegistry: Array<{ opts: unknown; closed: boolean }> = [];
  return { mockFetch, mockSetGlobalDispatcher, agentRegistry };
});

vi.mock('undici', () => {
  class Agent {
    public opts: unknown;
    public closed = false;
    constructor(opts: unknown) {
      this.opts = opts;
      agentRegistry.push(this);
    }
    close(): void {
      this.closed = true;
    }
  }
  return {
    Agent,
    setGlobalDispatcher: mockSetGlobalDispatcher,
    fetch: mockFetch,
  };
});

import { httpGet, httpPost, HttpError, disposeHttp, setupDefaultAgent } from './http.js';

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

/** 构造一个最小可用的 fetch Response 替身 */
function makeRes(opts: { status?: number; contentType?: string | null; body?: string } = {}): FakeResponse {
  const status = opts.status ?? 200;
  const body = opts.body ?? '';
  const headers = new Headers();
  if (opts.contentType !== null) headers.set('content-type', opts.contentType ?? 'application/json');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** 构造 DoH（dns-query）响应 */
function makeDohRes(answers?: Array<{ type: number; data: string }>, status = 200): FakeResponse {
  return makeRes({
    status,
    body: JSON.stringify(answers ? { Answer: answers } : {}),
  });
}

/** 取第 n 次 fetch 调用的 (url, init) */
function callAt(n: number): [string, { method?: string; headers?: Record<string, string>; body?: string; dispatcher?: { opts: unknown } }] {
  return mockFetch.mock.calls[n] as never;
}

beforeEach(() => {
  // disposeHttp 会复位模块级缓存（DoH 缓存 / Agent 池）
  disposeHttp();
  mockFetch.mockReset();
  mockSetGlobalDispatcher.mockReset();
  agentRegistry.length = 0;
});

describe('httpGet', () => {
  it('200 + JSON content-type → 解析为对象', async () => {
    mockFetch.mockResolvedValue(makeRes({ body: JSON.stringify({ hello: 'world' }) }));
    const res = await httpGet('https://api.example.com/ok', { retries: 0 });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ hello: 'world' });
  });

  it('非 JSON content-type → data 保持为原始文本', async () => {
    mockFetch.mockResolvedValue(makeRes({ contentType: 'text/plain', body: 'plain body' }));
    const res = await httpGet('https://api.example.com/text', { retries: 0 });
    expect(res.data).toBe('plain body');
  });

  it('响应没有 content-type → data 保持为原始文本', async () => {
    mockFetch.mockResolvedValue(makeRes({ contentType: null, body: 'no content type' }));
    const res = await httpGet('https://api.example.com/nct', { retries: 0 });
    expect(res.data).toBe('no content type');
  });

  it('JSON content-type 但内容非法 → 降级保留原始文本', async () => {
    mockFetch.mockResolvedValue(makeRes({ contentType: 'application/json', body: 'not-json' }));
    const res = await httpGet('https://api.example.com/bad-json', { retries: 0 });
    expect(res.data).toBe('not-json');
  });

  it('4xx 不重试：直接抛 HttpError 且保留 status', async () => {
    mockFetch.mockResolvedValue(makeRes({ status: 404, contentType: 'text/plain', body: 'nope' }));
    await expect(httpGet('https://api.example.com/404', { retries: 3 })).rejects.toThrow(/HTTP 404/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('4xx 抛出的 HttpError 带 status（调用方据此区分「没有这个数据」）', async () => {
    mockFetch.mockResolvedValue(makeRes({ status: 404, contentType: 'text/plain', body: 'nope' }));
    try {
      await httpGet('https://api.example.com/404', { retries: 0 });
      expect.unreachable('应该抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(404);
    }
  });

  it('408 视为可重试 → 共请求 2 次', async () => {
    mockFetch.mockResolvedValue(makeRes({ status: 408, contentType: 'text/plain', body: 'timeout' }));
    await expect(httpGet('https://api.example.com/408', { retries: 1 })).rejects.toThrow(/HTTP 408/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('429 视为可重试 → 共请求 2 次', async () => {
    mockFetch.mockResolvedValue(makeRes({ status: 429, contentType: 'text/plain', body: 'too many' }));
    await expect(httpGet('https://api.example.com/429', { retries: 1 })).rejects.toThrow(/HTTP 429/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('5xx 重试后仍失败 → 汇总错误并保留 status', async () => {
    mockFetch.mockResolvedValue(makeRes({ status: 500, contentType: 'text/plain', body: 'boom' }));
    try {
      await httpGet('https://api.example.com/500', { retries: 1 });
      expect.unreachable('应该抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as Error).message).toMatch(/fetch failed after 2 attempts/);
      expect((err as HttpError).status).toBe(500);
    }
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('网络层异常（非 HttpError）→ 汇总错误不带 status', async () => {
    mockFetch.mockRejectedValue(new Error('__test_econnreset'));
    try {
      await httpGet('https://api.example.com/reset', { retries: 0 });
      expect.unreachable('应该抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as Error).message).toMatch(/fetch failed after 1 attempts/);
      expect((err as HttpError).status).toBeUndefined();
    }
  });

  it('未指定 retries → 默认重试 1 次（共 2 次请求）', async () => {
    mockFetch.mockRejectedValue(new Error('__test_boom'));
    await expect(httpGet('https://api.example.com/default-retries')).rejects.toThrow(/fetch failed after 2 attempts/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('超时触发 abort → 汇总为一次失败', async () => {
    mockFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('__test_aborted')));
      })
    );
    await expect(
      httpGet('https://api.example.com/slow', { retries: 0, timeoutMs: 20 })
    ).rejects.toThrow(/fetch failed after 1 attempts/);
  });

  it('自定义 headers 与默认 User-Agent / Accept 合并', async () => {
    mockFetch.mockResolvedValue(makeRes({ body: '{}' }));
    await httpGet('https://api.example.com/h', { retries: 0, headers: { 'X-Test': 'yes' } });
    const init = callAt(0)[1];
    expect(init.headers?.['X-Test']).toBe('yes');
    expect(init.headers?.['User-Agent']).toContain('crypto-price-bot');
    expect(init.headers?.['Accept']).toBe('application/json');
    expect(init.method).toBe('GET');
  });

  it('未传 headers → 只带默认头', async () => {
    mockFetch.mockResolvedValue(makeRes({ body: '{}' }));
    await httpGet('https://api.example.com/noh', { retries: 0 });
    const init = callAt(0)[1];
    expect(init.headers?.['X-Test']).toBeUndefined();
    expect(init.headers?.['User-Agent']).toContain('crypto-price-bot');
  });

  it('无 DoH 时复用同一个 keep-alive Agent', async () => {
    mockFetch.mockResolvedValue(makeRes({ body: '{}' }));
    await httpGet('https://api.example.com/a', { retries: 0 });
    await httpGet('https://api.example.com/b', { retries: 0 });
    expect(callAt(0)[1].dispatcher).toBe(callAt(1)[1].dispatcher);
  });

  it('大响应体（1MB）完整返回', async () => {
    const big = 'x'.repeat(1024 * 1024);
    mockFetch.mockResolvedValue(makeRes({ contentType: 'text/plain', body: big }));
    const res = await httpGet('https://api.example.com/big', { retries: 0 });
    expect((res.data as string).length).toBe(big.length);
  });
});

describe('httpPost', () => {
  it('POST 发送 JSON body 与 Content-Type', async () => {
    mockFetch.mockResolvedValue(makeRes({ body: '{}' }));
    const res = await httpPost('https://api.example.com/p', { a: 1 }, { retries: 0 });
    expect(res.status).toBe(200);
    const init = callAt(0)[1];
    expect(init.method).toBe('POST');
    expect(init.headers?.['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it('POST 支持自定义 headers 覆盖默认值', async () => {
    mockFetch.mockResolvedValue(makeRes({ body: '{}' }));
    await httpPost('https://api.example.com/p', { a: 1 }, { retries: 0, headers: { 'User-Agent': '__test_agent' } });
    expect(callAt(0)[1].headers?.['User-Agent']).toBe('__test_agent');
  });

  it('POST 在 DoH 生效时同样走 IP + Host 头', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://dns.example/dns-query')) return makeDohRes([{ type: 1, data: '10.0.0.1' }]);
      return makeRes({ body: '{}' });
    });
    await httpPost('https://post.example.com/p', { a: 1 }, { retries: 0, doh: { endpoint: 'https://dns.example/dns-query' } });
    const target = mockFetch.mock.calls.find((c) => String(c[0]).startsWith('https://10.0.0.1'));
    expect(target).toBeDefined();
    const init = target?.[1] as { headers: Record<string, string> };
    expect(init.headers['Host']).toBe('post.example.com');
  });
});

describe('DoH 解析', () => {
  it('DoH 解析成功 → 请求走 IP、保留原域名 Host 与 SNI', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://dns.example/dns-query')) return makeDohRes([{ type: 1, data: '93.184.216.34' }]);
      return makeRes({ body: JSON.stringify({ ok: true }) });
    });
    const res = await httpGet('https://api.example.com/path?x=1#frag', {
      retries: 0,
      doh: { endpoint: 'https://dns.example/dns-query' },
    });
    expect(res.data).toEqual({ ok: true });

    const target = mockFetch.mock.calls.find((c) => String(c[0]) !== 'https://dns.example/dns-query?name=api.example.com&type=A');
    expect(String(target?.[0])).toBe('https://93.184.216.34/path?x=1#frag');
    const init = target?.[1] as { headers: Record<string, string>; dispatcher: { opts: { connect?: { servername: string } } } };
    expect(init.headers['Host']).toBe('api.example.com');
    expect(init.dispatcher.opts.connect?.servername).toBe('api.example.com');
  });

  it('DoH 结果命中缓存 → 第二次不再发起 DoH 查询', async () => {
    let dohCalls = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://dns.example/dns-query')) {
        dohCalls++;
        return makeDohRes([{ type: 1, data: '1.2.3.4' }]);
      }
      return makeRes({ body: '{}' });
    });
    await httpGet('https://cached.example.com/a', { retries: 0, doh: { endpoint: 'https://dns.example/dns-query' } });
    await httpGet('https://cached.example.com/b', { retries: 0, doh: { endpoint: 'https://dns.example/dns-query' } });
    expect(dohCalls).toBe(1);
  });

  it('未指定 endpoint → 使用默认 DoH endpoint', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://1.1.1.1/dns-query')) return makeDohRes([{ type: 1, data: '5.6.7.8' }]);
      return makeRes({ body: '{}' });
    });
    await httpGet('https://defaultep.example.com/x', { retries: 0, doh: {} });
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe('https://1.1.1.1/dns-query?name=defaultep.example.com&type=A');
  });

  it('bypass 列表内的域名直连，不走 DoH', async () => {
    mockFetch.mockResolvedValue(makeRes({ body: '{}' }));
    await httpGet('https://bypass.example.com/x', {
      retries: 0,
      doh: { bypass: new Set(['bypass.example.com']), endpoint: 'https://dns.example/dns-query' },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe('https://bypass.example.com/x');
  });

  it('默认 bypass 含 1.1.1.1 → 直连不做 DoH 查询', async () => {
    mockFetch.mockResolvedValue(makeRes({ body: '{}' }));
    await httpGet('https://1.1.1.1/dns-query', { retries: 0, doh: { endpoint: 'https://dns.example/dns-query' } });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe('https://1.1.1.1/dns-query');
  });

  it('DoH 返回 HTTP 错误 → 回退到原域名直连', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://dns.example/dns-query')) return makeRes({ status: 500, contentType: 'text/plain', body: 'nope' });
      return makeRes({ body: '{}' });
    });
    const res = await httpGet('https://fallback.example.com/x', {
      retries: 0,
      doh: { endpoint: 'https://dns.example/dns-query' },
    });
    expect(res.status).toBe(200);
    expect(String(mockFetch.mock.calls[1]?.[0])).toBe('https://fallback.example.com/x');
  });

  it('DoH 没有 A 记录 → 回退到原域名直连', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://dns.example/dns-query')) return makeDohRes([{ type: 5, data: 'alias.example.com' }]);
      return makeRes({ body: '{}' });
    });
    const res = await httpGet('https://noa.example.com/x', {
      retries: 0,
      doh: { endpoint: 'https://dns.example/dns-query' },
    });
    expect(res.status).toBe(200);
    expect(String(mockFetch.mock.calls[1]?.[0])).toBe('https://noa.example.com/x');
  });

  it('DoH 响应没有 Answer 字段 → 回退到原域名直连', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://dns.example/dns-query')) return makeDohRes(undefined);
      return makeRes({ body: '{}' });
    });
    const res = await httpGet('https://noanswer.example.com/x', {
      retries: 0,
      doh: { endpoint: 'https://dns.example/dns-query' },
    });
    expect(res.status).toBe(200);
    expect(String(mockFetch.mock.calls[1]?.[0])).toBe('https://noanswer.example.com/x');
  });

  it('doh 为 null → 完全不做解析，直接用原域名', async () => {
    mockFetch.mockResolvedValue(makeRes({ body: '{}' }));
    await httpGet('https://null.example.com/x', { retries: 0, doh: null });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe('https://null.example.com/x');
  });
});

describe('setupDefaultAgent', () => {
  it('设置 undici 全局 dispatcher', () => {
    setupDefaultAgent();
    expect(mockSetGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(mockSetGlobalDispatcher.mock.calls[0]?.[0]).toBeDefined();
  });
});

describe('disposeHttp', () => {
  it('关闭已创建的 Agent', async () => {
    mockFetch.mockResolvedValue(makeRes({ body: '{}' }));
    await httpGet('https://api.example.com/x', { retries: 0 });
    const agent = agentRegistry[agentRegistry.length - 1];
    expect(agent?.closed).toBe(false);
    disposeHttp();
    expect(agent?.closed).toBe(true);
  });

  it('从未创建过 Agent 时调用是空操作', () => {
    expect(() => disposeHttp()).not.toThrow();
  });
});

describe('HttpError', () => {
  it('带 status', () => {
    const e = new HttpError('__test_error', 404);
    expect(e.status).toBe(404);
    expect(e.name).toBe('HttpError');
    expect(e.message).toBe('__test_error');
  });

  it('不带 status', () => {
    const e = new HttpError('__test_error');
    expect(e.status).toBeUndefined();
  });
});
