import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setDb, closeDb } from './db.js';
import * as user from './models/user.js';
import * as session from './models/session.js';
import * as setting from './models/setting.js';
import * as coin from './models/coin.js';
import * as report from './models/report.js';

let customDb: Database.Database;

beforeAll(() => {
  customDb = new Database(':memory:');
  customDb.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE coins (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT UNIQUE NOT NULL, name TEXT NOT NULL, gate_pair TEXT, cg_id TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE reports (id INTEGER PRIMARY KEY AUTOINCREMENT, triggered_by TEXT NOT NULL, success INTEGER NOT NULL, total_coins INTEGER NOT NULL, ok_coins INTEGER NOT NULL, tg_sent INTEGER NOT NULL, feishu_sent INTEGER NOT NULL, message TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  setDb(customDb);
});

afterAll(() => {
  customDb.close();
  closeDb();
});

describe('user model', () => {
  it('create + verify', async () => {
    const u = await user.createUser('alice', 'secret123');
    expect(u.id).toBeGreaterThan(0);
    expect(u.username).toBe('alice');
    const found = await user.findByUsername('alice');
    expect(found?.id).toBe(u.id);
  });

  it('verifyLogin 正确账密', async () => {
    expect(await user.verifyLogin('alice', 'secret123')).not.toBeNull();
    expect(await user.verifyLogin('alice', 'wrong')).toBeNull();
  });

  it('changePassword 校验旧密', async () => {
    const u = await user.findByUsername('alice');
    expect(await user.changePassword(u!.id, 'wrong', 'newpass1')).toBe(false);
    expect(await user.changePassword(u!.id, 'secret123', 'newpass1')).toBe(true);
    expect(await user.verifyLogin('alice', 'newpass1')).not.toBeNull();
  });
});

describe('session model', () => {
  it('create + find + delete', async () => {
    const u = await user.findByUsername('alice');
    const s = session.createSession(u!.id);
    expect(findValidSync(s.token)).not.toBeNull();
    session.deleteSession(s.token);
    expect(findValidSync(s.token)).toBeNull();
  });
});

function findValidSync(token: string) {
  return session.findValidSession(token);
}

describe('setting model', () => {
  it('initDefaults + getAllSettings', () => {
    setting.initDefaults();
    const all = setting.getAllSettings();
    expect(all.timezone).toBe('Asia/Shanghai');
    expect(all.schedule_rule).toBe('0 0 9 * * *');
  });

  it('setMany 覆盖', () => {
    setting.setManySettings({ timezone: 'UTC', usdt_to_cny: 7.5 });
    expect(setting.getSetting('timezone')).toBe('UTC');
    expect(setting.getSetting('usdt_to_cny')).toBe(7.5);
  });
});

describe('coin model', () => {
  it('initDefaultCoins + list', () => {
    coin.initDefaultCoins();
    const list = coin.listCoins();
    expect(list.length).toBe(11);
    expect(list[0]?.symbol).toBe('BTC');
  });

  it('CRUD', () => {
    const c = coin.createCoin({
      symbol: 'TEST', name: '测试币', gate_pair: 'TEST_USDT', cg_id: 'test', sort_order: 99, enabled: 1,
    });
    expect(c.id).toBeGreaterThan(0);
    const updated = coin.updateCoin(c.id, { name: '改名' });
    expect(updated?.name).toBe('改名');
    expect(coin.deleteCoin(c.id)).toBe(true);
  });

  it('reorderCoins 重新排序', () => {
    const list = coin.listCoins();
    const reversed = list.slice().reverse().map(c => c.id);
    coin.reorderCoins(reversed);
    const after = coin.listCoins();
    expect(after[0]?.id).toBe(reversed[0]);
  });
});

describe('report model', () => {
  it('create + list + lastReport', () => {
    const r = report.createReport({
      triggered_by: 'cron',
      success: true,
      total_coins: 11,
      ok_coins: 10,
      tg_sent: true,
      feishu_sent: true,
      message: 'msg',
      summary: { a: 1 },
    });
    expect(r.id).toBeGreaterThan(0);
    expect(report.listReports(10).length).toBeGreaterThan(0);
    expect(report.lastReport()?.id).toBe(r.id);
  });
});