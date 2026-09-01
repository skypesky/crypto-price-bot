import { Router, type RouteContext } from '../http/router.js';
import { sendOk } from '../http/response.js';
import { BadRequestError, UnauthorizedError, NotFoundError, ConflictError } from '../http/errors.js';
import { listCoins, findCoinById, createCoin, updateCoin, deleteCoin, reorderCoins } from '../core/models/coin.js';
import { coinSchema, coinUpdateSchema, reorderSchema, parseJson } from '../util/validate.js';

export function registerCoins(r: Router): void {
  r.get('/api/coins', (ctx) => {
    requireAuth(ctx);
    sendOk(ctx.res, listCoins());
  });

  r.post('/api/coins', async (ctx) => {
    requireAuth(ctx);
    const parsed = parseJson(coinSchema, ctx.bodyRaw ?? '');
    if (!parsed.ok) throw new BadRequestError(parsed.error);
    try {
    const c = createCoin({
      symbol: parsed.data.symbol,
      name: parsed.data.name,
      gate_pair: parsed.data.gate_pair,
      gate_slug: parsed.data.gate_slug ?? null,
      cg_id: parsed.data.cg_id,
      sort_order: parsed.data.sort_order ?? 0,
      enabled: parsed.data.enabled ? 1 : 0,
      alert_above: parsed.data.alert_above ?? null,
      alert_below: parsed.data.alert_below ?? null,
    });
      sendOk(ctx.res, c);
    } catch (err) {
      if ((err as Error).message.includes('UNIQUE')) throw new ConflictError('symbol already exists');
      throw err;
    }
  });

  r.put('/api/coins/:id', async (ctx) => {
    requireAuth(ctx);
    const id = parseInt(ctx.params['id'] ?? '', 10);
    if (!Number.isFinite(id)) throw new BadRequestError('invalid id');
    const parsed = parseJson(coinUpdateSchema, ctx.bodyRaw ?? '');
    if (!parsed.ok) throw new BadRequestError(parsed.error);
    const patch: Parameters<typeof updateCoin>[1] = {};
    if (parsed.data.symbol !== undefined) patch.symbol = parsed.data.symbol;
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.gate_pair !== undefined) patch.gate_pair = parsed.data.gate_pair;
    if (parsed.data.gate_slug !== undefined) patch.gate_slug = parsed.data.gate_slug;
    if (parsed.data.cg_id !== undefined) patch.cg_id = parsed.data.cg_id;
    if (parsed.data.sort_order !== undefined) patch.sort_order = parsed.data.sort_order;
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled ? 1 : 0;
    if (parsed.data.alert_above !== undefined) {
      patch.alert_above = parsed.data.alert_above;
      // 用户主动调整 above 阈值：清除 above 方向的冷却，
      // 下次首次穿越会重新触发（不重置 dir，避免 if 之前的 above 冷却泄漏到 below）
      patch.last_alert_at = 0;
      patch.last_alert_dir = null;
    }
    if (parsed.data.alert_below !== undefined) {
      patch.alert_below = parsed.data.alert_below;
      patch.last_alert_at = 0;
      patch.last_alert_dir = null;
    }
    const updated = updateCoin(id, patch);
    if (!updated) throw new NotFoundError(`coin ${id} not found`);
    sendOk(ctx.res, updated);
  });

  r.delete('/api/coins/:id', (ctx) => {
    requireAuth(ctx);
    const id = parseInt(ctx.params['id'] ?? '', 10);
    if (!Number.isFinite(id)) throw new BadRequestError('invalid id');
    const ok = deleteCoin(id);
    if (!ok) throw new NotFoundError(`coin ${id} not found`);
    sendOk(ctx.res, { ok: true });
  });

  r.post('/api/coins/reorder', async (ctx) => {
    requireAuth(ctx);
    const parsed = parseJson(reorderSchema, ctx.bodyRaw ?? '');
    if (!parsed.ok) throw new BadRequestError(parsed.error);
    reorderCoins(parsed.data.ids);
    sendOk(ctx.res, listCoins());
  });
}

function requireAuth(ctx: RouteContext): void {
  if (!ctx.user) throw new UnauthorizedError('login required');
}