import { Client } from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../util/logger.js';
import type { Config } from '../config.js';

const log = createLogger({ isTTY: false }).child('feishu-bot');

/**
 * Bot 凭证齐全判定：6 个字段全部非空才算配置成功。
 * 任一缺失 → 降级到 webhook 通道。
 */
export function isBotConfigured(cfg: Config): boolean {
  return Boolean(
    cfg.feishu_app_id &&
    cfg.feishu_app_secret &&
    cfg.feishu_encrypt_key &&
    cfg.feishu_verification_token &&
    cfg.feishu_default_receive_id &&
    cfg.feishu_default_receive_id_type
  );
}

/**
 * WS 最小配置判定：仅需 app_id + app_secret + default_receive_id + id_type。
 * WS 模式不依赖 encrypt_key / verification_token（SDK 在非加密事件流下可选）。
 * 任一缺失 → 不启动 WS 长连接。
 */
export function isBotMinimalConfig(cfg: Config): boolean {
  return Boolean(
    cfg.feishu_app_id &&
    cfg.feishu_app_secret &&
    cfg.feishu_default_receive_id &&
    cfg.feishu_default_receive_id_type
  );
}

export interface FeishuCardPayload {
  msg_type: 'text' | 'interactive';
  content?: { text: string };
  card?: unknown;
}

export async function sendViaBot(
  cfg: Config,
  payload: FeishuCardPayload,
  receiveId: string,
  receiveIdType: 'chat_id' | 'open_id' | 'union_id' | 'email',
): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new Client({
      appId: cfg.feishu_app_id!,
      appSecret: cfg.feishu_app_secret!,
      domain: 'https://open.feishu.cn',
    });
    const res = await client.request({
      url: `/im/v1/messages?receive_id_type=${receiveIdType}`,
      method: 'POST',
      data: {
        receive_id: receiveId,
        msg_type: payload.msg_type,
        content: payload.msg_type === 'text' ? payload.content : JSON.stringify(payload.card),
      },
    });
    const data = res as { code?: number; msg?: string };
    if (typeof data.code === 'number' && data.code !== 0) {
      return { ok: false, error: `feishu bot code=${data.code} msg=${data.msg}` };
    }
    return { ok: true };
  } catch (err) {
    log.warn('sendViaBot failed', err);
    return { ok: false, error: (err as Error).message };
  }
}
