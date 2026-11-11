import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../util/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../util/http.js')>();
  return { ...actual, httpPost: vi.fn() };
});

vi.mock('../config.js', () => ({
  getConfig: vi.fn(),
}));

import { sendToTG } from './telegram.js';
import { httpPost, HttpError } from '../../util/http.js';
import { getConfig } from '../config.js';

const mockHttpPost = httpPost as unknown as ReturnType<typeof vi.fn>;
const mockGetConfig = getConfig as unknown as ReturnType<typeof vi.fn>;

/** 造一个测试用配置；tg_bot_token / tg_chat_id / doh_enabled 可切换。 */
const fakeCfg = (over: Partial<Record<string, unknown>> = {}) => ({
  tg_bot_token: 'bot-token',
  tg_chat_id: 'chat-id',
  feishu_webhook_url: null,
  feishu_app_id: null,
  feishu_app_secret: null,
  feishu_encrypt_key: null,
  feishu_verification_token: null,
  feishu_default_receive_id: null,
  feishu_default_receive_id_type: 'chat_id' as const,
  timezone: 'Asia/Shanghai',
  schedule_rule: '0 */10 * * * *',
  ua: 'test-ua',
  doh_enabled: true,
  doh_server: '1.1.1.1',
  doh_bypass: ['1.1.1.1'],
  request_timeout_ms: 10000,
  max_retries: 3,
  alert_cooldown_hours: 24,
  ...over,
});

/** 让 httpPost 返回指定 data。 */
function mockPost(data: unknown) {
  mockHttpPost.mockResolvedValueOnce({ status: 200, headers: new Headers(), data });
}

/** 取出发给 httpPost 的第一个参数（URL）。 */
function calledUrl(): string {
  return mockHttpPost.mock.calls[0]![0] as string;
}

/** 取出发给 httpPost 的第二个参数（body）。 */
function calledBody(): Record<string, unknown> {
  return mockHttpPost.mock.calls[0]![1] as Record<string, unknown>;
}

/** 取出发给 httpPost 的第三个参数（options）。 */
function calledOpts(): Record<string, unknown> {
  return mockHttpPost.mock.calls[0]![2] as Record<string, unknown>;
}

