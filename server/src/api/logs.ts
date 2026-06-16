import { Router, type RouteContext } from '../http/router.js';
import { sendOk } from '../http/response.js';
import { UnauthorizedError } from '../http/errors.js';
import { logger } from '../util/logger.js';

export function registerLogs(r: Router): void {
  r.get('/api/logs', (ctx) => {
    requireAuth(ctx);
    const limit = parseInt(ctx.query.get('limit') ?? '200', 10);
    const entries = logger.recent(Number.isFinite(limit) ? Math.min(limit, 500) : 200);
    sendOk(ctx.res, entries);
  });
}

function requireAuth(ctx: RouteContext): void {
  if (!ctx.user) throw new UnauthorizedError('login required');
}