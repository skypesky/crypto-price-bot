import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  settingValueSchema,
  settingKeySchema,
  settingsMapSchema,
  coinSchema,
  coinUpdateSchema,
  reorderSchema,
  loginSchema,
  passwordChangeSchema,
  resendSchema,
  reportDeleteBatchSchema,
  parseJson,
} from './validate.js';

describe('settingsMapSchema', () => {
  it('接受完整对象', () => {
    const r = settingsMapSchema.safeParse({
      tg_bot_token: 'abc',
      doh_enabled: true,
    });
    expect(r.success).toBe(true);
  });

  it('拒绝未知字段', () => {
    const r = settingsMapSchema.safeParse({ unknown_key: 1 });
    expect(r.success).toBe(false);
  });

  it('schedule_rule 必须是 6 段 cron', () => {
    expect(settingsMapSchema.safeParse({ schedule_rule: '0 */30 * * * *' }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ schedule_rule: '0 0 9 * *' }).success).toBe(false);
  });

  it('request_timeout_ms 限制最大 120s', () => {
    expect(settingsMapSchema.safeParse({ request_timeout_ms: 200_000 }).success).toBe(false);
  });

  it('数字字段接受 string（前端 antd InputNumber 兼容）', () => {
    expect(settingsMapSchema.safeParse({ request_timeout_ms: '15000' }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ max_retries: '1' }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ alert_cooldown_hours: '24' }).success).toBe(true);
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

describe('settingValueSchema', () => {
  it('接受 string / number / boolean / null / string[]', () => {
    expect(settingValueSchema.safeParse('__test_value').success).toBe(true);
    expect(settingValueSchema.safeParse(123).success).toBe(true);
    expect(settingValueSchema.safeParse(true).success).toBe(true);
    expect(settingValueSchema.safeParse(null).success).toBe(true);
    expect(settingValueSchema.safeParse(['__test_a', '__test_b']).success).toBe(true);
  });

  it('拒绝对象与非字符串数组', () => {
    expect(settingValueSchema.safeParse({ a: 1 }).success).toBe(false);
    expect(settingValueSchema.safeParse([1, 2]).success).toBe(false);
  });
});

describe('settingKeySchema', () => {
  it('接受白名单内的 key', () => {
    expect(settingKeySchema.safeParse('tg_bot_token').success).toBe(true);
    expect(settingKeySchema.safeParse('alert_cooldown_hours').success).toBe(true);
  });

  it('拒绝白名单外的 key', () => {
    expect(settingKeySchema.safeParse('__test_unknown_key').success).toBe(false);
  });
});

describe('settingsMapSchema 边界值', () => {
  it('timezone / ua 不能为空字符串', () => {
    expect(settingsMapSchema.safeParse({ timezone: '' }).success).toBe(false);
    expect(settingsMapSchema.safeParse({ ua: '' }).success).toBe(false);
    expect(settingsMapSchema.safeParse({ timezone: 'Asia/Shanghai', ua: 'x' }).success).toBe(true);
  });

  it('feishu_webhook_url 允许合法 URL / 空串 / null', () => {
    expect(settingsMapSchema.safeParse({ feishu_webhook_url: 'https://example.com/hook' }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ feishu_webhook_url: '' }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ feishu_webhook_url: null }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ feishu_webhook_url: 'not-a-url' }).success).toBe(false);
  });

  it('max_retries 取值范围 0..5', () => {
    expect(settingsMapSchema.safeParse({ max_retries: 0 }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ max_retries: 5 }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ max_retries: 6 }).success).toBe(false);
    expect(settingsMapSchema.safeParse({ max_retries: -1 }).success).toBe(false);
  });

  it('alert_cooldown_hours 取值范围 0..720', () => {
    expect(settingsMapSchema.safeParse({ alert_cooldown_hours: 0 }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ alert_cooldown_hours: 720 }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ alert_cooldown_hours: 721 }).success).toBe(false);
  });

  it('request_timeout_ms 必须为正整数且不超过 120000', () => {
    expect(settingsMapSchema.safeParse({ request_timeout_ms: 1 }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ request_timeout_ms: 120_000 }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ request_timeout_ms: 0 }).success).toBe(false);
    expect(settingsMapSchema.safeParse({ request_timeout_ms: 120_001 }).success).toBe(false);
    expect(settingsMapSchema.safeParse({ request_timeout_ms: 1.5 }).success).toBe(false);
  });

  it('doh_enabled 必须是布尔值', () => {
    expect(settingsMapSchema.safeParse({ doh_enabled: false }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ doh_enabled: 'yes' }).success).toBe(false);
  });

  it('doh_bypass 必须是字符串数组', () => {
    expect(settingsMapSchema.safeParse({ doh_bypass: ['__test_host'] }).success).toBe(true);
    expect(settingsMapSchema.safeParse({ doh_bypass: [1] }).success).toBe(false);
  });
});

