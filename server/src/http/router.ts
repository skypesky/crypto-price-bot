import type { IncomingMessage, ServerResponse } from 'node:http';
import { NotFoundError } from './errors.js';
import { sendError, sendJson } from './response.js';
import { getQuery } from './request.js';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  query: URLSearchParams;
  params: Record<string, string>;
  // 扩展字段（由 middleware 注入）
  body?: unknown;
  bodyRaw?: string;
  user?: { id: number; username: string };
}

export type Handler = (ctx: RouteContext) => Promise<void> | void;

interface RouteNode {
  method?: Map<Method, Handler>;
  paramChild?: { key: string; node: RouteNode };
  staticChildren: Map<string, RouteNode>;
}

function createNode(): RouteNode {
  return { staticChildren: new Map() };
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export class Router {
  private root: RouteNode = createNode();

  add(method: Method, path: string, handler: Handler): this {
    const parts = splitPath(path);
    let cur = this.root;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]!;
      if (seg.startsWith(':')) {
        const key = seg.slice(1);
        if (!cur.paramChild) {
          cur.paramChild = { key, node: createNode() };
        }
        cur = cur.paramChild.node;
      } else {
        if (!cur.staticChildren.has(seg)) {
          cur.staticChildren.set(seg, createNode());
        }
        cur = cur.staticChildren.get(seg)!;
      }
    }
    if (!cur.method) cur.method = new Map();
    cur.method.set(method, handler);
    return this;
  }

  get(path: string, h: Handler): this { return this.add('GET', path, h); }
  post(path: string, h: Handler): this { return this.add('POST', path, h); }
  put(path: string, h: Handler): this { return this.add('PUT', path, h); }
  patch(path: string, h: Handler): this { return this.add('PATCH', path, h); }
  delete(path: string, h: Handler): this { return this.add('DELETE', path, h); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = splitPath(pathname);
    let cur: RouteNode = this.root;
    const params: Record<string, string> = {};
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]!;
      const next = cur.staticChildren.get(seg);
      if (next) {
        cur = next;
      } else if (cur.paramChild) {
        params[cur.paramChild.key] = decodeURIComponent(seg);
        cur = cur.paramChild.node;
      } else {
        return null;
      }
    }
    const m = cur.method?.get(method as Method);
    if (!m) return null;
    return { handler: m, params };
  }
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  router: Router,
  middlewares: ((ctx: RouteContext, next: () => Promise<void>) => Promise<void>)[],
): Promise<void> {
  const url = req.url ?? '/';
  const pathname = url.split('?')[0] || '/';
  const query = getQuery(url);
  const matched = router.match(req.method ?? 'GET', pathname);
  const ctx: RouteContext = {
    req, res, pathname, query,
    params: matched?.params ?? {},
  };

  const runHandler = async (): Promise<void> => {
    if (!matched) {
      sendError(res, new NotFoundError(`no route for ${req.method} ${pathname}`));
      return;
    }
    try {
      await matched.handler(ctx);
    } catch (err) {
      sendError(res, err);
    }
  };

  // 组合中间件 + 路由
  const chain = [...middlewares, async () => { await runHandler(); }];
  let i = 0;
  const next = async (): Promise<void> => {
    const mw = chain[i++];
    if (!mw) return;
    await mw(ctx, next);
  };
  await next();
}