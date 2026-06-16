import { httpPost, HttpError } from '../../util/http.js';
import { getConfig } from '../config.js';

export interface TelegramSendResult {
  ok: boolean;
  error?: string;
  description?: string;
}

export async function sendToTG(message: string): Promise<TelegramSendResult> {
  const cfg = getConfig();
  if (!cfg.tg_bot_token || !cfg.tg_chat_id) {
    return { ok: false, error: 'telegram not configured (tg_bot_token / tg_chat_id missing)' };
  }
  const url = `https://api.telegram.org/bot${cfg.tg_bot_token}/sendMessage`;
  try {
    const res = await httpPost<{ ok: boolean; description?: string }>(url, {
      chat_id: cfg.tg_chat_id,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }, {
      timeoutMs: cfg.request_timeout_ms,
      retries: cfg.max_retries,
      headers: { 'User-Agent': cfg.ua },
      doh: cfg.doh_enabled ? { endpoint: `https://${cfg.doh_server}/dns-query`, bypass: new Set(cfg.doh_bypass) } : null,
    });
    if (!res.data.ok) {
      return { ok: false, error: 'telegram api returned ok=false', description: res.data.description };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof HttpError) {
      return { ok: false, error: err.message, description: `HTTP ${err.status}` };
    }
    return { ok: false, error: (err as Error).message };
  }
}