describe('coinSchema 边界值', () => {
  const validCoin = {
    symbol: 'BTC',
    name: '比特币',
    gate_pair: 'BTC_USDT',
    cg_id: 'bitcoin',
  };

  it('gate_pair 可为 null，gate_slug 可缺省', () => {
    expect(coinSchema.safeParse({ ...validCoin, gate_pair: null }).success).toBe(true);
    expect(coinSchema.safeParse({ ...validCoin, gate_slug: null }).success).toBe(true);
  });

  it('symbol 长度上限 16 且只能大写字母数字', () => {
    expect(coinSchema.safeParse({ ...validCoin, symbol: 'A'.repeat(16) }).success).toBe(true);
    expect(coinSchema.safeParse({ ...validCoin, symbol: 'A'.repeat(17) }).success).toBe(false);
    expect(coinSchema.safeParse({ ...validCoin, symbol: 'BTC-TEST' }).success).toBe(false);
  });

  it('name 长度上限 64', () => {
    expect(coinSchema.safeParse({ ...validCoin, name: 'x'.repeat(64) }).success).toBe(true);
    expect(coinSchema.safeParse({ ...validCoin, name: 'x'.repeat(65) }).success).toBe(false);
  });

  it('gate_slug 只允许小写字母数字与连字符', () => {
    expect(coinSchema.safeParse({ ...validCoin, gate_slug: 'btc-usdt' }).success).toBe(true);
    expect(coinSchema.safeParse({ ...validCoin, gate_slug: 'BTC_USDT' }).success).toBe(false);
    expect(coinSchema.safeParse({ ...validCoin, gate_slug: '' }).success).toBe(false);
  });

  it('binance_pair 长度 3..32 且格式为 XXX_YYY', () => {
    expect(coinSchema.safeParse({ ...validCoin, binance_pair: 'BTCUSDT' }).success).toBe(false);
    expect(coinSchema.safeParse({ ...validCoin, binance_pair: 'BTC_USDT' }).success).toBe(true);
    expect(coinSchema.safeParse({ ...validCoin, binance_pair: 'B_' }).success).toBe(false); // 长度不足 3
    expect(coinSchema.safeParse({ ...validCoin, binance_pair: `${'A'.repeat(31)}_USDT` }).success).toBe(false); // 超长
  });

  it('sort_order / enabled 有默认值', () => {
    const r = coinSchema.safeParse(validCoin);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.sort_order).toBe(0);
      expect(r.data.enabled).toBe(true);
    }
  });

  it('sort_order 必须是非负整数', () => {
    expect(coinSchema.safeParse({ ...validCoin, sort_order: -1 }).success).toBe(false);
    expect(coinSchema.safeParse({ ...validCoin, sort_order: 1.5 }).success).toBe(false);
  });

  it('alert_above / alert_below 必须是正数或 null', () => {
    expect(coinSchema.safeParse({ ...validCoin, alert_above: 100 }).success).toBe(true);
    expect(coinSchema.safeParse({ ...validCoin, alert_below: null }).success).toBe(true);
    expect(coinSchema.safeParse({ ...validCoin, alert_above: 0 }).success).toBe(false);
    expect(coinSchema.safeParse({ ...validCoin, alert_below: -1 }).success).toBe(false);
  });
});

describe('reorderSchema', () => {
  it('至少一个正整数 id', () => {
    expect(reorderSchema.safeParse({ ids: [1, 2] }).success).toBe(true);
    expect(reorderSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(reorderSchema.safeParse({ ids: [0] }).success).toBe(false);
    expect(reorderSchema.safeParse({ ids: [1.5] }).success).toBe(false);
  });
});

describe('reportDeleteBatchSchema', () => {
  it('至少一个正整数 id', () => {
    expect(reportDeleteBatchSchema.safeParse({ ids: [1] }).success).toBe(true);
    expect(reportDeleteBatchSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(reportDeleteBatchSchema.safeParse({ ids: [-1] }).success).toBe(false);
  });

  it('拒绝未知字段', () => {
    expect(reportDeleteBatchSchema.safeParse({ ids: [1], extra: 1 }).success).toBe(false);
  });
});

describe('loginSchema / passwordChangeSchema 边界值', () => {
  it('username 长度 1..64，password 长度 1..128', () => {
    expect(loginSchema.safeParse({ username: 'x'.repeat(64), password: 'y'.repeat(128) }).success).toBe(true);
    expect(loginSchema.safeParse({ username: 'x'.repeat(65), password: 'p' }).success).toBe(false);
    expect(loginSchema.safeParse({ username: 'u', password: 'y'.repeat(129) }).success).toBe(false);
  });

  it('newPassword 上限 128', () => {
    expect(passwordChangeSchema.safeParse({ oldPassword: 'a', newPassword: 'x'.repeat(128) }).success).toBe(true);
    expect(passwordChangeSchema.safeParse({ oldPassword: 'a', newPassword: 'x'.repeat(129) }).success).toBe(false);
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

  it('schema 校验失败但没有具体 issue → 回落到通用失败文案', () => {
    // 构造一个 safeParse 返回空 issues 的 schema，验证 parseJson 的兜底分支
    const stubSchema = {
      safeParse: () => ({ success: false, error: { issues: [] } }),
    } as unknown as z.ZodType<unknown>;
    const r = parseJson(stubSchema, '{}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('validation failed');
  });

  it('校验失败的 error 文案包含字段路径', () => {
    const r = parseJson(passwordChangeSchema, JSON.stringify({ oldPassword: 'a', newPassword: 'short' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('newPassword');
  });
});