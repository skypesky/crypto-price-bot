import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Captured register() payloads so tests can replay the registered handler.
const { mockStart, mockRegister, mockWSClientCtor, mockDispatcherCtor, mockGetConfig } = vi.hoisted(() => {
  const mockStart = vi.fn();
  const mockRegister = vi.fn();
  const mockWSClientCtor = vi.fn();
  const mockDispatcherCtor = vi.fn();
  const mockGetConfig = vi.fn();
  return { mockStart, mockRegister, mockWSClientCtor, mockDispatcherCtor, mockGetConfig };
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

const defaultCfg = () => ({
  feishu_app_id: 'cli_test',
  feishu_app_secret: 'sec',
  // WS 模式下不需要 encrypt_key / verification_token；
  // 配置里没有这两个字段，证明 WS 路径不依赖它们。
  feishu_encrypt_key: null as string | null,
  feishu_verification_token: null as string | null,
  feishu_default_receive_id: 'oc_x',
  feishu_default_receive_id_type: 'chat_id',
});

vi.mock('../config.js', () => ({
  getConfig: mockGetConfig,
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

/** 取回注册到 dispatcher 上的 card.action.trigger handler */
function getHandler(): (data: unknown) => unknown {
  const handles = mockRegister.mock.calls[0]?.[0] as Record<string, (data: unknown) => unknown>;
  return handles['card.action.trigger'] as (data: unknown) => unknown;
}

describe('startFeishuWs', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetFeishuWsForTests();
    vi.clearAllMocks();
    mockStart.mockReset();
    mockGetConfig.mockReturnValue(defaultCfg());
    mockIsBotMinimalConfig.mockReturnValue(true);
    mockRunTaskForUser.mockResolvedValue({ ok: true });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
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

  it('事件体为空 / 缺字段 → 走 open_id 缺失分支，不调 runTaskForUser', () => {
    startFeishuWs();
    const handler = getHandler();
    expect(handler(undefined)).toEqual({});
    expect(handler({})).toEqual({});
    expect(handler({ operator: { open_id: 'ou_test' } })).toEqual({}); // 缺 action
    expect(mockRunTaskForUser).not.toHaveBeenCalled();
  });

  it('runTaskForUser 失败 → 记录 error，不影响 WS 回调返回', async () => {
    mockRunTaskForUser.mockRejectedValue(new Error('__test_dm_failed'));
    startFeishuWs();
    const handler = getHandler();
    const ret = await handler({
      operator: { open_id: 'ou_test_user' },
      action: { value: { action: 'query_now' }, tag: 'button' },
    });
    expect(ret).toEqual({});
    await new Promise((r) => setTimeout(r, 0));
    expect(String(stderrSpy.mock.calls.at(-1)?.[0])).toContain('runTaskForUser failed');
  });

  it('start() 返回 rejected promise → 记录 error 并复位幂等标志', async () => {
    mockStart.mockReturnValue(Promise.reject(new Error('__test_ws_handshake_failed')));
    startFeishuWs();
    await new Promise((r) => setTimeout(r, 0));
    expect(String(stderrSpy.mock.calls.at(-1)?.[0])).toContain('feishu WS start failed');

    // 幂等标志被复位 → 可以再次启动
    mockStart.mockReturnValue(undefined);
    startFeishuWs();
    expect(mockWSClientCtor).toHaveBeenCalledTimes(2);
  });

  it('start() 同步抛错 → 记录 error 并复位幂等标志', () => {
    mockStart.mockImplementation(() => {
      throw new Error('__test_ws_start_boom');
    });
    startFeishuWs();
    expect(String(stderrSpy.mock.calls.at(-1)?.[0])).toContain('failed to start feishu WS');

    mockStart.mockReturnValue(undefined);
    startFeishuWs();
    expect(mockWSClientCtor).toHaveBeenCalledTimes(2);
  });

  it('start() 返回非 Promise 值 → 不注册 catch 回调，也不报错', () => {
    mockStart.mockReturnValue({} as unknown as Promise<void>);
    startFeishuWs();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('配置了 verification_token / encrypt_key → 透传给 EventDispatcher', () => {
    mockGetConfig.mockReturnValue({
      ...defaultCfg(),
      feishu_verification_token: '__test_vtoken',
      feishu_encrypt_key: '__test_ekey',
    });
    startFeishuWs();
    expect(mockDispatcherCtor).toHaveBeenCalledWith({
      verificationToken: '__test_vtoken',
      encryptKey: '__test_ekey',
    });
  });

  it('未配置 verification_token / encrypt_key → 传 undefined', () => {
    startFeishuWs();
    expect(mockDispatcherCtor).toHaveBeenCalledWith({
      verificationToken: undefined,
      encryptKey: undefined,
    });
  });
});
