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
      // 飞书边缘节点对 DoH 解析出的 CDN IP 直连请求返回 403（"Not Allowed For <ip>"）。
      // 这里强制走 undici 默认 DNS 解析，让请求经飞书自家 DNS/CDN 路由。
      doh: null,
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