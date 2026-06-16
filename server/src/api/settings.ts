import { Router, type RouteContext } from '../http/router.js';
import { sendOk } from '../http/response.js';
import { BadRequestError, UnauthorizedError } from '../http/errors.js';
import { getAllSettings, setManySettings, type SettingValue } from '../core/models/setting.js';
import { settingsMapSchema, parseJson } from '../util/validate.js';
import { reloadConfig } from '../core/config.js';

export function registerSettings(r: Router): void {
  r.get('/api/settings', (ctx) => {
    requireAuth(ctx);
    sendOk(ctx.res, getAllSettings());
  });

  r.put('/api/settings', async (ctx) => {
    requireAuth(ctx);
    const parsed = parseJson(settingsMapSchema, ctx.bodyRaw ?? '');
    if (!parsed.ok) throw new BadRequestError(parsed.error);
    const updates: Record<string, SettingValue> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v === undefined) continue;
      updates[k] = v as SettingValue;
    }
    setManySettings(updates);
    reloadConfig();
    sendOk(ctx.res, getAllSettings());
  });
}

function requireAuth(ctx: RouteContext): void {
  if (!ctx.user) throw new UnauthorizedError('login required');
}