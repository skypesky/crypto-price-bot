import { httpPost, HttpError } from '../../util/http.js';
import { getConfig } from '../config.js';
import { createLogger } from '../../util/logger.js';
import {
  isFullReportMessage,
  messageToFeishuCard,
  normalizeMessageForTextChannel,
} from '../message/formatter.js';
import { isBotConfigured, sendViaBot } from './feishu-bot.js';

export interface FeishuSendResult {
  ok: boolean;
  error?: string;
}

const log = createLogger({ isTTY: false }).child('feishu');

export async function sendToFeishu(message: string): Promise<FeishuSendResult> {
  const cfg = getConfig();
  if (!cfg.feishu_webhook_url && !isBotConfigured(cfg)) {
    return { ok: false, error: 'feishu not configured (no webhook and no bot credentials)' };
  }

  // Bot 主送路径：凭证齐全时优先走 Bot，失败降级到 webhook。
  if (isBotConfigured(cfg)) {
    try {
      const card = isFullReportMessage(message) ? messageToFeishuCard(message) : null;
      const payload = card ?? {
        msg_type: 'text' as const,
        content: { text: normalizeMessageForTextChannel(message) },
      };
      const result = await sendViaBot(
        cfg,
        payload,
        cfg.feishu_default_receive_id!,
        cfg.feishu_default_receive_id_type!,
      );
      if (result.ok) return { ok: true };
      log.warn(`Bot send failed, falling back to webhook: ${result.error}`);
    } catch (err) {
      log.warn('Bot send threw, falling back to webhook', err);
    }
  }

  // Webhook 降级路径（现有逻辑保留）
  if (!cfg.feishu_webhook_url) {
    return { ok: false, error: 'feishu webhook not configured' };
  }
  try {
    // 完整报告 → interactive 卡片（链接用 actions 按钮，点击跳转）。
    // 价格预警/重发历史短消息 → text 通道（飞书会自动识别 URL 为可点击）。
    const body = isFullReportMessage(message)
      ? (messageToFeishuCard(message) ?? {
          msg_type: 'text' as const,
          content: { text: normalizeMessageForTextChannel(message) },
        })
      : {
          msg_type: 'text' as const,
          content: { text: normalizeMessageForTextChannel(message) },
        };
    // DEBUG：打印 msg_type 和 body 大小，必要时打印完整 body
    const bodyJson = JSON.stringify(body);
    log.info(`send msg_type=${(body as { msg_type: string }).msg_type} bytes=${bodyJson.length}`);
    if (process.env['FEISHU_DEBUG_BODY'] === '1') {
      log.info(`body=${bodyJson}`);
    }
    const res = await httpPost<{ StatusCode?: number; code?: number; msg?: string; StatusMessage?: string }>(
      cfg.feishu_webhook_url,
      body,
      {
        timeoutMs: cfg.request_timeout_ms,
        retries: cfg.max_retries,
        headers: { 'User-Agent': cfg.ua },
        // 飞书边缘节点对 DoH 解析出的 CDN IP 直连请求返回 403（"Not Allowed For <ip>"）。
        // 这里强制走 undici 默认 DNS 解析，让请求经飞书自家 DNS/CDN 路由。
        doh: null,
      },
    );
    log.info(`response: ${JSON.stringify(res.data)}`);
    if (res.data.StatusCode && res.data.StatusCode !== 0) {
      return { ok: false, error: `feishu StatusCode=${res.data.StatusCode} msg=${res.data.msg}` };
    }
    if (typeof res.data.code === 'number' && res.data.code !== 0) {
      return { ok: false, error: `feishu code=${res.data.code} msg=${res.data.msg}` };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof HttpError) {
      return { ok: false, error: `${err.message} (HTTP ${err.status})` };
    }
    return { ok: false, error: (err as Error).message };
  }
}
