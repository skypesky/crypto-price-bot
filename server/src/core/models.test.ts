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
    CREATE TABLE coins (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT UNIQUE NOT NULL, name TEXT NOT NULL, gate_pair TEXT, gate_slug TEXT, cg_id TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
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
    expect(all.schedule_rule).toBe('0 */30 * * * *');
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
    expect(list.length).toBe(13);
    expect(list[0]?.symbol).toBe('BTC');
  });

  // gate.com slug 回归测试：
  // - BNB 旧 slug 'binancecoin' 已被 gate.com 改路由，现在会劫持到狗头页面。新 slug 必须是 'bnb'。
  // - FIL 旧 slug 'filecoin' 同样被劫持，新 slug 必须是 'filecoinipfs'（在 /zh/trade/FIL_USDT 页脚可找到官方链接）。
  it.each([
    ['BNB', 'bnb'],
    ['FIL', 'filecoinipfs'],
  ])('%s 默认 gate_slug 是 %s（不是已失效的旧 slug）', (symbol, expectedSlug) => {
    const found = coin.DEFAULT_COINS.find((c) => c.symbol === symbol);
    expect(found).toBeDefined();
    expect(found!.gate_slug).toBe(expectedSlug);
    // 反向断言：防止回退到已知坏 slug
    expect(found!.gate_slug).not.toBe('binancecoin');
    expect(found!.gate_slug).not.toBe('filecoin');
  });

  // 新增监控币种：YGG (Yield Guild Games) 和 SAGA
  // - gate.com 链接已实测可达：/zh/price/yieldguildgames-ygg / /zh/price/saga-saga
  // - gate.io USDT 交易对均存在且 tradable
  // - CoinGecko ID 通过官方搜索 API 确认
  it.each([
    ['YGG',  'Yield Guild Games', 'YGG_USDT',  'yieldguildgames', 'yield-guild-games'],
    ['SAGA', 'Saga',              'SAGA_USDT', 'saga',            'saga-2'],
  ])('%s 已纳入默认监控且各字段正确', (symbol, name, gatePair, slug, cgId) => {
    const found = coin.DEFAULT_COINS.find((c) => c.symbol === symbol);
    expect(found, `缺少 ${symbol}`).toBeDefined();
    expect(found!.name).toBe(name);
    expect(found!.gate_pair).toBe(gatePair);
    expect(found!.gate_slug).toBe(slug);
    expect(found!.cg_id).toBe(cgId);
    expect(found!.enabled).toBe(1);
  });

  it('CRUD', () => {
    const c = coin.createCoin({
      symbol: 'TEST', name: '测试币', gate_pair: 'TEST_USDT', gate_slug: 'test', cg_id: 'test', sort_order: 99, enabled: 1,
    });
    expect(c.id).toBeGreaterThan(0);
    expect(c.gate_slug).toBe('test');
    const updated = coin.updateCoin(c.id, { name: '改名', gate_slug: 'renamed' });
    expect(updated?.name).toBe('改名');
    expect(updated?.gate_slug).toBe('renamed');
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