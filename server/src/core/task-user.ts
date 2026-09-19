import { runTask } from './task.js';
import { sendViaBot, isBotConfigured } from './notify/feishu-bot.js';
import { messageToFeishuCard, isFullReportMessage, normalizeMessageForTextChannel } from './message/formatter.js';
import { getConfig } from './config.js';
import { createLogger } from '../util/logger.js';

const logUser = createLogger({ isTTY: false }).child('task-user');

/**
 * 飞书卡片「立即查询」按钮回调专用：调用 runTask 拉最新数据，DM 给点击者。
 * 与定时推送不同：必须用 Bot 通道（不能降级到 webhook，因为 webhook 不能指定收件人）。
 */
export async function runTaskForUser(
  openId: string,
  receiveIdType: 'open_id' | 'union_id' | 'email' = 'open_id'
): Promise<{ ok: boolean; reportId?: number; error?: string }> {
  const cfg = getConfig();
  if (!isBotConfigured(cfg)) {
    logUser.warn('Bot not configured, cannot run task for user');
    return { ok: false, error: 'bot not configured' };
  }

  try {
    const result = await runTask('manual');
    if (!result.success) {
      return { ok: false, reportId: result.reportId, error: 'coin fetch failed' };
    }

    const message = result.message;
    const card = isFullReportMessage(message) ? messageToFeishuCard(message) : null;
    const payload = card ?? { msg_type: 'text' as const, content: { text: normalizeMessageForTextChannel(message) } };

    const sendResult = await sendViaBot(cfg, payload, openId, receiveIdType);
    if (!sendResult.ok) {
      logUser.warn(`DM failed for ${openId}: ${sendResult.error}`);
      return { ok: true, reportId: result.reportId, error: sendResult.error };
    }
    return { ok: true, reportId: result.reportId };
  } catch (err) {
    logUser.error('runTaskForUser failed', err);
    return { ok: false, error: (err as Error).message };
  }
}