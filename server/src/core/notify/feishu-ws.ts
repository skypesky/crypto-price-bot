import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { getConfig } from '../config.js';
import { isBotConfigured } from './feishu-bot.js';
import { runTaskForUser } from '../task-user.js';
import { createLogger } from '../../util/logger.js';

const log = createLogger({ isTTY: false }).child('feishu-ws');

let _started = false;

/**
 * 启动飞书 SDK 长连接（WebSocket）事件处理。
 *
 * - 幂等：重复调用仅首次生效
 * - Bot 凭证缺失时：记录一条 info 后静默返回
 * - 注册 `card.action.trigger` 事件处理器，点击「🔄 立即查询」按钮时
 *   调用 runTaskForUser(openId) 给点击者 DM 一份最新报告
 * - SDK 内部处理重连、解密、签名校验
 *
 * 从 server/index.ts bootstrap 末尾调用一次即可。
 */
export function startFeishuWs(): void {
  if (_started) return;
  const cfg = getConfig();
  if (!isBotConfigured(cfg)) {
    log.info('Bot not configured, skipping feishu WS start');
    return;
  }
  _started = true;

  const dispatcher = new EventDispatcher({
    // WS 模式下 SDK 用 appId/appSecret 做握手鉴权，
    // verificationToken/encryptKey 在非加密事件流下可选；这里仍传入以兼容加密推送场景。
    verificationToken: cfg.feishu_verification_token ?? undefined,
    encryptKey: cfg.feishu_encrypt_key ?? undefined,
  });

  dispatcher.register({
    // SDK 把 card.action.trigger 的 event 体扁平化注入 handler：
    //   { type: 'card.action.trigger',
    //     operator: { open_id, user_id },
    //     action: { value: { action: 'query_now' }, tag },
    //     open_message_id, open_chat_id, token }
    'card.action.trigger': (data: Record<string, unknown>) => {
      const operator = (data?.operator ?? {}) as { open_id?: string };
      const action = (data?.action ?? {}) as { value?: { action?: string } };
      const openId = operator.open_id;
      const actionKey = action.value?.action;

      if (!openId) {
        log.warn('card.action.trigger missing open_id');
        return {};
      }
      if (actionKey !== 'query_now') {
        log.info('unrecognized card action', { value: action.value });
        return {};
      }

      // 异步触发 DM；不阻塞 SDK 的 WS 消息回退
      runTaskForUser(openId, 'open_id').catch((err) => {
        log.error(`runTaskForUser failed for ${openId}`, err);
      });
      return {};
    },
  });

  const wsClient = new WSClient({
    appId: cfg.feishu_app_id!,
    appSecret: cfg.feishu_app_secret!,
    domain: 'https://open.feishu.cn',
  });

  try {
    // WS 模式下 dispatcher 必须在 start() 时传入（SDK v1.74 API 约束）；
    // 返回 Promise<Void>，握手失败/超时由 SDK 内部 onError/onReconnecting 回调处理。
    const result = wsClient.start({ eventDispatcher: dispatcher });
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((err) => {
        log.error('feishu WS start failed', err);
        _started = false;
      });
    }
    log.info('feishu WS client started');
  } catch (err) {
    log.error('failed to start feishu WS', err);
    _started = false;
  }
}

/** Test-only hook：重置幂等标志以便后续 start() 重新生效 */
export function _resetFeishuWsForTests(): void {
  _started = false;
}