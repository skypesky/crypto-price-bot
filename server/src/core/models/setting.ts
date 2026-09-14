import { getDb } from '../db.js';

export type SettingValue = string | number | boolean | null | string[];

export interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

export const DEFAULT_SETTINGS: Record<string, SettingValue> = {
  tg_bot_token: null,
  tg_chat_id: null,
  feishu_webhook_url: null,
  timezone: 'Asia/Shanghai',
  schedule_rule: '0 */10 * * * *',
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  doh_enabled: true,
  doh_server: '1.1.1.1',
  doh_bypass: ['1.1.1.1', 'one.one.one.one', 'cloudflare-dns.com'],
  request_timeout_ms: 15000,
  max_retries: 1,
  alert_cooldown_hours: 24,  // 同方向阈值提醒冷却（小时），0 = 每次都发
};

export function initDefaults(): void {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  const tx = db.transaction((entries: [string, SettingValue][]) => {
    for (const [k, v] of entries) {
      stmt.run(k, JSON.stringify(v), now);
    }
  });
  tx(Object.entries(DEFAULT_SETTINGS));
  // 迁移：删除已废弃的设置项（如 usdt_to_cny）
  const deprecated = ['usdt_to_cny'];
  if (deprecated.length > 0) {
    const placeholders = deprecated.map(() => '?').join(',');
    db.prepare(`DELETE FROM settings WHERE key IN (${placeholders})`).run(...deprecated);
  }
  // 迁移：默认值变更 — 若存量仍是旧默认值，自动升级到新默认值；用户自定义值不动
  const valueMigrations: Array<{ key: string; from: SettingValue; to: SettingValue }> = [
    { key: 'schedule_rule', from: '0 */30 * * * *', to: DEFAULT_SETTINGS.schedule_rule },
  ];
  const updateStmt = db.prepare(
    'UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND value = ?',
  );
  const migrateNow = Date.now();
  for (const m of valueMigrations) {
    updateStmt.run(JSON.stringify(m.to), migrateNow, m.key, JSON.stringify(m.from));
  }
}

export function getAllSettings(): Record<string, SettingValue> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const out: Record<string, SettingValue> = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = DEFAULT_SETTINGS[k]!;
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = null; }
  }
  return out;
}

export function getSetting(key: string): SettingValue | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return DEFAULT_SETTINGS[key];
  try { return JSON.parse(row.value); } catch { return null; }
}

export function setSetting(key: string, value: SettingValue): void {
  getDb().prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, JSON.stringify(value), Date.now());
}

export function setManySettings(values: Record<string, SettingValue>): void {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );
  const tx = db.transaction((entries: [string, SettingValue][]) => {
    const now = Date.now();
    for (const [k, v] of entries) stmt.run(k, JSON.stringify(v), now);
  });
  tx(Object.entries(values));
}