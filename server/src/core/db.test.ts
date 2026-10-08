import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
      (symbol, name, gate_pair, gate_slug, cg_id, sort_order, enabled,
       alert_above, alert_below, last_price, last_alert_at, last_alert_dir,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?, ?)`);
    ins.run('BNB',    '币安币',   'BNB_USDT',    'binancecoin',    'binancecoin', 5, 1, now, now); // 坏 slug
    ins.run('FIL',    '文件币',   'FIL_USDT',    'filecoinipfs',   'filecoin',    6, 1, now, now); // 待删除（迁移会清掉 FIL 行）
    ins.run('BTC',    '比特币',   'BTC_USDT',    'bitcoin',        'bitcoin',     0, 1, now, now); // 正常 slug
    ins.run('CUSTOM', '用户币',   'CUSTOM_USDT', 'my-custom-slug', 'custom',     99, 1, now, now); // 用户自定义
    ins.run('GT',     'Gate',     'GT_USDT',     'gate',           'gatechain-token', 7, 1, now, now); // 币安未上架，binance_slug 保持 NULL
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

  it('binance_slug 列被自动加上 + 默认币种被回填', () => {
    // 老版本 DB 没有 binance_slug 列，迁移后必须存在且默认币种已被回填
    const cols = (getDb().prepare(`PRAGMA table_info(coins)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('binance_slug');
    const bnb = getDb().prepare(`SELECT binance_slug FROM coins WHERE symbol='BNB'`).get() as { binance_slug: string };
    expect(bnb.binance_slug).toBe('bnb');
  });

  it('币安未上架的币 binance_slug 保持 NULL', () => {
    const gt = getDb().prepare(`SELECT binance_slug FROM coins WHERE symbol='GT'`).get() as { binance_slug: string | null };
    expect(gt.binance_slug).toBeNull();
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