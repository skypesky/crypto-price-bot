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