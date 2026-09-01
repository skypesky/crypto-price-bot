/**
 * 轻量 fetch wrapper：自动带 cookie、统一错误处理。
 */

export interface ApiError {
  code: string;
  message: string;
}

export class ApiException extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiException';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  });
  if (res.status === 401) {
    // 未登录：跳转到登录页
    if (!path.startsWith('/api/auth/login') && window.location.hash !== '#/login') {
      window.location.hash = '#/login';
    }
    throw new ApiException(401, 'unauthorized', 'login required');
  }
  const ct = res.headers.get('content-type') ?? '';
  const payload = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = (payload as { error?: { code?: string; message?: string } })?.error;
    throw new ApiException(res.status, err?.code ?? 'error', err?.message ?? `HTTP ${res.status}`);
  }
  return (payload as { data: T }).data;
}

export const apiGet = <T,>(path: string) => request<T>('GET', path);
export const apiPost = <T,>(path: string, body?: unknown) => request<T>('POST', path, body);
export const apiPut = <T,>(path: string, body?: unknown) => request<T>('PUT', path, body);
export const apiDelete = <T,>(path: string) => request<T>('DELETE', path);

export interface Coin {
  id: number;
  symbol: string;
  name: string;
  gate_pair: string | null;
  gate_slug: string | null;
  cg_id: string;
  sort_order: number;
  enabled: number;
  alert_above: number | null;
  alert_below: number | null;
  last_price: number | null;
  last_alert_at: number;
  last_alert_dir: 'above' | 'below' | null;
  created_at: number;
  updated_at: number;
}

export interface Report {
  id: number;
  triggered_by: string;
  success: number;
  total_coins: number;
  ok_coins: number;
  tg_sent: number;
  feishu_sent: number;
  message: string;
  summary: string;
  created_at: number;
}

export interface Status {
  version: string;
  uptime: number;
  dbOk: boolean;
  sqliteVersion: string | null;
  totalCoins: number;
  userCount: number;
  nextRunAt: string | null;
  lastReportAt: string | null;
  timezone: string;
  scheduleRule: string;
}

export interface LogEntry {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;
  msg: string;
}