/** 造一条会被拆成 2 段的超长消息（两个段落，单段均不超过 3800）。 */
function longMessage(): string {
  return `${'A'.repeat(2000)}\n\n${'B'.repeat(2000)}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockReturnValue(fakeCfg());
});

describe('sendToTG', () => {
  it('成功返回 → ok=true', async () => {
    mockPost({ ok: true });

    expect(await sendToTG('hello')).toEqual({ ok: true });
  });

  it('短消息 → 只发一条请求，body 带 chat_id/text/parse_mode', async () => {
    mockPost({ ok: true });

    await sendToTG('hello');

    expect(mockHttpPost).toHaveBeenCalledTimes(1);
    expect(calledBody()).toEqual({
      chat_id: 'chat-id',
      text: 'hello',
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  });

  it('URL 里带上 bot token', async () => {
    mockPost({ ok: true });

    await sendToTG('hello');

    expect(calledUrl()).toBe('https://api.telegram.org/botbot-token/sendMessage');
  });

  it('空消息 → 仍然发一条空文本请求', async () => {
    mockPost({ ok: true });

    const r = await sendToTG('');

    expect(r).toEqual({ ok: true });
    expect(calledBody().text).toBe('');
  });

  it('未配置 tg_bot_token → 直接返回 ok=false，不发请求', async () => {
    mockGetConfig.mockReturnValue(fakeCfg({ tg_bot_token: null }));

    expect(await sendToTG('hello')).toEqual({
      ok: false,
      error: 'telegram not configured (tg_bot_token / tg_chat_id missing)',
    });
    expect(mockHttpPost).not.toHaveBeenCalled();
  });

  it('未配置 tg_chat_id（token 有）→ 直接返回 ok=false，不发请求', async () => {
    mockGetConfig.mockReturnValue(fakeCfg({ tg_chat_id: null }));

    expect(await sendToTG('hello')).toEqual({
      ok: false,
      error: 'telegram not configured (tg_bot_token / tg_chat_id missing)',
    });
    expect(mockHttpPost).not.toHaveBeenCalled();
  });

  it('Telegram 返回 ok=false → 返回 ok=false 并带上 description', async () => {
    mockPost({ ok: false, description: 'chat not found' });

    const r = await sendToTG('hello');

    expect(r.ok).toBe(false);
    expect(r.error).toBe('telegram api returned ok=false (part 1/1)');
    expect(r.description).toBe('chat not found');
  });

  it('Telegram 返回 ok=false 且无 description → description 为 undefined', async () => {
    mockPost({ ok: false });

    const r = await sendToTG('hello');

    expect(r.ok).toBe(false);
    expect(r.description).toBeUndefined();
  });

  it('超长消息 → 拆成多条依次发送，全部成功时 ok=true', async () => {
    mockPost({ ok: true });
    mockPost({ ok: true });

    const r = await sendToTG(longMessage());

    expect(r).toEqual({ ok: true });
    expect(mockHttpPost).toHaveBeenCalledTimes(2);
    expect(calledBody().text).toHaveLength(2000);
  });

  it('超长消息的第二段失败 → 返回 part 2/2 的错误', async () => {
    mockPost({ ok: true });
    mockPost({ ok: false, description: 'too long' });

    const r = await sendToTG(longMessage());

    expect(r.ok).toBe(false);
    expect(r.error).toBe('telegram api returned ok=false (part 2/2)');
    expect(r.description).toBe('too long');
  });

  it('HTTP 错误（HttpError）→ ok=false，description 带上状态码', async () => {
    mockHttpPost.mockRejectedValueOnce(new HttpError('HTTP 429 Too Many Requests', 429));

    const r = await sendToTG('hello');

    expect(r.ok).toBe(false);
    expect(r.error).toBe('HTTP 429 Too Many Requests');
    expect(r.description).toBe('HTTP 429');
  });

  it('HttpError 但没有状态码 → description 变成 "HTTP undefined"', async () => {
    mockHttpPost.mockRejectedValueOnce(new HttpError('boom'));

    const r = await sendToTG('hello');

    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom');
    expect(r.description).toBe('HTTP undefined');
  });

  it('网络异常（非 HttpError）→ ok=false，只带 error 不带 description', async () => {
    mockHttpPost.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.telegram.org'));

    const r = await sendToTG('hello');

    expect(r.ok).toBe(false);
    expect(r.error).toBe('getaddrinfo ENOTFOUND api.telegram.org');
    expect(r.description).toBeUndefined();
  });

  it('超时（AbortError）→ ok=false', async () => {
    mockHttpPost.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));

    const r = await sendToTG('hello');

    expect(r.ok).toBe(false);
    expect(r.error).toBe('The operation was aborted due to timeout');
  });

  it('doh_enabled=true → 传入 DoH endpoint 与 bypass 集合', async () => {
    mockPost({ ok: true });

    await sendToTG('hello');

    const doh = calledOpts().doh as { endpoint: string; bypass: Set<string> };
    expect(doh.endpoint).toBe('https://1.1.1.1/dns-query');
    expect(doh.bypass).toBeInstanceOf(Set);
    expect(doh.bypass.has('1.1.1.1')).toBe(true);
  });

  it('doh_enabled=false → doh 传 null', async () => {
    mockGetConfig.mockReturnValue(fakeCfg({ doh_enabled: false }));
    mockPost({ ok: true });

    await sendToTG('hello');

    expect(calledOpts().doh).toBeNull();
  });

  it('超时/重试/UA 取自配置并透传给 httpPost', async () => {
    mockPost({ ok: true });

    await sendToTG('hello');

    expect(calledOpts().timeoutMs).toBe(10000);
    expect(calledOpts().retries).toBe(3);
    expect(calledOpts().headers).toEqual({ 'User-Agent': 'test-ua' });
  });
});
