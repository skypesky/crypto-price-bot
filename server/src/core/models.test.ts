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