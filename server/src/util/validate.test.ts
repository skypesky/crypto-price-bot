import { describe, it, expect } from 'vitest';
import {
  settingsMapSchema,
  coinSchema,
  coinUpdateSchema,
  loginSchema,
  passwordChangeSchema,
  resendSchema,
  parseJson,
} from './validate.js';

describe('settingsMapSchema', () => {
  it('接受完整对象', () => {
    const r = settingsMapSchema.safeParse({
      tg_bot_token: 'abc',
      usdt_to_cny: 7.2,
      doh_enabled: true,
    });
    expect(r.success).toBe(true);
  });

  it('拒绝未知字段', () => {
    const r = settingsMapSchema.safeParse({ unknown_key: 1 });
    expect(r.success).toBe(false);
  });

  it('usdt_to_cny 必须为正数', () => {
    expect(settingsMapSchema.safeParse({ usdt_to_cny: -1 }).success).toBe(false);
    expect(settingsMapSchema.safeParse({ usdt_to_cny: 0 }).success).toBe(false);
  });

  it('schedule_rule 必须是 6 段 cron', () => {
    expect(settingsMapSchema.safeParse({ schedule_rule: '0 */30 * * * *' }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ schedule_rule: '0 0 9 * *' }).success).toBe(false);
  });

  it('request_timeout_ms 限制最大 120s', () => {
    expect(settingsMapSchema.safeParse({ request_timeout_ms: 200_000 }).success).toBe(false);
  });
});

describe('coinSchema', () => {
  it('接受完整币种', () => {
    const r = coinSchema.safeParse({
      symbol: 'BTC',
      name: '比特币',
      gate_pair: 'BTC_USDT',
      cg_id: 'bitcoin',
      sort_order: 0,
      enabled: true,
    });
    expect(r.success).toBe(true);
  });

  it('symbol 必须大写', () => {
    expect(coinSchema.safeParse({
      symbol: 'btc', name: 'btc', gate_pair: 'BTC_USDT', cg_id: 'btc',
    }).success).toBe(false);
  });

  it('gate_pair 允许 null（稳定币）', () => {
    const r = coinSchema.safeParse({
      symbol: 'USDT', name: '泰达币', gate_pair: null, cg_id: 'tether',
    });
    expect(r.success).toBe(true);
  });

  it('gate_pair 格式：XXX_YYY', () => {
    expect(coinSchema.safeParse({
      symbol: 'BTC', name: 'btc', gate_pair: 'BTCUSDT', cg_id: 'btc',
    }).success).toBe(false);
  });
});

describe('coinUpdateSchema', () => {
  it('支持部分更新', () => {
    expect(coinUpdateSchema.safeParse({ name: '改名' }).success).toBe(true);
  });
});

describe('loginSchema', () => {
  it('接受账密', () => {
    expect(loginSchema.safeParse({ username: 'admin', password: 'pwd' }).success).toBe(true);
  });

  it('拒绝空用户名', () => {
    expect(loginSchema.safeParse({ username: '', password: 'pwd' }).success).toBe(false);
  });
});

describe('passwordChangeSchema', () => {
  it('新密码至少 8 字符', () => {
    expect(passwordChangeSchema.safeParse({ oldPassword: 'a', newPassword: 'short' }).success).toBe(false);
    expect(passwordChangeSchema.safeParse({ oldPassword: 'a', newPassword: 'longenough' }).success).toBe(true);
  });
});

describe('resendSchema', () => {
  it('channels 至少 1 个', () => {
    expect(resendSchema.safeParse({ channels: [] }).success).toBe(false);
    expect(resendSchema.safeParse({ channels: ['tg'] }).success).toBe(true);
  });

  it('channels 只能是 tg/feishu', () => {
    expect(resendSchema.safeParse({ channels: ['email'] }).success).toBe(false);
  });
});

describe('parseJson', () => {
  it('合法 JSON 通过', () => {
    const r = parseJson(loginSchema, JSON.stringify({ username: 'a', password: 'b' }));
    expect(r.ok).toBe(true);
  });

  it('非法 JSON 返回 error', () => {
    const r = parseJson(loginSchema, 'not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('invalid JSON');
  });

  it('JSON 合法但 schema 失败返回 error', () => {
    const r = parseJson(loginSchema, JSON.stringify({ username: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('username');
  });
});