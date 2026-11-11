import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDb, closeDb, getDb } from './db.js';
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
    CREATE TABLE coins (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT UNIQUE NOT NULL, name TEXT NOT NULL, gate_pair TEXT, gate_slug TEXT, binance_pair TEXT, cg_id TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, alert_above REAL, alert_below REAL, last_price REAL, last_alert_at INTEGER NOT NULL DEFAULT 0, last_alert_dir TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
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
    const u = await user.createUser('__test_alice', 'secret123');
    expect(u.id).toBeGreaterThan(0);
    expect(u.username).toBe('__test_alice');
    const found = await user.findByUsername('__test_alice');
    expect(found?.id).toBe(u.id);
  });

  it('verifyLogin 正确账密', async () => {
    expect(await user.verifyLogin('__test_alice', 'secret123')).not.toBeNull();
    expect(await user.verifyLogin('__test_alice', 'wrong')).toBeNull();
  });

  it('changePassword 校验旧密', async () => {
    const u = await user.findByUsername('__test_alice');
    expect(await user.changePassword(u!.id, 'wrong', 'newpass1')).toBe(false);
    expect(await user.changePassword(u!.id, 'secret123', 'newpass1')).toBe(true);
    expect(await user.verifyLogin('__test_alice', 'newpass1')).not.toBeNull();
  });
});

describe('session model', () => {
  it('create + find + delete', async () => {
    const u = await user.findByUsername('__test_alice');
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
    expect(all.schedule_rule).toBe('0 */10 * * * *');
  });

  it('setMany 覆盖', () => {
    setting.setManySettings({ timezone: 'UTC', max_retries: 3 });
    expect(setting.getSetting('timezone')).toBe('UTC');
    expect(setting.getSetting('max_retries')).toBe(3);
  });

  it('initDefaults 迁移：存量 schedule_rule=旧的 */30 自动升级到 */10', () => {
    // 模拟存量 DB：schedule_rule 是旧默认值
    setting.setManySettings({ schedule_rule: '0 */30 * * * *' });
    expect(setting.getSetting('schedule_rule')).toBe('0 */30 * * * *');
    // 重跑 initDefaults 应自动迁移
    setting.initDefaults();
    expect(setting.getSetting('schedule_rule')).toBe('0 */10 * * * *');
  });

  it('initDefaults 迁移：用户自定义值不被覆盖', () => {
    setting.setManySettings({ schedule_rule: '0 0 9 * * *' });
    setting.initDefaults();
    expect(setting.getSetting('schedule_rule')).toBe('0 0 9 * * *');
  });
});

