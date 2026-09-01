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
  schedule_rule: '0 */30 * * * *',
  usdt_to_cny: 7.20,
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