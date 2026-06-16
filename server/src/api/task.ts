import { Router, type RouteContext } from '../http/router.js';
import { sendOk } from '../http/response.js';
import { UnauthorizedError } from '../http/errors.js';
import { runTask } from '../core/task.js';
import { nextRunAt } from '../core/scheduler.js';

export function registerTask(r: Router): void {
  r.post('/api/task/run', async (ctx) => {
    requireAuth(ctx);
    const result = await runTask('manual');
    sendOk(ctx.res, {
      reportId: result.reportId,
      success: result.success,
      totalCoins: result.totalCoins,
      okCoins: result.okCoins,
      tgSent: result.tgSent,
      feishuSent: result.feishuSent,
    });
  });

  r.get('/api/task/next', (ctx) => {
    requireAuth(ctx);
    sendOk(ctx.res, { nextRunAt: nextRunAt()?.toISOString() ?? null });
  });
}

function requireAuth(ctx: RouteContext): void {
  if (!ctx.user) throw new UnauthorizedError('login required');
}