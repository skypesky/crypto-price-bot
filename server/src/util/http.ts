/**
 * 基于 Node 内置 fetch 的 HTTP 工具：超时、自动重试、DoH 兜底。
 */

import { lookup } from 'node:dns/promises';
import { Agent, setGlobalDispatcher, fetch as undiciFetch } from 'undici';

export class HttpError extends Error {
  status?: number;
  constructor(msg: string, status?: number) {
    super(msg);
    this.name = 'HttpError';
    this.status = status;
  }
}

export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** 是否启用 DoH 兜底（系统 DNS 污染时） */
  doh?: DoHOptions | null;
}

export interface DoHOptions {
  /** Cloudflare DoH endpoint（默认 https://1.1.1.1/dns-query） */
  endpoint?: string;
  /** 直连不走 DoH 的域名集合（默认含 1.1.1.1） */
  bypass?: Set<string>;
}

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_DOH_BYPASS = new Set(['1.1.1.1', 'one.one.one.one', 'cloudflare-dns.com']);

/** DoH 缓存：hostname → ip */
const dohCache = new Map<string, string>();

async function dohLookup(hostname: string, endpoint: string): Promise<string> {
  if (dohCache.has(hostname)) return dohCache.get(hostname)!;
  const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=A`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5_000);
  try {
    const res = await undiciFetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
    const data = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    const a = (data.Answer || []).find((r) => r.type === 1);
    if (!a) throw new Error(`DoH: no A record for ${hostname}`);
    dohCache.set(hostname, a.data);
    return a.data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 用 DoH 解析 hostname；返回 hostname 本身如果 DoH 被禁用或解析失败。
 */
async function resolveHostname(hostname: string, doh: DoHOptions | null | undefined): Promise<string> {
  if (!doh) return hostname;
  const bypass = doh.bypass ?? DEFAULT_DOH_BYPASS;
  if (bypass.has(hostname)) return hostname;
  try {
    return await dohLookup(hostname, doh.endpoint ?? 'https://1.1.1.1/dns-query');
  } catch {
    return hostname;
  }
}

/**
 * 创建带 keep-alive 的 HTTPS agent（不引 DoH 时用）。
 */
function makeAgent(): Agent {
  return new Agent({ keepAliveTimeout: 5_000, keepAliveMaxTimeout: 10_000 });
}

let _agent: Agent | null = null;
function getAgent(): Agent {
  if (!_agent) _agent = makeAgent();
  return _agent;
}

/** DoH 场景：按 hostname 缓存带 servername(SNI) 的 dispatcher */
const dohDispatcherCache = new Map<string, Agent>();

function getDohDispatcher(hostname: string): Agent {
  let d = dohDispatcherCache.get(hostname);
  if (!d) {
    d = new Agent({
      keepAliveTimeout: 5_000,
      keepAliveMaxTimeout: 10_000,
      connect: { servername: hostname },
    });
    dohDispatcherCache.set(hostname, d);
  }
  return d;
}

/** 测试 / 关闭时清理 */
export function disposeHttp(): void {
  if (_agent) {
    _agent.close();
    _agent = null;
  }
  dohCache.clear();
  for (const d of dohDispatcherCache.values()) d.close();
  dohDispatcherCache.clear();
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
}

async function doFetch<T>(url: string, init: RequestInit, opts: HttpOptions, dispatcher: Agent): Promise<HttpResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await undiciFetch(url, {
      ...(init as Record<string, unknown>),
      signal: controller.signal,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]);
    const text = await res.text();
    let data: unknown = text;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      try { data = JSON.parse(text); } catch { /* keep as text */ }
    }
    if (res.status >= 400) {
      throw new HttpError(`HTTP ${res.status} ${url}`, res.status);
    }
    return { status: res.status, headers: res.headers, data: data as T };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry<T>(
  url: string,
  init: RequestInit,
  opts: HttpOptions,
  dispatcher: Agent,
): Promise<HttpResponse<T>> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await doFetch<T>(url, init, opts, dispatcher);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(500 * (attempt + 1));
      }
    }
  }
  throw new HttpError(
    `fetch failed after ${retries + 1} attempts: ${(lastErr as Error).message}`,
  );
}

export async function httpGet<T = unknown>(url: string, opts: HttpOptions = {}): Promise<HttpResponse<T>> {
  const u = new URL(url);
  const host = await resolveHostname(u.hostname, opts.doh);
  // DoH 把 hostname 解析成 IP 后：URL 用 IP 连，dispatcher 用 servername 让 SNI 回到原域名（HTTPS 证书校验）
  const usedIp = u.hostname !== host;
  const ipUrl = usedIp ? `${u.protocol}//${host}${u.pathname}${u.search}${u.hash}` : url;
  const dispatcher = usedIp ? getDohDispatcher(u.hostname) : getAgent();
  return fetchWithRetry<T>(ipUrl, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; crypto-price-bot/2.0)',
      Accept: 'application/json',
      ...(usedIp ? { Host: u.hostname } : {}),
      ...(opts.headers ?? {}),
    },
  }, opts, dispatcher);
}

export async function httpPost<T = unknown>(
  url: string,
  body: unknown,
  opts: HttpOptions = {},
): Promise<HttpResponse<T>> {
  const u = new URL(url);
  const host = await resolveHostname(u.hostname, opts.doh);
  const usedIp = u.hostname !== host;
  const ipUrl = usedIp ? `${u.protocol}//${host}${u.pathname}${u.search}${u.hash}` : url;
  const dispatcher = usedIp ? getDohDispatcher(u.hostname) : getAgent();
  return fetchWithRetry<T>(ipUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; crypto-price-bot/2.0)',
      ...(usedIp ? { Host: u.hostname } : {}),
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(body),
  }, opts, dispatcher);
}

/** 抑制 undici global agent 警告：避免测试时泄漏 */
export function setupDefaultAgent(): void {
  setGlobalDispatcher(getAgent());
}