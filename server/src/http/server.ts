import { createServer as nodeCreateServer, type Server } from 'node:http';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Router, handleRequest, type Middleware } from './router.js';
import {
  loggerMiddleware,
  errorMiddleware,
  jsonBodyMiddleware,
  staticMiddleware,
  type AuthedUser,
} from './middleware.js';
import { createLogger } from '../util/logger.js';

const log = createLogger({ isTTY: false }).child('http').child('server');

export interface ServerOptions {
  port: number;
  host?: string;
  staticDir?: string;
  resolveSession: (token: string) => Promise<AuthedUser | null>;
}

export function buildApp(opts: { resolveSession: (token: string) => Promise<AuthedUser | null>; staticDir?: string }): {
  router: Router;
  middlewares: Middleware[];
} {
  const router = new Router();
  const middlewares: Middleware[] = [
    errorMiddleware,
    loggerMiddleware,
    jsonBodyMiddleware,
  ];
  if (opts.staticDir && existsSync(opts.staticDir)) {
    middlewares.push(staticMiddleware(opts.staticDir, true));
  }
  // 业务中间件（auth）由各 api 模块在 register 时插入
  return { router, middlewares };
}

export async function startServer(opts: ServerOptions): Promise<{ server: Server; close: () => Promise<void> }> {
  const app = buildApp({ resolveSession: opts.resolveSession, staticDir: opts.staticDir });
  // 这里返回的 middlewares 不含 auth，由调用方在 router 注册后追加
  const server = nodeCreateServer((req, res) => {
    handleRequest(req, res, app.router, app.middlewares).catch((err) => {
      log.error('unhandled in handleRequest', err);
      try { res.writeHead(500); res.end('internal error'); } catch { /* ignore */ }
    });
  });
  await new Promise<void>((r) => server.listen(opts.port, opts.host ?? '0.0.0.0', r));
  log.info(`listening on ${opts.host ?? '0.0.0.0'}:${opts.port}`);
  return {
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export { join };