import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { setDb, closeDb, getDb, initDb, pingDb } from './db.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

describe('db', () => {
  const dbFile = join(tmpdir(), `cpb-test-${Date.now()}.db`);

  beforeAll(() => {
    initDb(dbFile);
  });

  afterAll(() => {
    closeDb();
    if (existsSync(dbFile)) unlinkSync(dbFile);
    if (existsSync(dbFile + '-wal')) unlinkSync(dbFile + '-wal');
    if (existsSync(dbFile + '-shm')) unlinkSync(dbFile + '-shm');
  });

  it('创建所有表', () => {
    const db = getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    expect(names).toContain('users');
    expect(names).toContain('sessions');
    expect(names).toContain('settings');
    expect(names).toContain('coins');
    expect(names).toContain('reports');
  });

  it('pingDb 返回 true', () => {
    expect(pingDb()).toBe(true);
  });

  it('setDb 覆盖', () => {
    const custom = new Database(':memory:');
    custom.exec('CREATE TABLE t(x INTEGER)');
    setDb(custom);
    expect(getDb().prepare('SELECT count(*) as c FROM t').get()).toEqual({ c: 0 });
    custom.close();
  });
});

describe('db migrate: gate_slug 已知坏 slug 自动修复', () => {
  const now = Date.now();
  // 用一个独立临时文件 + 手工 seed 老版本坏 slug 数据，再调 initDb 触发 migrate。
  // 真实地走一遍 initDb → migrate → UPDATE 的路径，而不是用 setDb 注入。
  const tmpFile = join(tmpdir(), `cpb-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

  beforeAll(() => {
    // 1) 手工 seed 一个"老版本坏 slug"DB（绕过 initDb）
    const seed = new Database(tmpFile);
    seed.exec(`
      CREATE TABLE coins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        gate_pair TEXT,
        gate_slug TEXT,
        binance_slug TEXT,
        cg_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        alert_above REAL,
        alert_below REAL,
        last_price REAL,
        last_alert_at INTEGER NOT NULL DEFAULT 0,
        last_alert_dir TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const ins = seed.prepare(`INSERT INTO coins
      (symbol, name, gate_pair, gate_slug, binance_slug, cg_id, sort_order, enabled,
       alert_above, alert_below, last_price, last_alert_at, last_alert_dir,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?, ?)`);
    ins.run('BNB',    '币安币',   'BNB_USDT',    'binancecoin',    'bnb',           'binancecoin', 5, 1, now, now); // 坏 slug
    ins.run('FIL',    '文件币',   'FIL_USDT',    'filecoinipfs',   'filecoin',      'filecoin',    6, 1, now, now); // 待删除（迁移会清掉 FIL 行）
    ins.run('BTC',    '比特币',   'BTC_USDT',    'bitcoin',        'bitcoin',       'bitcoin',     0, 1, now, now); // 正常 slug
    ins.run('CUSTOM', '用户币',   'CUSTOM_USDT', 'my-custom-slug', 'custom-slug',   'custom',     99, 1, now, now); // 用户自定义
    ins.run('GT',     'Gate',     'GT_USDT',     'gate',           null,            'gatechain-token', 7, 1, now, now); // 币安现货没这个交易对，binance_pair 保持 NULL
    ins.run('HYPE',   'Hyperliquid', 'HYPE_USDT', null,           'hyperliquid',   'hyperliquid',  13, 1, now, now); // 用户手动添加、slug 留空 → 迁移回填
    seed.close();
    // 2) 触发 initDb → migrate 跑修复
    closeDb();
    initDb(tmpFile);
  });

  afterAll(() => {
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      const p = tmpFile + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it('BNB 坏 slug "binancecoin" 被修复为 "bnb"', () => {
    const row = getDb().prepare(`SELECT gate_slug FROM coins WHERE symbol='BNB'`).get() as { gate_slug: string };
    expect(row.gate_slug).toBe('bnb');
  });

  it('FIL 已从默认币种移除：迁移后存量 FIL 行被清理', () => {
    const row = getDb().prepare(`SELECT id FROM coins WHERE symbol='FIL'`).get();
    expect(row).toBeUndefined();
  });

  it('正常 slug 不被改动', () => {
    const row = getDb().prepare(`SELECT gate_slug FROM coins WHERE symbol='BTC'`).get() as { gate_slug: string };
    expect(row.gate_slug).toBe('bitcoin');
  });

  it('用户自定义 slug 不被覆盖', () => {
    const row = getDb().prepare(`SELECT gate_slug FROM coins WHERE symbol='CUSTOM'`).get() as { gate_slug: string };
    expect(row.gate_slug).toBe('my-custom-slug');
  });

  it('binance_pair 列被自动加上 + 默认币种被回填', () => {
    // 老版本 DB 没有 binance_pair 列，迁移后必须存在且默认币种已被回填
    const cols = (getDb().prepare(`PRAGMA table_info(coins)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('binance_pair');
    const bnb = getDb().prepare(`SELECT binance_pair FROM coins WHERE symbol='BNB'`).get() as { binance_pair: string };
    expect(bnb.binance_pair).toBe('BNB_USDT');
  });

  it('老库的 binance_slug 列被删掉（链接已改用 binance_pair）', () => {
    const cols = (getDb().prepare(`PRAGMA table_info(coins)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain('binance_slug');
  });

  it('币安现货没这个交易对的币 binance_pair 保持 NULL', () => {
    const gt = getDb().prepare(`SELECT binance_pair FROM coins WHERE symbol='GT'`).get() as { binance_pair: string | null };
    expect(gt.binance_pair).toBeNull();
  });

  it('用户手动添加、slug 留空的 HYPE 行：gate_slug / binance_pair 被回填', () => {
    const row = getDb().prepare(`SELECT gate_slug, binance_pair FROM coins WHERE symbol='HYPE'`).get() as { gate_slug: string; binance_pair: string };
    expect(row.gate_slug).toBe('hyperliquid');
    expect(row.binance_pair).toBe('HYPE_USDT');
  });

  it('修复是幂等的（重复 initDb 不会再次 UPDATE）', () => {
    const before = (getDb().prepare(`SELECT updated_at FROM coins WHERE symbol='BNB'`).get() as { updated_at: number }).updated_at;
    closeDb();
    initDb(tmpFile); // 再跑一次
    const after = (getDb().prepare(`SELECT updated_at FROM coins WHERE symbol='BNB'`).get() as { updated_at: number }).updated_at;
    // 已知坏 slug 已不在了，第二次 migrate 不会有 UPDATE 影响 updated_at
    expect(after).toBe(before);
  });
});
describe('db 生命周期（独立模块实例，互不干扰）', () => {
  /** 拿一个全新的 db.js 模块实例（模块内部有 _db 单例状态） */
  async function freshDb(): Promise<typeof import('./db.js')> {
    vi.resetModules();
    return await import('./db.js');
  }

  it('未初始化时 getDb 抛出明确错误', async () => {
    const m = await freshDb();
    expect(() => m.getDb()).toThrow('db not initialized: call initDb() first');
  });

  it('initDb 使用 :memory: 初始化并建表', async () => {
    const m = await freshDb();
    const db = m.initDb(':memory:');
    expect(m.getDb()).toBe(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
    expect(tables).toContain('users');
    expect(tables).toContain('sessions');
    expect(tables).toContain('settings');
    expect(tables).toContain('coins');
    expect(tables).toContain('reports');
    m.closeDb();
  });

  it('重复调用 initDb 直接返回已初始化的实例', async () => {
    const m = await freshDb();
    const first = m.initDb(':memory:');
    const second = m.initDb(':memory:');
    expect(second).toBe(first);
    m.closeDb();
  });

  it('closeDb 关闭连接后 getDb 抛错', async () => {
    const m = await freshDb();
    m.initDb(':memory:');
    m.closeDb();
    expect(() => m.getDb()).toThrow('db not initialized');
  });

  it('未初始化时重复 closeDb 不报错', async () => {
    const m = await freshDb();
    expect(() => m.closeDb()).not.toThrow();
    expect(() => m.closeDb()).not.toThrow();
  });

  it('pingDb 在数据库可用时返回 true', async () => {
    const m = await freshDb();
    m.initDb(':memory:');
    expect(m.pingDb()).toBe(true);
    m.closeDb();
  });

  it('pingDb 在数据库关闭后返回 false', async () => {
    const m = await freshDb();
    m.initDb(':memory:');
    m.closeDb();
    expect(m.pingDb()).toBe(false);
  });

  it('initDb 打开了外键约束', async () => {
    const m = await freshDb();
    const db = m.initDb(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    m.closeDb();
  });

  it('外键约束生效：插入非法 user_id 会报错', async () => {
    const m = await freshDb();
    const db = m.initDb(':memory:');
    expect(() => {
      db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run('t1', 999, Date.now() + 1000, Date.now());
    }).toThrow(/FOREIGN KEY/);
    m.closeDb();
  });
});

describe('db 事务与并发访问', () => {
  it('事务中途抛错时回滚所有写入', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t(x INTEGER)');
    setDb(db);
    const tx = db.transaction((rows: number[]) => {
      const ins = db.prepare('INSERT INTO t(x) VALUES (?)');
      for (const r of rows) ins.run(r);
      throw new Error('业务异常');
    });
    expect(() => tx([1, 2, 3])).toThrow('业务异常');
    expect(db.prepare('SELECT count(*) as c FROM t').get()).toEqual({ c: 0 });
    db.close();
    closeDb();
  });

  it('事务正常提交时写入被保留', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t(x INTEGER)');
    setDb(db);
    const tx = db.transaction((rows: number[]) => {
      const ins = db.prepare('INSERT INTO t(x) VALUES (?)');
      for (const r of rows) ins.run(r);
    });
    tx([1, 2, 3]);
    expect(db.prepare('SELECT count(*) as c FROM t').get()).toEqual({ c: 3 });
    db.close();
    closeDb();
  });

  it('唯一约束冲突时事务整体回滚', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t(x INTEGER PRIMARY KEY)');
    setDb(db);
    db.prepare('INSERT INTO t(x) VALUES (1)').run();
    const tx = db.transaction((rows: number[]) => {
      const ins = db.prepare('INSERT INTO t(x) VALUES (?)');
      for (const r of rows) ins.run(r);
    });
    expect(() => tx([2, 1])).toThrow(/UNIQUE/);
    expect(db.prepare('SELECT count(*) as c FROM t').get()).toEqual({ c: 1 });
    db.close();
    closeDb();
  });

  it('并发（异步交错）读写同一张表，结果保持一致', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t(x INTEGER)');
    setDb(db);
    const ins = db.prepare('INSERT INTO t(x) VALUES (?)');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => ins.run(i))),
    );
    expect(db.prepare('SELECT count(*) as c FROM t').get()).toEqual({ c: 20 });
    expect(db.prepare('SELECT sum(x) as s FROM t').get()).toEqual({ s: 190 });
    db.close();
    closeDb();
  });

  it('并发读取与写入交错时不会读到脏数据', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t(x INTEGER)');
    setDb(db);
    const ins = db.prepare('INSERT INTO t(x) VALUES (?)');
    const count = db.prepare('SELECT count(*) as c FROM t');
    const results: number[] = [];
    await Promise.all([
      Promise.resolve().then(() => ins.run(1)),
      Promise.resolve().then(() => results.push((count.get() as { c: number }).c)),
      Promise.resolve().then(() => ins.run(2)),
      Promise.resolve().then(() => results.push((count.get() as { c: number }).c)),
    ]);
    expect((count.get() as { c: number }).c).toBe(2);
    expect(results.every((n) => n >= 1 && n <= 2)).toBe(true);
    db.close();
    closeDb();
  });
});