describe('coin model', () => {
  it('initDefaultCoins + list', () => {
    coin.initDefaultCoins();
    const list = coin.listCoins();
    expect(list.length).toBe(11);
    // QNT 是用户主要买卖的币 → 默认排在第一个
    expect(list[0]?.symbol).toBe('QNT');
  });

  // 新增监控币种：QNT (Quant) —— 用户主要买卖的币，排在列表第一位
  // - gate.io 现货 QNT_USDT 与永续合约 QNT_USDT 均存在
  // - 币安现货有 QNT_USDT 交易对
  it('QNT 已纳入默认监控、字段正确且排第一位', () => {
    const found = coin.DEFAULT_COINS.find((c) => c.symbol === 'QNT');
    expect(found, '缺少 QNT').toBeDefined();
    expect(found!.name).toBe('Quant');
    expect(found!.gate_pair).toBe('QNT_USDT');
    expect(found!.gate_slug).toBe('quant');
    expect(found!.binance_pair).toBe('QNT_USDT');
    expect(found!.cg_id).toBe('quant-network');
    expect(found!.enabled).toBe(1);
    expect(found!.sort_order).toBe(0);
  });

  // gate.com slug 回归测试：
  // - BNB 旧 slug 'binancecoin' 已被 gate.com 改路由，现在会劫持到狗头页面。新 slug 必须是 'bnb'。
  it.each([
    ['BNB', 'bnb'],
  ])('%s 默认 gate_slug 是 %s（不是已失效的旧 slug）', (symbol, expectedSlug) => {
    const found = coin.DEFAULT_COINS.find((c) => c.symbol === symbol);
    expect(found).toBeDefined();
    expect(found!.gate_slug).toBe(expectedSlug);
    // 反向断言：防止回退到已知坏 slug
    expect(found!.gate_slug).not.toBe('binancecoin');
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

  // 新增监控币种：HYPE (Hyperliquid)
  // - gate.io USDT 交易对实测存在且 tradable，1d K 线有 400 根（够算 MA365）
  // - 币安现货有 HYPE_USDT 交易对（/zh-CN/trade/HYPE_USDT?type=spot）
  // - CoinGecko ID 通过官方 API 确认（id=hyperliquid, symbol=hype）
  it('HYPE 已纳入默认监控且各字段正确', () => {
    const found = coin.DEFAULT_COINS.find((c) => c.symbol === 'HYPE');
    expect(found, '缺少 HYPE').toBeDefined();
    expect(found!.name).toBe('Hyperliquid');
    expect(found!.gate_pair).toBe('HYPE_USDT');
    expect(found!.gate_slug).toBe('hyperliquid');
    expect(found!.binance_pair).toBe('HYPE_USDT');
    expect(found!.cg_id).toBe('hyperliquid');
    expect(found!.enabled).toBe(1);
  });

  // binance_pair 回归测试（币安现货交易对）：
  // - 只列币安现货确实有 USDT 交易对的币
  // - USDT / ABT / GT 币安现货没有对应交易对 → 必须为 null（不显示币安链接）
  it.each([
    ['BTC',  'BTC_USDT'],
    ['ETH',  'ETH_USDT'],
    ['SOL',  'SOL_USDT'],
    ['BNB',  'BNB_USDT'],
    ['YGG',  'YGG_USDT'],
    ['SAGA', 'SAGA_USDT'],
  ])('%s 默认 binance_pair = %s', (symbol, expectedPair) => {
    const found = coin.DEFAULT_COINS.find((c) => c.symbol === symbol);
    expect(found).toBeDefined();
    expect(found!.binance_pair).toBe(expectedPair);
  });

  it.each(['USDT', 'ABT', 'GT'])('%s 默认 binance_pair 为 null（币安现货没有该交易对）', (symbol) => {
    const found = coin.DEFAULT_COINS.find((c) => c.symbol === symbol);
    expect(found).toBeDefined();
    expect(found!.binance_pair).toBeNull();
  });

  it('CRUD', () => {
    const c = coin.createCoin({
      symbol: 'TEST', name: '测试币', gate_pair: 'TEST_USDT', gate_slug: 'test', binance_pair: 'TEST_USDT', cg_id: 'test', sort_order: 99, enabled: 1,
    });
    expect(c.id).toBeGreaterThan(0);
    expect(c.gate_slug).toBe('test');
    expect(c.binance_pair).toBe('TEST_USDT');
    const updated = coin.updateCoin(c.id, { name: '改名', gate_slug: 'renamed', binance_pair: null });
    expect(updated?.name).toBe('改名');
    expect(updated?.gate_slug).toBe('renamed');
    expect(updated?.binance_pair).toBeNull();
    expect(coin.deleteCoin(c.id)).toBe(true);
  });

  // 存量库补插：老实例的 coins 表里没有"后加进默认清单"的币，
  // 必须在启动时补上，否则用户升级后报告里依然看不到这个币。
  describe('syncAddedDefaultCoins', () => {
    // 每个用例都从"存量库缺 HYPE"的已知状态开始，用例结束恢复 HYPE，
    // 这样本块不依赖文件内的执行顺序（任意顺序 / shuffle 跑都成立）。
    beforeEach(() => {
      getDb().prepare(`DELETE FROM coins WHERE symbol = 'HYPE'`).run();
    });

    afterEach(() => {
      coin.syncAddedDefaultCoins();
    });

    it('存量库缺 HYPE → 补插一条完整的默认行', () => {
      expect(coin.listCoins().some(c => c.symbol === 'HYPE')).toBe(false);

      coin.syncAddedDefaultCoins();

      const hype = coin.listCoins().find(c => c.symbol === 'HYPE');
      expect(hype).toBeDefined();
      expect(hype!.name).toBe('Hyperliquid');
      expect(hype!.gate_pair).toBe('HYPE_USDT');
      expect(hype!.gate_slug).toBe('hyperliquid');
      expect(hype!.binance_pair).toBe('HYPE_USDT');
      expect(hype!.cg_id).toBe('hyperliquid');
      expect(hype!.enabled).toBe(1);
    });

    it('补插的币排在列表末尾（sort_order 取当前最大值 +1）', () => {
      coin.syncAddedDefaultCoins();

      const list = coin.listCoins();
      const hype = list.find(c => c.symbol === 'HYPE')!;
      const maxOther = Math.max(...list.filter(c => c.symbol !== 'HYPE').map(c => c.sort_order));
      expect(hype.sort_order).toBeGreaterThan(maxOther);
    });

    it('幂等：重复调用不会产生重复行', () => {
      coin.syncAddedDefaultCoins();
      coin.syncAddedDefaultCoins();
      expect(coin.listCoins().filter(c => c.symbol === 'HYPE').length).toBe(1);
    });

    it('用户已有的 HYPE 行不被覆盖（保留改过的名称/阈值/启停）', () => {
      coin.syncAddedDefaultCoins();
      const hype = coin.listCoins().find(c => c.symbol === 'HYPE')!;
      coin.updateCoin(hype.id, { name: '我的HYPE', enabled: 0, alert_above: 999 });

      coin.syncAddedDefaultCoins();

      const after = coin.findCoinById(hype.id)!;
      expect(after.name).toBe('我的HYPE');
      expect(after.enabled).toBe(0);
      expect(after.alert_above).toBe(999);
    });

    it('置顶币 QNT：存量库缺 QNT → 补插后排在列表最前', () => {
      getDb().prepare(`DELETE FROM coins WHERE symbol = 'QNT'`).run();
      expect(coin.listCoins().some(c => c.symbol === 'QNT')).toBe(false);

      coin.syncAddedDefaultCoins();

      const list = coin.listCoins();
      expect(list[0]?.symbol).toBe('QNT');
      // 其余币的相对顺序不变（QNT 只是插到最前，没有打乱别人）
      const rest = list.filter(c => c.symbol !== 'QNT').map(c => c.symbol);
      expect(rest).toEqual(['BTC', 'ETH', 'USDT', 'SOL', 'ABT', 'BNB', 'GT', 'YGG', 'SAGA', 'HYPE']);
    });
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

// ===========================================================================
// 以下为增量补齐的用例：覆盖各模型 CRUD 的成功/失败路径、查询的过滤与排序
// 分支、部分字段更新、数值边界、类型校验与过期判定。
// 所有测试数据（账号名 / token / key / symbol）一律以 __test_ 前缀标识。
// ===========================================================================

describe('user model 补充', () => {
  it('findByUsername：用户不存在返回 null', async () => {
    expect(await user.findByUsername('__test_not_exist_user')).toBeNull();
  });

  it('findById：id 不存在返回 null', async () => {
    expect(await user.findById(999999)).toBeNull();
  });

  it('verifyLogin：用户不存在返回 null（拒绝登录）', async () => {
    expect(await user.verifyLogin('__test_not_exist_user', 'secret123')).toBeNull();
  });

  it('changePassword：用户不存在返回 false', async () => {
    expect(await user.changePassword(999999, 'old', 'new')).toBe(false);
  });

  it('createUser：用户名重复时抛唯一约束错误', async () => {
    // __test_alice 已存在，重复插入应被 UNIQUE 约束拒绝
    await expect(user.createUser('__test_alice', 'secret123')).rejects.toThrow(/UNIQUE constraint failed: users\.username/);
  });

  it('密码以哈希形式存储，不落明文', async () => {
    const u = await user.findByUsername('__test_alice');
    expect(u).not.toBeNull();
    expect(u!.password_hash).not.toContain('newpass1');
    // bcrypt 哈希以 $2 开头
    expect(u!.password_hash.startsWith('$2')).toBe(true);
  });

  it('countUsers：返回用户总数', async () => {
    const n = await user.countUsers();
    const row = getDb().prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
    expect(n).toBe(row.c);
    expect(n).toBeGreaterThan(0);
  });
});

describe('session model 补充', () => {
  it('findValidSession：token 为空字符串直接返回 null', () => {
    expect(session.findValidSession('')).toBeNull();
  });

  it('findValidSession：token 不存在返回 null', () => {
    expect(session.findValidSession('__test_not_exist_token')).toBeNull();
  });

  it('findValidSession：已过期的 session 判定为无效', async () => {
    const u = await user.findByUsername('__test_alice');
    const s = session.createSession(u!.id);
    // 把过期时间改到过去，模拟过期 session
    getDb().prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, s.token);
    expect(session.findValidSession(s.token)).toBeNull();
  });

  it('deleteUserSessions：只删除指定用户的 session，其他用户不受影响', async () => {
    const u1 = await user.createUser('__test_sess_user1', 'pw123456');
    const u2 = await user.createUser('__test_sess_user2', 'pw123456');
    const s1 = session.createSession(u1.id);
    const s2 = session.createSession(u1.id);
    const s3 = session.createSession(u2.id);

    session.deleteUserSessions(u1.id);

    expect(session.findValidSession(s1.token)).toBeNull();
    expect(session.findValidSession(s2.token)).toBeNull();
    // 另一个用户的 session 仍然有效
    expect(session.findValidSession(s3.token)).not.toBeNull();
    session.deleteSession(s3.token);
  });

  it('purgeExpired：只清理过期 session 并返回清理条数', async () => {
    const u = await user.createUser('__test_purge_user', 'pw123456');
    const expired = session.createSession(u.id);
    const alive = session.createSession(u.id);
    getDb().prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, expired.token);

    const expiredCount = (getDb().prepare('SELECT COUNT(*) as c FROM sessions WHERE expires_at <= ?')
      .get(Date.now()) as { c: number }).c;
    const n = session.purgeExpired();

    expect(n).toBe(expiredCount);
    expect(n).toBeGreaterThan(0);
    expect(session.findValidSession(expired.token)).toBeNull();
    // 未过期的 session 不受影响
    expect(session.findValidSession(alive.token)).not.toBeNull();
    // 再清理一次已经没有过期 session
    expect(session.purgeExpired()).toBe(0);
    session.deleteSession(alive.token);
  });
});

describe('setting model 补充', () => {
  it('setSetting：写入新 key 后可读回，同 key 再写则覆盖', () => {
    setting.setSetting('__test_key', 'v1');
    expect(setting.getSetting('__test_key')).toBe('v1');
    setting.setSetting('__test_key', 'v2');
    expect(setting.getSetting('__test_key')).toBe('v2');
  });

  it('setSetting/getSetting：各类型值原样往返', () => {
    setting.setSetting('__test_str', 'hello');
    setting.setSetting('__test_num', 42);
    setting.setSetting('__test_bool', true);
    setting.setSetting('__test_null', null);
    setting.setSetting('__test_arr', ['a', 'b']);

    expect(setting.getSetting('__test_str')).toBe('hello');
    expect(setting.getSetting('__test_num')).toBe(42);
    expect(setting.getSetting('__test_bool')).toBe(true);
    expect(setting.getSetting('__test_null')).toBeNull();
    expect(setting.getSetting('__test_arr')).toEqual(['a', 'b']);
  });

  it('getSetting：DB 中没有该行时回退到默认值', () => {
    // 删掉默认设置项的 DB 行，再读应回退到 DEFAULT_SETTINGS 的默认值
    getDb().prepare('DELETE FROM settings WHERE key = ?').run('doh_server');
    expect(setting.getSetting('doh_server')).toBe('1.1.1.1');
    // initDefaults 用 INSERT OR IGNORE 补回缺失行
    setting.initDefaults();
    expect(setting.getSetting('doh_server')).toBe('1.1.1.1');
  });

  it('getSetting：key 既不在 DB 也不在默认表里返回 undefined', () => {
    expect(setting.getSetting('__test_unknown_key')).toBeUndefined();
  });

  it('getSetting：值不是合法 JSON 时返回 null', () => {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('__test_broken', 'not-json', Date.now());
    expect(setting.getSetting('__test_broken')).toBeNull();
  });

  it('getAllSettings：含非法 JSON 行时该项为 null，其余正常解析', () => {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('__test_broken', 'not-json', Date.now());

    const all = setting.getAllSettings();
    expect(all.__test_broken).toBeNull();
    expect(all.__test_num).toBe(42);
    // 默认表里的每一项都应出现
    for (const k of Object.keys(setting.DEFAULT_SETTINGS)) {
      expect(all).toHaveProperty(k);
    }

    // 清理非法行，避免影响后续用例
    getDb().prepare('DELETE FROM settings WHERE key = ?').run('__test_broken');
  });

  it('setManySettings：批量写入多个 key', () => {
    setting.setManySettings({ __test_batch_a: 1, __test_batch_b: 'x', __test_batch_c: false });
    expect(setting.getSetting('__test_batch_a')).toBe(1);
    expect(setting.getSetting('__test_batch_b')).toBe('x');
    expect(setting.getSetting('__test_batch_c')).toBe(false);
  });
});

describe('coin model 补充', () => {
  it('initDefaultCoins：coins 表非空时直接返回，不重复插入', () => {
    const before = coin.listCoins().length;
    coin.initDefaultCoins();
    expect(coin.listCoins().length).toBe(before);
  });

  it('findCoinById：id 不存在返回 null', () => {
    expect(coin.findCoinById(999999)).toBeNull();
  });

  it('updateCoin：id 不存在返回 null', () => {
    expect(coin.updateCoin(999999, { name: '改名' })).toBeNull();
  });

  it('deleteCoin：删除不存在的 id 返回 false', () => {
    expect(coin.deleteCoin(999999)).toBe(false);
  });

  it('createCoin：symbol 重复时抛唯一约束错误', () => {
    const input = {
      symbol: '__TEST_DUP', name: '重复币', gate_pair: null, gate_slug: null,
      binance_pair: null, cg_id: '__test_dup', sort_order: 900, enabled: 1,
      alert_above: null, alert_below: null,
    };
    const c = coin.createCoin(input);
    expect(() => coin.createCoin(input)).toThrow(/UNIQUE constraint failed: coins\.symbol/);
    coin.deleteCoin(c.id);
  });

  it('updateCoin：只传部分字段时其余字段保持不变', () => {
    const c = coin.createCoin({
      symbol: '__TEST_PART', name: '原始名', gate_pair: 'P_USDT', gate_slug: 'p-slug',
      binance_pair: 'P_USDT', cg_id: 'p-cg', sort_order: 50, enabled: 1,
      alert_above: 10, alert_below: 1,
    });
    const updated = coin.updateCoin(c.id, { name: '新名字' });
    expect(updated!.name).toBe('新名字');
    // 未传的字段保持原值
    expect(updated!.symbol).toBe('__TEST_PART');
    expect(updated!.gate_pair).toBe('P_USDT');
    expect(updated!.gate_slug).toBe('p-slug');
    expect(updated!.binance_pair).toBe('P_USDT');
    expect(updated!.cg_id).toBe('p-cg');
    expect(updated!.sort_order).toBe(50);
    expect(updated!.enabled).toBe(1);
    expect(updated!.alert_above).toBe(10);
    expect(updated!.alert_below).toBe(1);
    coin.deleteCoin(c.id);
  });

  it('listEnabledCoins：只返回 enabled=1 的币，且按 sort_order 升序', () => {
    const on = coin.createCoin({
      symbol: '__TEST_ON', name: '启用币', gate_pair: null, gate_slug: null,
      binance_pair: null, cg_id: 'on-cg', sort_order: 900, enabled: 1,
      alert_above: null, alert_below: null,
    });
    const off = coin.createCoin({
      symbol: '__TEST_OFF', name: '停用币', gate_pair: null, gate_slug: null,
      binance_pair: null, cg_id: 'off-cg', sort_order: 901, enabled: 0,
      alert_above: null, alert_below: null,
    });

    const list = coin.listEnabledCoins();
    expect(list.every(c => c.enabled === 1)).toBe(true);
    expect(list.some(c => c.symbol === '__TEST_OFF')).toBe(false);
    expect(list.some(c => c.symbol === '__TEST_ON')).toBe(true);
    // 排序：sort_order 升序
    const orders = list.map(c => c.sort_order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));

    coin.deleteCoin(on.id);
    coin.deleteCoin(off.id);
  });

  it('listCoins：按 sort_order 升序，sort_order 相同时按 id 升序', () => {
    const a = coin.createCoin({
      symbol: '__TEST_S1', name: '序1', gate_pair: null, gate_slug: null,
      binance_pair: null, cg_id: 's1', sort_order: 800, enabled: 1,
      alert_above: null, alert_below: null,
    });
    const b = coin.createCoin({
      symbol: '__TEST_S2', name: '序2', gate_pair: null, gate_slug: null,
      binance_pair: null, cg_id: 's2', sort_order: 800, enabled: 1,
      alert_above: null, alert_below: null,
    });

    const list = coin.listCoins();
    const ia = list.findIndex(c => c.id === a.id);
    const ib = list.findIndex(c => c.id === b.id);
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ib).toBeGreaterThanOrEqual(0);
    // 相同 sort_order 时按 id 升序（a 先插入，id 更小）
    expect(ia).toBeLessThan(ib);

    coin.deleteCoin(a.id);
    coin.deleteCoin(b.id);
  });

  it('syncAddedDefaultCoins：symbol 在 DEFAULT_COINS 中缺失时跳过不插入', () => {
    // 构造极端场景：待补插的 symbol 不在 DEFAULT_COINS 元数据里
    // （DEFAULT_COINS 是导出的可变数组，临时摘掉 HYPE 再调用补插逻辑）
    const idx = coin.DEFAULT_COINS.findIndex(c => c.symbol === 'HYPE');
    const removed = coin.DEFAULT_COINS.splice(idx, 1)[0]!;
    getDb().prepare(`DELETE FROM coins WHERE symbol = 'HYPE'`).run();
    try {
      coin.syncAddedDefaultCoins();
      // 元数据缺失 → 跳过，HYPE 不应被插入
      expect(coin.listCoins().some(c => c.symbol === 'HYPE')).toBe(false);
    } finally {
      coin.DEFAULT_COINS.splice(idx, 0, removed);
      coin.syncAddedDefaultCoins();
    }
    // 恢复后 HYPE 应重新出现
    expect(coin.listCoins().some(c => c.symbol === 'HYPE')).toBe(true);
  });
});

describe('report model 补充', () => {
  // 直接写一行报表，用于精确控制 created_at（排序断言需要确定性）
  function insertRawReport(createdAt: number, message: string): number {
    const info = getDb().prepare(
      'INSERT INTO reports (triggered_by, success, total_coins, ok_coins, tg_sent, feishu_sent, message, summary, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('cron', 1, 1, 1, 0, 0, message, '{}', createdAt);
    return Number(info.lastInsertRowid);
  }

  it('createReport：success/tg_sent/feishu_sent 为 false 时落库为 0', () => {
    const r = report.createReport({
      triggered_by: 'manual',
      success: false,
      total_coins: 3,
      ok_coins: 0,
      tg_sent: false,
      feishu_sent: false,
      message: 'm',
      summary: { a: 1 },
    });
    expect(r.success).toBe(0);
    expect(r.tg_sent).toBe(0);
    expect(r.feishu_sent).toBe(0);
    expect(r.ok_coins).toBe(0);
    // summary 以 JSON 字符串落库，读回来能解析
    expect(JSON.parse(r.summary)).toEqual({ a: 1 });
  });

  it('findById：id 存在返回该行，不存在返回 null', () => {
    const r = report.createReport({
      triggered_by: 'test', success: true, total_coins: 1, ok_coins: 1,
      tg_sent: true, feishu_sent: true, message: 'find', summary: {},
    });
    expect(report.findById(r.id)?.id).toBe(r.id);
    expect(report.findById(999999)).toBeNull();
  });

  it('listReports：按 created_at 倒序返回', () => {
    report.clearAllReports();
    const t = Date.now();
    const id1 = insertRawReport(t - 1000, 'older');
    const id2 = insertRawReport(t - 2000, 'oldest');
    const id3 = insertRawReport(t, 'newest');

    const list = report.listReports(10);
    expect(list.map(r => r.id)).toEqual([id3, id1, id2]);
    const times = list.map(r => r.created_at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('listReports：limit 边界（0 / 负数 / 超大值）', () => {
    report.clearAllReports();
    const t = Date.now();
    insertRawReport(t - 2000, 'a');
    insertRawReport(t - 1000, 'b');
    const total = report.listReports(1000).length;

    // limit=0 → 空数组
    expect(report.listReports(0)).toEqual([]);
    // limit 为负数：SQLite 视为不限行 → 返回全部
    expect(report.listReports(-1).length).toBe(total);
    // limit 超大 → 返回全部
    expect(report.listReports(1000000).length).toBe(total);
    // 正常 limit → 截断
    expect(report.listReports(1).length).toBe(1);
  });

  it('lastReport：取 created_at 最大的一条', () => {
    report.clearAllReports();
    const t = Date.now();
    insertRawReport(t - 5000, 'old');
    const newest = insertRawReport(t, 'new');
    expect(report.lastReport()?.id).toBe(newest);
  });

  it('deleteReport：删除存在的行返回 true，删除不存在的行返回 false', () => {
    report.clearAllReports();
    const id = insertRawReport(Date.now(), 'x');
    expect(report.deleteReport(id)).toBe(true);
    expect(report.deleteReport(id)).toBe(false);
  });

  it('deleteReports：只接受正整数 id，返回实际删除的行数', () => {
    report.clearAllReports();
    const t = Date.now();
    const id1 = insertRawReport(t - 2000, 'a');
    const id2 = insertRawReport(t - 1000, 'b');
    const id3 = insertRawReport(t, 'c');

    // 非整数、非正数的 id 被过滤掉
    const n = report.deleteReports([id1, 0, -5, 2.5, id2]);
    expect(n).toBe(2);
    expect(report.findById(id1)).toBeNull();
    expect(report.findById(id2)).toBeNull();
    expect(report.findById(id3)).not.toBeNull();
  });

  it('deleteReports：全部 id 非法时返回 0 且不删除任何行', () => {
    report.clearAllReports();
    const id = insertRawReport(Date.now(), 'a');
    expect(report.deleteReports([0, -1, 1.5])).toBe(0);
    expect(report.deleteReports([])).toBe(0);
    expect(report.findById(id)).not.toBeNull();
  });

  it('clearAllReports：清空全部报表并返回删除行数', () => {
    report.clearAllReports();
    const t = Date.now();
    insertRawReport(t - 2000, 'a');
    insertRawReport(t - 1000, 'b');
    const n = report.clearAllReports();
    expect(n).toBe(2);
    expect(report.listReports(100)).toEqual([]);
    // 已经空了再清一次返回 0
    expect(report.clearAllReports()).toBe(0);
  });

  it('lastReport：表为空时返回 null', () => {
    report.clearAllReports();
    expect(report.lastReport()).toBeNull();
  });
});