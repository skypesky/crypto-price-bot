import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captured register() payloads so tests can replay the registered handler.
const { mockStart, mockRegister, mockWSClientCtor, mockDispatcherCtor } = vi.hoisted(() => {
  const mockStart = vi.fn();
  const mockRegister = vi.fn();
  const mockWSClientCtor = vi.fn();
  const mockDispatcherCtor = vi.fn();
  return { mockStart, mockRegister, mockWSClientCtor, mockDispatcherCtor };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  // Mocked EventDispatcher: register() stores the handles map so the test
  // can inspect and replay handlers.
  class MockEventDispatcher {
    public readonly opts: unknown;
    public handles: Record<string, (...args: unknown[]) => unknown> = {};
    constructor(opts: unknown) {
      mockDispatcherCtor(opts);
    }
    register(handles: Record<string, (...args: unknown[]) => unknown>) {
      mockRegister(handles);
      this.handles = { ...this.handles, ...handles };
      return this;
    }
  }

  class MockWSClient {
    public readonly opts: unknown;
    public start = mockStart;
    constructor(opts: unknown) {
      mockWSClientCtor(opts);
    }
  }

  return {
    WSClient: MockWSClient,
    EventDispatcher: MockEventDispatcher,
  };
});

vi.mock('../config.js', () => ({
  getConfig: vi.fn(() => ({
    feishu_app_id: 'cli_test',
    feishu_app_secret: 'sec',
    // WS 模式下不需要 encrypt_key / verification_token；
    // 配置里没有这两个字段，证明 WS 路径不依赖它们。
    feishu_encrypt_key: null,
    feishu_verification_token: null,
    feishu_default_receive_id: 'oc_x',
    feishu_default_receive_id_type: 'chat_id',
  })),
}));

vi.mock('./feishu-bot.js', () => ({
  isBotConfigured: vi.fn(() => false),
  isBotMinimalConfig: vi.fn(() => true),
}));

vi.mock('../task-user.js', () => ({
  runTaskForUser: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { startFeishuWs, _resetFeishuWsForTests } from './feishu-ws.js';
import { isBotMinimalConfig } from './feishu-bot.js';
import { runTaskForUser } from '../task-user.js';

const mockIsBotMinimalConfig = isBotMinimalConfig as unknown as ReturnType<typeof vi.fn>;
const mockRunTaskForUser = runTaskForUser as unknown as ReturnType<typeof vi.fn>;

describe('startFeishuWs', () => {
  beforeEach(() => {
    _resetFeishuWsForTests();
    vi.clearAllMocks();
    mockIsBotMinimalConfig.mockReturnValue(true);
    mockRunTaskForUser.mockResolvedValue({ ok: true });
  });

  it('Bot 配置齐全 → 创建 WSClient + dispatcher + 调用 client.start()', () => {
    startFeishuWs();
    expect(mockWSClientCtor).toHaveBeenCalledTimes(1);
    expect(mockDispatcherCtor).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
    // start() receives the dispatcher instance via { eventDispatcher }
    const startArg = mockStart.mock.calls[0]?.[0] as { eventDispatcher?: unknown };
    expect(startArg?.eventDispatcher).toBeDefined();
  });

  it('Bot 未配置（缺 app_id/app_secret） → 跳过，不创建 WSClient', () => {
    mockIsBotMinimalConfig.mockReturnValue(false);
    startFeishuWs();
    expect(mockWSClientCtor).not.toHaveBeenCalled();
    expect(mockDispatcherCtor).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('重复调用 → 仅启动一次（idempotent）', () => {
    startFeishuWs();
    startFeishuWs();
    startFeishuWs();
    expect(mockWSClientCtor).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('注册到 dispatcher 的 card.action.trigger handler 调用 runTaskForUser', async () => {
    startFeishuWs();
    const handles = mockRegister.mock.calls[0]?.[0] as Record<string, (data: unknown) => unknown>;
    expect(handles).toBeDefined();
    expect(typeof handles['card.action.trigger']).toBe('function');

    // SDK 把 card.action.trigger 的 event 体扁平化注入 handler：
    //   { type: 'card.action.trigger', operator: { open_id, user_id },
    //     action: { value: { action: 'query_now' }, tag } }
    const handler = handles['card.action.trigger'];
    await handler({
      type: 'card.action.trigger',
      operator: { open_id: 'ou_user' },
      action: { value: { action: 'query_now' }, tag: 'button' },
    });

    // 等待 fire-and-forget 的 promise 落地
    await new Promise((r) => setTimeout(r, 0));

    expect(mockRunTaskForUser).toHaveBeenCalledTimes(1);
    expect(mockRunTaskForUser).toHaveBeenCalledWith('ou_user', 'open_id');
  });

  it('未识别的 action → 不调 runTaskForUser', async () => {
    startFeishuWs();
    const handles = mockRegister.mock.calls[0]?.[0] as Record<string, (data: unknown) => unknown>;
    const handler = handles['card.action.trigger'];
    await handler({
      type: 'card.action.trigger',
      operator: { open_id: 'ou_user' },
      action: { value: { action: 'unknown_thing' }, tag: 'button' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRunTaskForUser).not.toHaveBeenCalled();
  });

  it('handler 缺少 open_id → 不调 runTaskForUser（防御）', async () => {
    startFeishuWs();
    const handles = mockRegister.mock.calls[0]?.[0] as Record<string, (data: unknown) => unknown>;
    const handler = handles['card.action.trigger'];
    await handler({
      type: 'card.action.trigger',
      operator: {},
      action: { value: { action: 'query_now' }, tag: 'button' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRunTaskForUser).not.toHaveBeenCalled();
  });
});