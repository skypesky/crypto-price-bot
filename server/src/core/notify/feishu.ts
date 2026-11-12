import { httpPost, HttpError } from '../../util/http.js';
import { getConfig } from '../config.js';
import { createLogger } from '../../util/logger.js';
import {
  isFullReportMessage,
  messageToFeishuCards,
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
      // 完整报告可能拆成多张卡片（飞书单卡 30KB 上限），逐张发送
      const cards = isFullReportMessage(message) ? messageToFeishuCards(message) : [];
      let failure: string | null = null;
      if (cards.length > 0) {
        for (const card of cards) {
          const result = await sendViaBot(
            cfg,
            card,
            cfg.feishu_default_receive_id!,
            cfg.feishu_default_receive_id_type!,
          );
          if (!result.ok) {
            failure = result.error ?? 'unknown';
            break;
          }
        }
      } else {
        const result = await sendViaBot(
          cfg,
          { msg_type: 'text', content: { text: normalizeMessageForTextChannel(message) } },
          cfg.feishu_default_receive_id!,
          cfg.feishu_default_receive_id_type!,
        );
        if (!result.ok) failure = result.error ?? 'unknown';
      }
      if (!failure) return { ok: true };
      log.warn(`Bot send failed, falling back to webhook: ${failure}`);
    } catch (err) {
      log.warn('Bot send threw, falling back to webhook', err);
    }
  }

  // Webhook 降级路径（现有逻辑保留）
  if (!cfg.feishu_webhook_url) {
    return { ok: false, error: 'feishu webhook not configured' };
  }
  try {
    // Webhook 自定义机器人支持 interactive 卡片：纯展示，链接用 Markdown 行内链接。
    // 完整报告可能拆成多张卡片（飞书单卡 30KB 上限），逐张发送。
    const cards = isFullReportMessage(message) ? messageToFeishuCards(message) : [];
    const bodies = cards.length > 0
      ? cards
      : [{ msg_type: 'text' as const, content: { text: normalizeMessageForTextChannel(message) } }];

    for (const [i, body] of bodies.entries()) {
      const bodyJson = JSON.stringify(body);
      if (process.env['FEISHU_DEBUG_BODY'] === '1') {
        log.debug(`webhook body (${i + 1}/${bodies.length})=${bodyJson}`);
      } else {
        log.debug(`webhook send (${i + 1}/${bodies.length}) msg_type=${body.msg_type} bytes=${bodyJson.length}`);
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
      log.info(`response (${i + 1}/${bodies.length}): ${JSON.stringify(res.data)}`);
      if (res.data.StatusCode && res.data.StatusCode !== 0) {
        return { ok: false, error: `feishu StatusCode=${res.data.StatusCode} msg=${res.data.msg}` };
      }
      if (typeof res.data.code === 'number' && res.data.code !== 0) {
        return { ok: false, error: `feishu code=${res.data.code} msg=${res.data.msg}` };
      }
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof HttpError) {
      return { ok: false, error: `${err.message} (HTTP ${err.status})` };
    }
    return { ok: false, error: (err as Error).message };
  }
}
