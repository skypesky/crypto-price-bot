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

export interface AppOptions {
  resolveSession: (token: string) => Promise<AuthedUser | null>;
  staticDir?: string;
}

export function buildApp(opts: AppOptions): {
  router: Router;
  middlewares: AppMiddleware[];
} {
  const router = new Router();
  const middlewares: AppMiddleware[] = [
    loggerMiddleware,
    errorMiddleware,
    jsonBodyMiddleware,
  ];
  if (opts.staticDir && existsSync(opts.staticDir)) {
    middlewares.push(staticMiddleware(opts.staticDir, true));
  }
  return { router, middlewares };
}

export interface ListenOptions extends AppOptions {
  port: number;
  host?: string;
}

export async function listen(app: { router: Router; middlewares: AppMiddleware[] }, opts: ListenOptions): Promise<{ server: Server; close: () => Promise<void> }> {
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