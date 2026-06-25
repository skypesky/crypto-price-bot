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
    expect(c.schedule_rule).toBe('0 */30 * * * *');
    expect(c.usdt_to_cny).toBe(7.20);
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
    setManySettings({ usdt_to_cny: 7.5, doh_enabled: false, doh_bypass: ['a.com', 'b.com'] });
    const c = loadConfig();
    expect(c.usdt_to_cny).toBe(7.5);
    expect(c.doh_enabled).toBe(false);
    expect(c.doh_bypass).toEqual(['a.com', 'b.com']);
  });

  it('getConfig 返回单例', () => {
    const a = getConfig();
    const b = getConfig();
    expect(a).toBe(b);
  });
});