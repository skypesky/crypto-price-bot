import { httpPost, HttpError } from '../../util/http.js';
import { getConfig } from '../config.js';
import { normalizeMessageForTextChannel } from '../message/formatter.js';

export interface FeishuSendResult {
  ok: boolean;
  error?: string;
}

export async function sendToFeishu(message: string): Promise<FeishuSendResult> {
  const cfg = getConfig();
  if (!cfg.feishu_webhook_url) {
    return { ok: false, error: 'feishu webhook not configured' };
  }
  const text = normalizeMessageForTextChannel(message);
  try {
    const res = await httpPost<{ StatusCode?: number; msg?: string }>(cfg.feishu_webhook_url, {
      msg_type: 'text',
      content: { text },
    }, {
      timeoutMs: cfg.request_timeout_ms,
      retries: cfg.max_retries,
      headers: { 'User-Agent': cfg.ua },
      doh: cfg.doh_enabled ? { endpoint: `https://${cfg.doh_server}/dns-query`, bypass: new Set(cfg.doh_bypass) } : null,
    });
    if (res.data.StatusCode && res.data.StatusCode !== 0) {
      return { ok: false, error: `feishu StatusCode=${res.data.StatusCode} msg=${res.data.msg}` };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof HttpError) {
      return { ok: false, error: `${err.message} (HTTP ${err.status})` };
    }
    return { ok: false, error: (err as Error).message };
  }
}