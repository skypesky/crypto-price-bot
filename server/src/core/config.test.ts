import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDb, closeDb } from './db.js';
import { initDefaults, setManySettings } from './models/setting.js';
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