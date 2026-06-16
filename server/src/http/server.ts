import { createServer as nodeCreateServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { Router, handleRequest, type RouteContext } from './router.js';
import {
  loggerMiddleware,
  errorMiddleware,
  jsonBodyMiddleware,
  staticMiddleware,
  type AuthedUser,
} from './middleware.js';
import { createLogger } from '../util/logger.js';

const log = createLogger({ isTTY: false }).child('http').child('server');

export type AppMiddleware = (ctx: RouteContext, next: () => Promise<void>) => Promise<void>;

export interface ServerOptions {
  port: number;
  host?: string;
  staticDir?: string;
  resolveSession: (token: string) => Promise<AuthedUser | null>;
}

export function buildApp(opts: { resolveSession: (token: string) => Promise<AuthedUser | null>; staticDir?: string }): {
  router: Router;
  middlewares: AppMiddleware[];
} {
  const router = new Router();
  const middlewares: AppMiddleware[] = [
    errorMiddleware,
    loggerMiddleware,
    jsonBodyMiddleware,
  ];
  if (opts.staticDir && existsSync(opts.staticDir)) {
    middlewares.push(staticMiddleware(opts.staticDir, true));
  }
  return { router, middlewares };
}

export async function startServer(opts: ServerOptions): Promise<{ server: Server; close: () => Promise<void> }> {
  const app = buildApp({ resolveSession: opts.resolveSession, staticDir: opts.staticDir });
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