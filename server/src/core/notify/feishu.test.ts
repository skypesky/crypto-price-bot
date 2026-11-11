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

// 完整报告样例（与 buildMessage 输出格式一致）：用于验证 webhook 走卡片通道
const SAMPLE_REPORT = `📊 *加密货币价格报告 (含技术指标) from local*

🔹 *比特币* (BTC)
   💵 \`$50,000.00(¥360,000.00)[汇率: 7.20]\`
   🔗 [Gate](https://www.gate.com/zh/trade/BTC_USDT) | [Binance](https://www.binance.com/zh-CN/trade/BTC_USDT?type=spot) | [CoinGlass](https://www.coinglass.com/zh/currencies/BTC) | [CoinGecko](https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/bitcoin)

⏰ 更新时间: 2026/9/17 00:00:00
⚠️ MA（移动平均线）仅供参考，不构成投资建议`;

describe('sendToFeishu webhook 卡片化', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue(fakeCfg());
    mockIsBotConfigured.mockReturnValue(false);
    mockHttpPost.mockResolvedValue({ data: { code: 0 } });
  });

  it('完整报告 → webhook 发 interactive 卡片，链接渲染为可点击的 url 按钮', async () => {
    const result = await sendToFeishu(SAMPLE_REPORT);
    expect(result.ok).toBe(true);

    const body = mockHttpPost.mock.calls[0][1] as {
      msg_type: string;
      card?: { elements: Array<{ tag: string; actions?: Array<{ text: { content: string }; url?: string }> }> };
    };
    expect(body.msg_type).toBe('interactive');
    expect(body.card).toBeTruthy();

    const actions = body.card!.elements.find(e => e.tag === 'action');
    expect(actions?.actions?.map(a => a.text.content)).toEqual(['Gate', 'Binance', 'CoinGlass', 'CoinGecko']);
    expect(actions?.actions?.every(a => a.url?.startsWith('http'))).toBe(true);
  });

  it('webhook 卡片不含「立即查询」回调按钮（webhook 无事件订阅通道）', async () => {
    await sendToFeishu(SAMPLE_REPORT);
    const body = mockHttpPost.mock.calls[0][1] as {
      card?: { elements: Array<{ tag: string; actions?: Array<{ text: { content: string }; value?: unknown }> }> };
    };
    const hasQueryBtn = body.card?.elements.some(
      e => e.tag === 'action' && e.actions?.some(a => a.text.content === '🔄 立即查询')
    );
    expect(hasQueryBtn).toBe(false);
  });

  it('简单消息（价格预警等）→ webhook 仍走 text 通道', async () => {
    const result = await sendToFeishu('🚨 价格预警\n\n🔺 比特币 (BTC) 突破上限');
    expect(result.ok).toBe(true);

    const body = mockHttpPost.mock.calls[0][1] as { msg_type: string; content?: { text: string } };
    expect(body.msg_type).toBe('text');
    expect(body.content?.text).toContain('突破上限');
  });
});