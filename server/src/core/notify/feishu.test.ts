import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// 让被测模块里的 logger 处于 debug 级别，便于断言 debug 分支的输出。
// 必须在 import 之前设置：logger 实例在模块加载时就确定了初始级别。
const { restoreLogLevel } = vi.hoisted(() => {
  const original = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'debug';
  return {
    restoreLogLevel: () => {
      if (original === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = original;
    },
  };
});

vi.mock('./feishu-bot.js', () => ({
  isBotConfigured: vi.fn(),
  sendViaBot: vi.fn(),
}));

vi.mock('../../util/http.js', () => ({
  httpPost: vi.fn(),
  HttpError: class HttpError extends Error {
    status?: number;
    constructor(msg: string, status?: number) {
      super(msg);
      this.name = 'HttpError';
      this.status = status;
    }
  },
}));

vi.mock('../config.js', () => ({
  getConfig: vi.fn(),
}));

import { sendToFeishu } from './feishu.js';
import { isBotConfigured, sendViaBot } from './feishu-bot.js';
import { httpPost, HttpError } from '../../util/http.js';
import { getConfig } from '../config.js';

const mockIsBotConfigured = isBotConfigured as unknown as ReturnType<typeof vi.fn>;
const mockSendViaBot = sendViaBot as unknown as ReturnType<typeof vi.fn>;
const mockHttpPost = httpPost as unknown as ReturnType<typeof vi.fn>;
const mockGetConfig = getConfig as unknown as ReturnType<typeof vi.fn>;

afterAll(() => {
  restoreLogLevel();
});

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

describe('sendToFeishu 未配置 / 降级', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('既没有 webhook 也没有 bot 凭证 → 直接返回未配置', async () => {
    mockGetConfig.mockReturnValue({ ...fakeCfg(), feishu_webhook_url: null });
    mockIsBotConfigured.mockReturnValue(false);
    const result = await sendToFeishu('__test_message');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('feishu not configured');
    expect(mockHttpPost).not.toHaveBeenCalled();
    expect(mockSendViaBot).not.toHaveBeenCalled();
  });

  it('bot 发送失败且没有 webhook → 返回 webhook 未配置', async () => {
    mockGetConfig.mockReturnValue({ ...fakeCfg(), feishu_webhook_url: null });
    mockIsBotConfigured.mockReturnValue(true);
    mockSendViaBot.mockResolvedValue({ ok: false, error: '__test_bot_fail' });
    const result = await sendToFeishu('__test_message');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('feishu webhook not configured');
  });

  it('bot 调用抛异常 → 降级到 webhook 并发送成功', async () => {
    mockGetConfig.mockReturnValue(fakeCfg());
    mockIsBotConfigured.mockReturnValue(true);
    mockSendViaBot.mockRejectedValue(new Error('__test_bot_throw'));
    mockHttpPost.mockResolvedValue({ data: { code: 0 } });
    const result = await sendToFeishu('__test_message');
    expect(result.ok).toBe(true);
    expect(mockSendViaBot).toHaveBeenCalledTimes(1);
    expect(mockHttpPost).toHaveBeenCalledTimes(1);
  });
});

describe('sendToFeishu Bot 通道 payload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue(fakeCfg());
    mockIsBotConfigured.mockReturnValue(true);
    mockSendViaBot.mockResolvedValue({ ok: true });
  });

  it('完整报告走 Bot → 发送 interactive 卡片（含「立即查询」回调按钮）', async () => {
    const result = await sendToFeishu(SAMPLE_REPORT);
    expect(result.ok).toBe(true);

    const payload = mockSendViaBot.mock.calls[0]?.[1] as {
      msg_type: string;
      card?: { elements: Array<{ tag: string; actions?: Array<{ text: { content: string } }> }> };
    };
    expect(payload.msg_type).toBe('interactive');
    expect(payload.card).toBeTruthy();
    const hasQueryBtn = payload.card?.elements.some(
      e => e.tag === 'action' && e.actions?.some(a => a.text.content === '🔄 立即查询')
    );
    expect(hasQueryBtn).toBe(true);
  });

  it('简单消息走 Bot → 发送 text 类型并做纯文本规范化', async () => {
    const result = await sendToFeishu('*粗体* [链接](https://example.com)');
    expect(result.ok).toBe(true);

    const payload = mockSendViaBot.mock.calls[0]?.[1] as { msg_type: string; content?: { text: string } };
    expect(payload.msg_type).toBe('text');
    // 规范化：去掉 markdown 星号、把 [text](url) 展开成 "text: url"
    expect(payload.content?.text).toBe('粗体 链接: https://example.com');
  });

  it('Bot 通道使用配置里的 receive_id 与 id_type', async () => {
    await sendToFeishu('__test_message');
    expect(mockSendViaBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'oc_test',
      'chat_id',
    );
  });
});

describe('sendToFeishu webhook 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue(fakeCfg());
    mockIsBotConfigured.mockReturnValue(false);
  });

  it('返回体含非 0 StatusCode → 失败并带上状态码', async () => {
    mockHttpPost.mockResolvedValue({ data: { StatusCode: 19021, msg: '__test_bad_sign' } });
    const result = await sendToFeishu('__test_message');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('StatusCode=19021');
    expect(result.error).toContain('__test_bad_sign');
  });

  it('返回体含非 0 code → 失败并带上错误码', async () => {
    mockHttpPost.mockResolvedValue({ data: { code: 11246, msg: '__test_bad' } });
    const result = await sendToFeishu('__test_message');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('code=11246');
  });

  it('返回体没有 code 字段 → 视为成功', async () => {
    mockHttpPost.mockResolvedValue({ data: {} });
    const result = await sendToFeishu('__test_message');
    expect(result.ok).toBe(true);
  });

  it('抛出 HttpError → 失败并带上 HTTP 状态码', async () => {
    mockHttpPost.mockRejectedValue(new HttpError('__test_http_error', 500));
    const result = await sendToFeishu('__test_message');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('__test_http_error');
    expect(result.error).toContain('(HTTP 500)');
  });

  it('抛出普通 Error → 失败并带出错误信息', async () => {
    mockHttpPost.mockRejectedValue(new Error('__test_plain_error'));
    const result = await sendToFeishu('__test_message');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('__test_plain_error');
  });

  it('FEISHU_DEBUG_BODY=1 → debug 日志打印完整请求体', async () => {
    const original = process.env.FEISHU_DEBUG_BODY;
    process.env.FEISHU_DEBUG_BODY = '1';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      mockHttpPost.mockResolvedValue({ data: { code: 0 } });
      const result = await sendToFeishu('__test_message');
      expect(result.ok).toBe(true);
      const out = stdoutSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(out).toContain('webhook body=');
      expect(out).toContain('testmessage');
    } finally {
      stdoutSpy.mockRestore();
      if (original === undefined) delete process.env.FEISHU_DEBUG_BODY;
      else process.env.FEISHU_DEBUG_BODY = original;
    }
  });

  it('默认情况 → debug 日志只打印 msg_type 与字节数', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      mockHttpPost.mockResolvedValue({ data: { code: 0 } });
      await sendToFeishu('__test_message');
      const out = stdoutSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(out).toContain('webhook send msg_type=text');
      expect(out).not.toContain('webhook body=');
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});