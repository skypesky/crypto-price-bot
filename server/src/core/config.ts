/**
 * 配置加载：env（启动参数）+ DB（运行时配置）。env 优先覆盖 DB 默认值。
 */

import { getAllSettings, type SettingValue } from './models/setting.js';
import { DEFAULT_SETTINGS } from './models/setting.js';

export interface Config {
  tg_bot_token: string | null;
  tg_chat_id: string | null;
  feishu_webhook_url: string | null;
  timezone: string;
  schedule_rule: string;
  usdt_to_cny: number;
  ua: string;
  doh_enabled: boolean;
  doh_server: string;
  doh_bypass: string[];
  request_timeout_ms: number;
  max_retries: number;
}

const ENV_MAP: Partial<Record<keyof Config, string>> = {
  tg_bot_token: 'TG_BOT_TOKEN',
  tg_chat_id: 'TG_CHAT_ID',
  feishu_webhook_url: 'FEISHU_WEBHOOK_URL',
  timezone: 'TIMEZONE',
  ua: 'CUSTOM_USER_AGENT',
};

function envValue(envName: string): SettingValue | undefined {
  const v = process.env[envName];
  if (v === undefined || v === '') return undefined;
  return v;
}

function coerceBoolean(v: SettingValue | undefined, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return fallback;
}

function coerceNumber(v: SettingValue | undefined, fallback: number): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function coerceStringArray(v: SettingValue | undefined, fallback: string[]): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') {
    return v.split(',').map(s => s.trim()).filter(Boolean);
  }
  return fallback;
}

let _config: Config | null = null;
const _listeners = new Set<(c: Config) => void>();

export function loadConfig(): Config {
  const dbSettings = getAllSettings();
  // env 覆盖
  for (const [k, envName] of Object.entries(ENV_MAP)) {
    if (!envName) continue;
    const v = envValue(envName);
    if (v !== undefined) dbSettings[k] = v;
  }
  const cfg: Config = {
    tg_bot_token: (dbSettings.tg_bot_token as string | null) ?? null,
    tg_chat_id: (dbSettings.tg_chat_id as string | null) ?? null,
    feishu_webhook_url: (dbSettings.feishu_webhook_url as string | null) ?? null,
    timezone: (dbSettings.timezone as string) ?? DEFAULT_SETTINGS.timezone as string,
    schedule_rule: (dbSettings.schedule_rule as string) ?? DEFAULT_SETTINGS.schedule_rule as string,
    usdt_to_cny: coerceNumber(dbSettings.usdt_to_cny, DEFAULT_SETTINGS.usdt_to_cny as number),
    ua: (dbSettings.ua as string) ?? DEFAULT_SETTINGS.ua as string,
    doh_enabled: coerceBoolean(dbSettings.doh_enabled, DEFAULT_SETTINGS.doh_enabled as boolean),
    doh_server: (dbSettings.doh_server as string) ?? DEFAULT_SETTINGS.doh_server as string,
    doh_bypass: coerceStringArray(dbSettings.doh_bypass, DEFAULT_SETTINGS.doh_bypass as string[]),
    request_timeout_ms: coerceNumber(dbSettings.request_timeout_ms, DEFAULT_SETTINGS.request_timeout_ms as number),
    max_retries: coerceNumber(dbSettings.max_retries, DEFAULT_SETTINGS.max_retries as number),
  };
  _config = cfg;
  return cfg;
}

export function getConfig(): Config {
  if (!_config) _config = loadConfig();
  return _config;
}

export function reloadConfig(): Config {
  const cfg = loadConfig();
  for (const fn of _listeners) {
    try { fn(cfg); } catch { /* swallow listener errors */ }
  }
  return cfg;
}

export function onConfigChange(fn: (c: Config) => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}