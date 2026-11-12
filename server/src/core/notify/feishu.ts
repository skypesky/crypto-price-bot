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

/** 一条待发送的消息体：纯文本或 interactive 卡片。 */
type FeishuPayload =
  | { msg_type: 'text'; content: { text: string } }
  | { msg_type: 'interactive'; card: unknown };

const log = createLogger({ isTTY: false }).child('feishu');

/**
 * 把消息转成待发送的 payload 列表。
 * 完整报告可能拆成多张卡片（飞书单卡 30KB 上限），逐张发送；
 * 非完整报告（价格预警等）走 text 通道。
 */
function buildPayloads(message: string): FeishuPayload[] {
  const cards = isFullReportMessage(message) ? messageToFeishuCards(message) : [];
  if (cards.length > 0) return cards;
  return [{ msg_type: 'text', content: { text: normalizeMessageForTextChannel(message) } }];
}

/** Bot 主送路径：凭证齐全时优先走 Bot，失败降级到 webhook。 */
async function sendViaBotChannel(
  cfg: ReturnType<typeof getConfig>,
  payloads: FeishuPayload[],
): Promise<{ ok: boolean; error?: string }> {
  for (const payload of payloads) {
    const result = await sendViaBot(
      cfg,
      payload,
      cfg.feishu_default_receive_id!,
      cfg.feishu_default_receive_id_type!,
    );
    if (!result.ok) return { ok: false, error: result.error ?? 'unknown' };
  }
  return { ok: true };
}

/** 飞书返回体里的错误码（两个通道共用）。 */
function responseError(data: {
  StatusCode?: number;
  code?: number;
  msg?: string;
}): string | null {
  if (data.StatusCode && data.StatusCode !== 0) {
    return `feishu StatusCode=${data.StatusCode} msg=${data.msg}`;
  }
  if (typeof data.code === 'number' && data.code !== 0) {
    return `feishu code=${data.code} msg=${data.msg}`;
  }
  return null;
}

/** Webhook 降级路径：逐张 POST 到自定义机器人 webhook。 */
async function sendViaWebhook(
  cfg: ReturnType<typeof getConfig>,
  payloads: FeishuPayload[],
): Promise<FeishuSendResult> {
  if (!cfg.feishu_webhook_url) {
    return { ok: false, error: 'feishu webhook not configured' };
  }
  try {
    for (const [i, body] of payloads.entries()) {
      const bodyJson = JSON.stringify(body);
      if (process.env['FEISHU_DEBUG_BODY'] === '1') {
        log.debug(`webhook body (${i + 1}/${payloads.length})=${bodyJson}`);
      } else {
        log.debug(`webhook send (${i + 1}/${payloads.length}) msg_type=${body.msg_type} bytes=${bodyJson.length}`);
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
      log.info(`response (${i + 1}/${payloads.length}): ${JSON.stringify(res.data)}`);
      const err = responseError(res.data);
      if (err) return { ok: false, error: err };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof HttpError) {
      return { ok: false, error: `${err.message} (HTTP ${err.status})` };
    }
    return { ok: false, error: (err as Error).message };
  }
}

export async function sendToFeishu(message: string): Promise<FeishuSendResult> {
  const cfg = getConfig();
  if (!cfg.feishu_webhook_url && !isBotConfigured(cfg)) {
    return { ok: false, error: 'feishu not configured (no webhook and no bot credentials)' };
  }

  // 解析报告可能在任意一步抛错（历史上 Bot / webhook 两条路径各自包了 try，
  // 解析异常被吞成 { ok:false }）—— 统一在这里兜住，保持对外契约不变。
  let payloads: FeishuPayload[];
  try {
    payloads = buildPayloads(message);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  if (isBotConfigured(cfg)) {
    try {
      const result = await sendViaBotChannel(cfg, payloads);
      if (result.ok) return { ok: true };
      log.warn(`Bot send failed, falling back to webhook: ${result.error}`);
    } catch (err) {
      log.warn('Bot send threw, falling back to webhook', err);
    }
  }

  return sendViaWebhook(cfg, payloads);
}
