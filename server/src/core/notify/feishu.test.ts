import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./feishu-bot.js', () => ({
  isBotConfigured: vi.fn(),
  sendViaBot: vi.fn(),
}));

vi.mock('../../util/http.js', () => ({
  httpPost: vi.fn(),
  HttpError: class extends Error {},
}));

vi.mock('../config.js', () => ({
  getConfig: vi.fn(),
}));

import { sendToFeishu } from './feishu.js';
import { isBotConfigured, sendViaBot } from './feishu-bot.js';
import { httpPost } from '../../util/http.js';
import { getConfig } from '../config.js';

const mockIsBotConfigured = isBotConfigured as unknown as ReturnType<typeof vi.fn>;
const mockSendViaBot = sendViaBot as unknown as ReturnType<typeof vi.fn>;
const mockHttpPost = httpPost as unknown as ReturnType<typeof vi.fn>;
const mockGetConfig = getConfig as unknown as ReturnType<typeof vi.fn>;

const fakeCfg = () => ({
  feishu_webhook_url: 'https://webhook.example.com',
  feishu_app_id: 'cli_test',
  feishu_app_secret: 'secret_test',
  feishu_encrypt_key: 'encrypt_test',
  feishu_verification_token: 'token_test',
  feishu_default_receive_id: 'oc_test',
  feishu_default_receive_id_type: 'chat_id',
  ua: 'test',
  request_timeout_ms: 10000,
  max_retries: 3,
  doh_enabled: true,
  doh_server: 'https://1.1.1.1/dns-query',
  doh_bypass: [],
  tg_bot_token: null,
  tg_chat_id: null,
  timezone: 'Asia/Shanghai',
  schedule_rule: '0 */10 * * * *',
  alert_cooldown_hours: 1,
});

describe('sendToFeishu routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue(fakeCfg());
  });

  it('Bot 配置齐全且 sendViaBot 成功 → 走 Bot，不调 webhook', async () => {
    mockIsBotConfigured.mockReturnValue(true);
    mockSendViaBot.mockResolvedValue({ ok: true });
    const result = await sendToFeishu('test message');
    expect(result.ok).toBe(true);
    expect(mockSendViaBot).toHaveBeenCalled();
    expect(mockHttpPost).not.toHaveBeenCalled();
  });

  it('Bot 未配置 → 走 webhook', async () => {
    mockIsBotConfigured.mockReturnValue(false);
    mockHttpPost.mockResolvedValue({ data: { code: 0 } });
    const result = await sendToFeishu('test message');
    expect(result.ok).toBe(true);
    expect(mockSendViaBot).not.toHaveBeenCalled();
    expect(mockHttpPost).toHaveBeenCalled();
  });

  it('Bot 调用失败 → 降级到 webhook', async () => {
    mockIsBotConfigured.mockReturnValue(true);
    mockSendViaBot.mockResolvedValue({ ok: false, error: 'bot fail' });
    mockHttpPost.mockResolvedValue({ data: { code: 0 } });
    const result = await sendToFeishu('test message');
    expect(result.ok).toBe(true);
    expect(mockSendViaBot).toHaveBeenCalled();
    expect(mockHttpPost).toHaveBeenCalled();
  });

  it('webhook 也失败 → 返回失败', async () => {
    mockIsBotConfigured.mockReturnValue(true);
    mockSendViaBot.mockResolvedValue({ ok: false, error: 'bot fail' });
    mockHttpPost.mockResolvedValue({ data: { code: 11246, msg: 'bad' } });
    const result = await sendToFeishu('test message');
    expect(result.ok).toBe(false);
  });
});