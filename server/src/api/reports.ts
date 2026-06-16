import { Router, type RouteContext } from '../http/router.js';
import { sendOk } from '../http/response.js';
import { BadRequestError, UnauthorizedError, NotFoundError } from '../http/errors.js';
import { listReports, findById } from '../core/models/report.js';
import { resendReport } from '../core/task.js';
import { resendSchema, parseJson } from '../util/validate.js';

export function registerReports(r: Router): void {
  r.get('/api/reports', (ctx) => {
    requireAuth(ctx);
    const limit = parseInt(ctx.query.get('limit') ?? '50', 10);
    sendOk(ctx.res, listReports(Number.isFinite(limit) ? limit : 50));
  });

  r.get('/api/reports/:id', (ctx) => {
    requireAuth(ctx);
    const id = parseInt(ctx.params['id'] ?? '', 10);
    if (!Number.isFinite(id)) throw new BadRequestError('invalid id');
    const r = findById(id);
    if (!r) throw new NotFoundError(`report ${id} not found`);
    sendOk(ctx.res, r);
  });

  r.post('/api/reports/:id/resend', async (ctx) => {
    requireAuth(ctx);
    const id = parseInt(ctx.params['id'] ?? '', 10);
    if (!Number.isFinite(id)) throw new BadRequestError('invalid id');
    const parsed = parseJson(resendSchema, ctx.bodyRaw ?? '');
    if (!parsed.ok) throw new BadRequestError(parsed.error);
    const r = findById(id);
    if (!r) throw new NotFoundError(`report ${id} not found`);
    const result = await resendReport(r.message, parsed.data.channels);
    sendOk(ctx.res, result);
  });
}

function requireAuth(ctx: RouteContext): void {
  if (!ctx.user) throw new UnauthorizedError('login required');
}