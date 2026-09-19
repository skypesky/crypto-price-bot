import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequest } = vi.hoisted(() => {
  const mockRequest = vi.fn();
  return { mockRequest };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    Client: class {
      async request(...args: unknown[]) {
        return mockRequest(...args);
      }
    },
    EventDispatcher: class {},
  };
});

import { isBotConfigured, sendViaBot } from './feishu-bot.js';
import type { Config } from '../config.js';

const baseCfg = (): Config => ({
  tg_bot_token: null,
  tg_chat_id: null,
  feishu_webhook_url: 'https://webhook.example.com',
  feishu_app_id: 'cli_test',
  feishu_app_secret: 'secret_test',
  feishu_encrypt_key: 'encrypt_test',
  feishu_verification_token: 'token_test',
  feishu_default_receive_id: 'oc_test',
  feishu_default_receive_id_type: 'chat_id',
  timezone: 'Asia/Shanghai',
  schedule_rule: '0 */10 * * * *',
  ua: 'test',
  doh_enabled: true,
  doh_server: 'https://1.1.1.1/dns-query',
  doh_bypass: [],
  request_timeout_ms: 10000,
  max_retries: 3,
  alert_cooldown_hours: 1,
});

describe('isBotConfigured', () => {
  it('全字段非空 → true', () => {
    expect(isBotConfigured(baseCfg())).toBe(true);
  });

  it('app_id 缺失 → false', () => {
    const cfg = baseCfg();
    cfg.feishu_app_id = null;
    expect(isBotConfigured(cfg)).toBe(false);
  });

  it('app_secret 缺失 → false', () => {
    const cfg = baseCfg();
    cfg.feishu_app_secret = null;
    expect(isBotConfigured(cfg)).toBe(false);
  });

  it('encrypt_key 缺失 → false', () => {
    const cfg = baseCfg();
    cfg.feishu_encrypt_key = null;
    expect(isBotConfigured(cfg)).toBe(false);
  });

  it('verification_token 缺失 → false', () => {
    const cfg = baseCfg();
    cfg.feishu_verification_token = null;
    expect(isBotConfigured(cfg)).toBe(false);
  });

  it('default_receive_id 缺失 → false', () => {
    const cfg = baseCfg();
    cfg.feishu_default_receive_id = null;
    expect(isBotConfigured(cfg)).toBe(false);
  });

  it('default_receive_id_type 缺失 → false', () => {
    const cfg = baseCfg();
    cfg.feishu_default_receive_id_type = 'chat_id';
    // cast through unknown to force-set null in test only
    (cfg as unknown as { feishu_default_receive_id_type: null }).feishu_default_receive_id_type = null;
    expect(isBotConfigured(cfg)).toBe(false);
  });
});

describe('sendViaBot', () => {
  beforeEach(() => mockRequest.mockReset());

  it('成功返回 ok=true', async () => {
    mockRequest.mockResolvedValue({ code: 0, msg: 'success' });
    const result = await sendViaBot(baseCfg(), { msg_type: 'text', content: { text: 'hi' } }, 'oc_xxx', 'chat_id');
    expect(result).toEqual({ ok: true });
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining('/im/v1/messages'),
      method: 'POST',
    }));
  });

  it('失败 code !== 0 → ok=false with error', async () => {
    mockRequest.mockResolvedValue({ code: 230020, msg: 'permission denied' });
    const result = await sendViaBot(baseCfg(), { msg_type: 'text', content: { text: 'hi' } }, 'oc_xxx', 'chat_id');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('permission denied');
  });

  it('SDK 抛错 → ok=false with error', async () => {
    // mockImplementationOnce 返回一个已 attach handler 的拒绝 Promise，
    // 避免 vitest 把 mock 的 rejection 视作 unhandledRejection 标记测试失败。
    mockRequest.mockImplementationOnce(() => {
      const p = Promise.reject(new Error('network down'));
      p.catch(() => {});
      return p;
    });
    const result = await sendViaBot(baseCfg(), { msg_type: 'text', content: { text: 'hi' } }, 'oc_xxx', 'chat_id');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('network down');
  });
});
