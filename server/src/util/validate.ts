import { z } from 'zod';

export const settingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);

export const settingKeySchema = z.enum([
  'tg_bot_token',
  'tg_chat_id',
  'feishu_webhook_url',
  'timezone',
  'schedule_rule',
  'usdt_to_cny',
  'ua',
  'doh_enabled',
  'doh_server',
  'doh_bypass',
  'request_timeout_ms',
  'max_retries',
  'alert_cooldown_hours',
]);

export const settingsMapSchema = z.object({
  tg_bot_token: z.union([z.string(), z.null()]).optional(),
  tg_chat_id: z.union([z.string(), z.null()]).optional(),
  feishu_webhook_url: z.union([z.string().url(), z.string().length(0), z.null()]).optional(),
  timezone: z.string().min(1).optional(),
  schedule_rule: z.string().regex(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+$/, 'must be 6-field cron').optional(),
  usdt_to_cny: z.number().positive().optional(),
  ua: z.string().min(1).optional(),
  doh_enabled: z.boolean().optional(),
  doh_server: z.string().min(1).optional(),
  doh_bypass: z.array(z.string()).optional(),
  request_timeout_ms: z.number().int().positive().max(120_000).optional(),
  max_retries: z.number().int().min(0).max(5).optional(),
  alert_cooldown_hours: z.number().int().min(0).max(720).optional(),
}).strict();

export const coinSchema = z.object({
  symbol: z.string().min(1).max(16).regex(/^[A-Z0-9]+$/),
  name: z.string().min(1).max(64),
  gate_pair: z.union([z.string().regex(/^[A-Z0-9]+_[A-Z0-9]+$/), z.null()]),
  gate_slug: z.union([z.string().min(1).max(64).regex(/^[a-z0-9-]+$/), z.null()]).optional(),
  cg_id: z.string().min(1).max(64),
  sort_order: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
  // 价格预警阈值（美元价，USDT 对价）。null/缺省 = 不设该方向预警。
  alert_above: z.number().positive().nullable().optional(),
  alert_below: z.number().positive().nullable().optional(),
});

export const coinUpdateSchema = coinSchema.partial();

export const reorderSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
});

export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

export const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8, 'new password must be at least 8 chars').max(128),
});

export const resendSchema = z.object({
  channels: z.array(z.enum(['tg', 'feishu'])).min(1),
});

export const reportDeleteBatchSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
}).strict();

export function parseJson<T>(schema: z.ZodType<T>, raw: string): { ok: true; data: T } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, error: issue ? `${issue.path.join('.')}: ${issue.message}` : 'validation failed' };
  }
  return { ok: true, data: result.data };
}