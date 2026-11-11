import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { setDb, closeDb } from './db.js';
import { initDefaults, setManySettings, setSetting } from './models/setting.js';
import { loadConfig, getConfig, reloadConfig, onConfigChange } from './config.js';

let customDb: Database.Database;

beforeAll(() => {
  customDb = new Database(':memory:');
  customDb.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  setDb(customDb);
});

afterAll(() => {
  customDb.close();
  closeDb();
});

beforeEach(() => {
  // 重置 settings 表
  customDb.exec('DELETE FROM settings');
  initDefaults();
});

describe('config', () => {
  it('loadConfig 使用默认', () => {
    const c = loadConfig();
    expect(c.timezone).toBe('Asia/Shanghai');
    expect(c.schedule_rule).toBe('0 */10 * * * *');
  });

  it('DB 写入后 reloadConfig 拿到新值', () => {
    setManySettings({ timezone: 'UTC', schedule_rule: '0 0 18 * * *' });
    const c = reloadConfig();
    expect(c.timezone).toBe('UTC');
    expect(c.schedule_rule).toBe('0 0 18 * * *');
  });

  it('env 覆盖 DB', () => {
    setManySettings({ timezone: 'UTC' });
    process.env.TIMEZONE = 'Europe/London';
    const c = loadConfig();
    expect(c.timezone).toBe('Europe/London');
    delete process.env.TIMEZONE;
  });

  it('onConfigChange 触发回调', () => {
    const calls: number[] = [];
    const off = onConfigChange(() => calls.push(Date.now()));
    setManySettings({ timezone: 'Asia/Tokyo' });
    reloadConfig();
    expect(calls.length).toBe(1);
    off();
    reloadConfig();
    expect(calls.length).toBe(1);
  });

  it('数字/布尔/数组字段类型正确', () => {
    setManySettings({ doh_enabled: false, doh_bypass: ['a.com', 'b.com'], max_retries: 3 });
    const c = loadConfig();
    expect(c.max_retries).toBe(3);
    expect(c.doh_enabled).toBe(false);
    expect(c.doh_bypass).toEqual(['a.com', 'b.com']);
  });

  it('getConfig 返回单例', () => {
    const a = getConfig();
    const b = getConfig();
    expect(a).toBe(b);
  });
});

describe('Config feishu Bot fields', () => {
  beforeEach(() => {
    // 清空相关 env，避免污染
    delete process.env['FEISHU_APP_ID'];
    delete process.env['FEISHU_APP_SECRET'];
    delete process.env['FEISHU_ENCRYPT_KEY'];
    delete process.env['FEISHU_VERIFICATION_TOKEN'];
    delete process.env['FEISHU_DEFAULT_RECEIVE_ID'];
    delete process.env['FEISHU_DEFAULT_RECEIVE_ID_TYPE'];
  });

  it('env 缺失时所有 feishu Bot 字段都是 null/默认', () => {
    const c = loadConfig();
    expect(c.feishu_app_id).toBeNull();
    expect(c.feishu_app_secret).toBeNull();
    expect(c.feishu_encrypt_key).toBeNull();
    expect(c.feishu_verification_token).toBeNull();
    expect(c.feishu_default_receive_id).toBeNull();
    expect(c.feishu_default_receive_id_type).toBe('chat_id');
  });

  it('env 提供时字段被正确读取', () => {
    process.env['FEISHU_APP_ID'] = 'cli_test';
    process.env['FEISHU_APP_SECRET'] = 'secret_test';
    process.env['FEISHU_ENCRYPT_KEY'] = 'encrypt_test';
    process.env['FEISHU_VERIFICATION_TOKEN'] = 'token_test';
    process.env['FEISHU_DEFAULT_RECEIVE_ID'] = 'oc_test';
    process.env['FEISHU_DEFAULT_RECEIVE_ID_TYPE'] = 'open_id';
    const c = loadConfig();
    expect(c.feishu_app_id).toBe('cli_test');
    expect(c.feishu_app_secret).toBe('secret_test');
    expect(c.feishu_encrypt_key).toBe('encrypt_test');
    expect(c.feishu_verification_token).toBe('token_test');
    expect(c.feishu_default_receive_id).toBe('oc_test');
    expect(c.feishu_default_receive_id_type).toBe('open_id');
  });

  it('receive_id_type 不是 4 选 1 时默认 chat_id', () => {
    process.env['FEISHU_DEFAULT_RECEIVE_ID_TYPE'] = 'invalid_value';
    const c = loadConfig();
    expect(c.feishu_default_receive_id_type).toBe('chat_id');
  });
});

