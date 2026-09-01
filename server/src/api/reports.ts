import { Router, type RouteContext } from '../http/router.js';
import { sendOk } from '../http/response.js';
import { BadRequestError, UnauthorizedError, NotFoundError } from '../http/errors.js';
import { listReports, findById, deleteReport, deleteReports, clearAllReports } from '../core/models/report.js';
import { resendReport } from '../core/task.js';
import { resendSchema, reportDeleteBatchSchema, parseJson } from '../util/validate.js';

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

  // 单条删除
  r.delete('/api/reports/:id', (ctx) => {
    requireAuth(ctx);
    const id = parseInt(ctx.params['id'] ?? '', 10);
    if (!Number.isFinite(id)) throw new BadRequestError('invalid id');
    const ok = deleteReport(id);
    if (!ok) throw new NotFoundError(`report ${id} not found`);
    sendOk(ctx.res, { ok: true, deleted: 1 });
  });

  // 批量删除（前端传 ids；不支持「一次清空超过 limit 总数」的场景）
  r.post('/api/reports/delete-batch', async (ctx) => {
    requireAuth(ctx);
    const parsed = parseJson(reportDeleteBatchSchema, ctx.bodyRaw ?? '');
    if (!parsed.ok) throw new BadRequestError(parsed.error);
    const removed = deleteReports(parsed.data.ids);
    sendOk(ctx.res, { ok: true, deleted: removed });
  });

  // 真·清空全部（不传 ids；前端二次 modal 确认代替服务端 confirm 字段）
  r.post('/api/reports/clear', (ctx) => {
    requireAuth(ctx);
    const removed = clearAllReports();
    sendOk(ctx.res, { ok: true, deleted: removed });
  });
}

function requireAuth(ctx: RouteContext): void {
  if (!ctx.user) throw new UnauthorizedError('login required');
}