describe('db 迁移：v1 老库缺列时自动补齐', () => {
  const legacyFile = join(tmpdir(), `cpb-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

  beforeAll(() => {
    // 手工 seed 一个「v1 老库」：coins 表只有最早的几个列，
    // 缺 gate_slug / binance_pair / binance_slug / alert_* / last_* 等新列。
    const seed = new Database(legacyFile);
    seed.exec(`
      CREATE TABLE coins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        gate_pair TEXT,
        cg_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    const ins = seed.prepare(`INSERT INTO coins
      (symbol, name, gate_pair, cg_id, sort_order, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    ins.run('BTC', '比特币', 'BTC_USDT', 'bitcoin', 0, 1, now, now);
    ins.run('BNB', '币安币', 'BNB_USDT', 'binancecoin', 5, 1, now, now);
    seed.close();
    // 走真实的 initDb → migrate 路径
    closeDb();
    initDb(legacyFile);
  });

  afterAll(() => {
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      const p = legacyFile + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it('缺失的新列被全部补齐', () => {
    const cols = (getDb().prepare(`PRAGMA table_info(coins)`).all() as Array<{ name: string }>).map(c => c.name);
    for (const col of [
      'gate_slug', 'binance_pair', 'alert_above', 'alert_below',
      'last_price', 'last_alert_at', 'last_alert_dir',
    ]) {
      expect(cols).toContain(col);
    }
    // 老库里本来就没有 binance_slug，不需要（也不应该）被删列
    expect(cols).not.toContain('binance_slug');
  });

  it('老库数据保留且 gate_slug / binance_pair 被回填', () => {
    const row = getDb().prepare(`SELECT gate_slug, binance_pair FROM coins WHERE symbol='BNB'`).get() as
      { gate_slug: string; binance_pair: string };
    expect(row.gate_slug).toBe('bnb');
    expect(row.binance_pair).toBe('BNB_USDT');
  });

  it('新增的告警字段默认为空值', () => {
    const row = getDb().prepare(`SELECT alert_above, alert_below, last_price, last_alert_at, last_alert_dir FROM coins WHERE symbol='BTC'`).get() as
      { alert_above: number | null; alert_below: number | null; last_price: number | null; last_alert_at: number; last_alert_dir: string | null };
    expect(row.alert_above).toBeNull();
    expect(row.alert_below).toBeNull();
    expect(row.last_price).toBeNull();
    expect(row.last_alert_at).toBe(0);
    expect(row.last_alert_dir).toBeNull();
  });
});