describe('config 字段类型转换与非法值回退', () => {
  afterEach(() => {
    delete process.env['TIMEZONE'];
    delete process.env['CUSTOM_USER_AGENT'];
  });

  it('布尔字段：字符串 "true" 解析为 true', () => {
    setSetting('doh_enabled', 'true');
    expect(loadConfig().doh_enabled).toBe(true);
  });

  it('布尔字段：字符串 "1" 解析为 true', () => {
    setSetting('doh_enabled', '1');
    expect(loadConfig().doh_enabled).toBe(true);
  });

  it('布尔字段：其它字符串解析为 false', () => {
    setSetting('doh_enabled', 'yes');
    expect(loadConfig().doh_enabled).toBe(false);
  });

  it('布尔字段：值为 null 时回退默认值', () => {
    setSetting('doh_enabled', null);
    expect(loadConfig().doh_enabled).toBe(true);
  });

  it('数字字段：字符串数字被解析为 number', () => {
    setSetting('max_retries', '5');
    expect(loadConfig().max_retries).toBe(5);
  });

  it('数字字段：非数字字符串回退默认值', () => {
    setSetting('max_retries', 'abc');
    expect(loadConfig().max_retries).toBe(1);
  });

  it('数字字段：值为 null 时回退默认值', () => {
    setSetting('request_timeout_ms', null);
    setSetting('alert_cooldown_hours', null);
    const c = loadConfig();
    expect(c.request_timeout_ms).toBe(15000);
    expect(c.alert_cooldown_hours).toBe(24);
  });

  it('数字字段：正常数字原样保留', () => {
    setSetting('request_timeout_ms', 3000);
    expect(loadConfig().request_timeout_ms).toBe(3000);
  });

  it('数组字段：逗号分隔字符串被拆分并去掉空项', () => {
    setSetting('doh_bypass', 'a.com, b.com ,,c.com');
    expect(loadConfig().doh_bypass).toEqual(['a.com', 'b.com', 'c.com']);
  });

  it('数组字段：值为 null 时回退默认数组', () => {
    setSetting('doh_bypass', null);
    expect(loadConfig().doh_bypass).toEqual(['1.1.1.1', 'one.one.one.one', 'cloudflare-dns.com']);
  });

  it('数组字段：已是数组时原样保留', () => {
    setSetting('doh_bypass', ['x.com']);
    expect(loadConfig().doh_bypass).toEqual(['x.com']);
  });
});

describe('config 时区处理', () => {
  afterEach(() => {
    delete process.env['TIMEZONE'];
    delete process.env['CUSTOM_USER_AGENT'];
  });

  it('DB 中的 timezone 覆盖默认时区', () => {
    setSetting('timezone', 'America/New_York');
    expect(loadConfig().timezone).toBe('America/New_York');
  });

  it('env TIMEZONE 的优先级高于 DB', () => {
    setSetting('timezone', 'America/New_York');
    process.env['TIMEZONE'] = 'Europe/Paris';
    expect(loadConfig().timezone).toBe('Europe/Paris');
  });

  it('env TIMEZONE 为空字符串时被忽略，回落到 DB 值', () => {
    setSetting('timezone', 'UTC');
    process.env['TIMEZONE'] = '';
    expect(loadConfig().timezone).toBe('UTC');
  });

  it('DB 中 timezone 为 null 时回退默认时区', () => {
    setSetting('timezone', null);
    expect(loadConfig().timezone).toBe('Asia/Shanghai');
  });

  it('env CUSTOM_USER_AGENT 覆盖 UA 默认值', () => {
    process.env['CUSTOM_USER_AGENT'] = 'my-agent/1.0';
    expect(loadConfig().ua).toBe('my-agent/1.0');
  });
});

describe('config 空值回退默认值', () => {
  it('schedule_rule 为 null 时回退默认 cron 表达式', () => {
    setSetting('schedule_rule', null);
    expect(loadConfig().schedule_rule).toBe('0 */10 * * * *');
  });

  it('ua 为 null 时回退默认 UA', () => {
    delete process.env['CUSTOM_USER_AGENT'];
    setSetting('ua', null);
    expect(loadConfig().ua).toContain('Mozilla/5.0');
  });

  it('doh_server 为 null 时回退默认 DNS', () => {
    setSetting('doh_server', null);
    expect(loadConfig().doh_server).toBe('1.1.1.1');
  });

  it('token 类字段为 null 时保持 null', () => {
    setSetting('tg_bot_token', null);
    setSetting('tg_chat_id', null);
    const c = loadConfig();
    expect(c.tg_bot_token).toBeNull();
    expect(c.tg_chat_id).toBeNull();
  });

  it('token 类字段有值时原样返回', () => {
    setSetting('tg_bot_token', 'token-abc');
    setSetting('tg_chat_id', 'chat-123');
    const c = loadConfig();
    expect(c.tg_bot_token).toBe('token-abc');
    expect(c.tg_chat_id).toBe('chat-123');
  });
});

describe('config 热重载与监听器', () => {
  it('reloadConfig 会把新配置通知给所有监听器', () => {
    const seen: string[] = [];
    const off1 = onConfigChange((c) => seen.push(`a:${c.timezone}`));
    const off2 = onConfigChange((c) => seen.push(`b:${c.timezone}`));
    setSetting('timezone', 'UTC');
    reloadConfig();
    expect(seen).toEqual(['a:UTC', 'b:UTC']);
    off1();
    off2();
  });

  it('监听器抛错时被吞掉，不影响其它监听器与返回值', () => {
    const seen: string[] = [];
    const off1 = onConfigChange(() => { throw new Error('监听器炸了'); });
    const off2 = onConfigChange((c) => seen.push(c.timezone));
    setSetting('timezone', 'UTC');
    const c = reloadConfig();
    expect(seen).toEqual(['UTC']);
    expect(c.timezone).toBe('UTC');
    off1();
    off2();
  });

  it('取消订阅后监听器不再被调用', () => {
    let calls = 0;
    const off = onConfigChange(() => { calls += 1; });
    reloadConfig();
    expect(calls).toBe(1);
    off();
    reloadConfig();
    expect(calls).toBe(1);
  });

  it('reloadConfig 之后 getConfig 返回的是同一份新配置', () => {
    setSetting('timezone', 'UTC');
    const c = reloadConfig();
    expect(getConfig()).toBe(c);
    expect(getConfig().timezone).toBe('UTC');
  });

  it('getConfig 首次调用时才懒加载配置', async () => {
    // 用全新的模块实例，确保 _config 缓存为空
    vi.resetModules();
    const dbMod = await import('./db.js');
    dbMod.setDb(customDb);
    const cfgMod = await import('./config.js');
    const c1 = cfgMod.getConfig();
    const c2 = cfgMod.getConfig();
    expect(c1).toBe(c2);
    expect(c1.timezone).toBe('Asia/Shanghai');
  });
});