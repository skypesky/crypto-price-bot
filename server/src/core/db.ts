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
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol         TEXT    UNIQUE NOT NULL,
  name           TEXT    NOT NULL,
  gate_pair      TEXT,
  gate_slug      TEXT,
  cg_id          TEXT    NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  alert_above    REAL,                 -- 突破该美元价时向飞书发一次提醒；NULL = 不设上限
  alert_below    REAL,                 -- 跌破该美元价时向飞书发一次提醒；NULL = 不设下限
  last_price     REAL,                 -- 上次 runTask 抓到的 last；NULL = 首次无穿越概念
  last_alert_at  INTEGER NOT NULL DEFAULT 0,  -- 上次向飞书发阈值提醒的 ms 时间戳；0 = 未发过
  last_alert_dir TEXT,                 -- 上次发提醒的方向：'above' / 'below' / NULL
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
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

/** 旧币种 → gate.com slug（用于现有 DB 回填 gate_slug）。
 *  注意 BNB 的 slug 已被 gate.com 改路由：旧 'binancecoin' 现在会跳到狗头页。
 *  新 slug 取自 gate.com 官方 trade 页脚。 */
const GATE_SLUG_BY_SYMBOL: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', USDT: 'tether', SOL: 'solana',
  ABT: 'arcblock', BNB: 'bnb',
  GT: 'gate', YGG: 'yieldguildgames', SAGA: 'saga',
};

/** 已知坏 slug → 新 slug。
 *  一些币的 slug 被 gate.com 改路由后，旧 slug 会被劫持到狗头页。
 *  仅在此处白名单的 (symbol, oldSlug) 组合会被强制覆盖为新 slug，
 *  其它任何用户自定义 slug 都不会被触碰。 */
const KNOWN_BAD_GATE_SLUGS: Record<string, Record<string, string>> = {
  BNB: { binancecoin: 'bnb' },
};

function migrate(db: Database.Database): void {
  db.exec(SCHEMA);
  // 兼容 v2.0 之前没 gate_slug 列的 DB
  const cols = db.prepare(`PRAGMA table_info(coins)`).all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('gate_slug')) {
    db.exec(`ALTER TABLE coins ADD COLUMN gate_slug TEXT`);
  }
  // 价格预警字段（独立 ALTER 以兼容 v2.0 之前没这些列的旧库）
  if (!colNames.has('alert_above')) {
    db.exec(`ALTER TABLE coins ADD COLUMN alert_above REAL`);
  }
  if (!colNames.has('alert_below')) {
    db.exec(`ALTER TABLE coins ADD COLUMN alert_below REAL`);
  }
  if (!colNames.has('last_price')) {
    db.exec(`ALTER TABLE coins ADD COLUMN last_price REAL`);
  }
  if (!colNames.has('last_alert_at')) {
    db.exec(`ALTER TABLE coins ADD COLUMN last_alert_at INTEGER NOT NULL DEFAULT 0`);
  }
  if (!colNames.has('last_alert_dir')) {
    db.exec(`ALTER TABLE coins ADD COLUMN last_alert_dir TEXT`);
  }
  // 回填现有币种的 gate_slug（仅当为空时）
  const upd = db.prepare(`UPDATE coins SET gate_slug = ? WHERE symbol = ? AND (gate_slug IS NULL OR gate_slug = '')`);
  for (const [symbol, slug] of Object.entries(GATE_SLUG_BY_SYMBOL)) {
    upd.run(slug, symbol);
  }
  // 修复已知坏 slug → 新 slug。
  // 只对白名单里的 (symbol, oldSlug) 组合生效：用户手动编辑过的 slug 不会被覆盖，
  // 避免误改用户对其它币种的自定义。
  // WHY 独立于 GATE_SLUG_BY_SYMBOL：前者只在 NULL/'' 时回填，无法修复已经被改成坏 slug 的存量数据
  // （如 web UI 编辑时填入了 'binancecoin'）。这条迁移保证坏 slug 在下次启动时被纠正。
  const fixBad = db.prepare(`UPDATE coins SET gate_slug = ? WHERE symbol = ? AND gate_slug = ?`);
  for (const [symbol, mapping] of Object.entries(KNOWN_BAD_GATE_SLUGS)) {
    for (const [oldSlug, newSlug] of Object.entries(mapping)) {
      fixBad.run(newSlug, symbol, oldSlug);
    }
  }
  // 数据迁移：ICX 已从默认币种与 slug 映射中移除；清理存量数据，
  // 这样旧库初始化过的实例在下次启动时也会停止监控 ICX。
  // 仅在 ICX 存在时执行（幂等），避免误删用户后续手动添加的 ICX。
  db.prepare(`DELETE FROM coins WHERE symbol = 'ICX'`).run();
  // 数据迁移：FIL / ATOM / OP 已从默认币种与 slug 映射中移除；清理存量数据，
  // 这样旧库初始化过的实例在下次启动时也会停止监控这三个币。
  // 仅在对应 symbol 存在时执行（幂等），避免误删用户后续手动添加回来的同名币。
  const removedSymbols = ['FIL', 'ATOM', 'OP'];
  const placeholders = removedSymbols.map(() => '?').join(',');
  db.prepare(`DELETE FROM coins WHERE symbol IN (${placeholders})`).run(...removedSymbols);
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