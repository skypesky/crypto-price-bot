import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../util/logger.js';

const log = createLogger({ isTTY: false }).child('db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new Error('db not initialized: call initDb() first');
  return _db;
}

export function initDb(filePath: string): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  _db = db;
  log.info(`db initialized at ${filePath}`);
  return db;
}

/** 测试用：注入自定义 db 实例 */
export function setDb(db: Database.Database): void {
  _db = db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT    UNIQUE NOT NULL,
  name        TEXT    NOT NULL,
  gate_pair   TEXT,
  cg_id       TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  triggered_by  TEXT    NOT NULL,
  success       INTEGER NOT NULL,
  total_coins   INTEGER NOT NULL,
  ok_coins      INTEGER NOT NULL,
  tg_sent       INTEGER NOT NULL,
  feishu_sent   INTEGER NOT NULL,
  message       TEXT    NOT NULL,
  summary       TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
`;

function migrate(db: Database.Database): void {
  db.exec(SCHEMA);
}

export function pingDb(): boolean {
  try {
    const db = getDb();
    db.pragma('user_version');
    return true;
  } catch {
    return false;
  }
}