import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { sendError, sendJson, sendOk, mimeFor } from './response.js';
import { readBody, parseCookies } from './request.js';
import { createLogger } from '../util/logger.js';
import type { RouteContext } from './router.js';
import { UnauthorizedError } from './errors.js';

const log = createLogger({ isTTY: false }).child('http');

export type Next = () => Promise<void> | void;
export type Middleware = (ctx: RouteContext, next: Next) => Promise<void>;

/**
 * 请求日志中间件：输出 method + url + status + 耗时。
 */
export const loggerMiddleware: Middleware = async (ctx, next) => {
  const start = Date.now();
  try {
    await next();
  } finally {
    const dur = Date.now() - start;
    log.info(`${ctx.req.method} ${ctx.pathname} ${ctx.res.statusCode} ${dur}ms`);
  }
};

/**
 * 错误兜底中间件：捕获后续中间件/handler 抛出的错误，统一 sendError。
 */
export const errorMiddleware: Middleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    sendError(ctx.res, err);
  }
};

/**
 * JSON body 解析：仅对 application/json 生效。
 */
export const jsonBodyMiddleware: Middleware = async (ctx, next) => {
  const method = ctx.req.method ?? 'GET';
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const ct = (ctx.req.headers['content-type'] ?? '').toString();
    if (ct.includes('application/json')) {
      try {
        const raw = await readBody(ctx.req);
        ctx.bodyRaw = raw;
        if (raw) {
          try { ctx.body = JSON.parse(raw); } catch { ctx.body = null; }
        }
      } catch (err) {
        sendError(ctx.res, err);
        return;
      }
    }
  }
  await next();
};

/**
 * 鉴权中间件：从 cpb_session cookie 解析 session token，校验后挂载 user。
 */
export interface AuthedUser {
  id: number;
  username: string;
}

export const authMiddleware = (
  resolveSession: (token: string) => Promise<AuthedUser | null>,
): Middleware => async (ctx, next) => {
  const cookies = parseCookies(ctx.req);
  const token = cookies['cpb_session'];
  if (!token) throw new UnauthorizedError('missing session cookie');
  const user = await resolveSession(token);
  if (!user) throw new UnauthorizedError('invalid or expired session');
  ctx.user = user;
  await next();
};

/**
 * 静态文件服务中间件：仅对 GET 生效。
 * 找不到时调用 next()（让 router 处理 404）。
 */
export const staticMiddleware = (rootDir: string, spaIndex = true): Middleware => async (ctx, next) => {
  if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') {
    await next();
    return;
  }
  let p = ctx.pathname;
  if (p === '/' && spaIndex) p = '/index.html';
  const filePath = normalize(join(rootDir, p));
  // 防 path traversal
  const resolved = resolve(filePath);
  if (!resolved.startsWith(resolve(rootDir))) {
    await next();
    return;
  }
  if (existsSync(resolved) && statSync(resolved).isFile()) {
    const ext = extname(resolved);
    const mime = mimeFor(resolved);
    const stream = createReadStream(resolved);
    ctx.res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    if (ctx.req.method === 'HEAD') {
      stream.destroy();
    } else {
      stream.pipe(ctx.res);
    }
    return;
  }
  // SPA 兜底：找不到文件 → 仍返回 index.html（让前端路由处理）
  if (spaIndex) {
    const indexPath = join(rootDir, 'index.html');
    if (existsSync(indexPath)) {
      const stream = createReadStream(indexPath);
      ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      stream.pipe(ctx.res);
      return;
    }
  }
  await next();
};

/** 工具：从 ctx 拿到 cookies 一次性 */
export function getCookie(ctx: RouteContext, name: string): string | undefined {
  const cookies = parseCookies(ctx.req);
  return cookies[name];
}

export function setCookie(
  res: ServerResponse,
  name: string,
  value: string,
  opts: { maxAge?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None'; path?: string } = {},
): void {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  else parts.push('Path=/');
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  const existing = res.getHeader('Set-Cookie');
  if (existing) {
    const arr = Array.isArray(existing) ? existing : [String(existing)];
    res.setHeader('Set-Cookie', [...arr, parts.join('; ')]);
  } else {
    res.setHeader('Set-Cookie', parts.join('; '));
  }
}

export function clearCookie(res: ServerResponse, name: string): void {
  setCookie(res, name, '', { maxAge: 0 });
}

// 给 RouterContext 扩展 body
declare module './router.js' {
  interface RouteContext {
    body?: unknown;
    bodyRaw?: string;
    user?: AuthedUser;
  }
}

// 兜底避免循环 import 时的 undefined
export { sendOk, sendJson };