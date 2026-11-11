import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock 依赖：runTask（来自 ./task.js）+ sendViaBot（来自 ./notify/feishu-bot.js）
vi.mock('./task.js', () => ({
  runTask: vi.fn(),
}));

vi.mock('./notify/feishu-bot.js', () => ({
  sendViaBot: vi.fn(),
  isBotConfigured: vi.fn(),
}));

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({})),
}));

import { runTaskForUser } from './task-user.js';
import { runTask, type TaskRunResult } from './task.js';
import { sendViaBot, isBotConfigured } from './notify/feishu-bot.js';

const mockRunTask = runTask as unknown as ReturnType<typeof vi.fn>;
const mockSendViaBot = sendViaBot as unknown as ReturnType<typeof vi.fn>;
const mockIsBotConfigured = isBotConfigured as unknown as ReturnType<typeof vi.fn>;

const fakeResult = (overrides: Partial<TaskRunResult> = {}): TaskRunResult => ({
  reportId: 100,
  triggered_by: 'manual',
  success: true,
  totalCoins: 7,
  okCoins: 7,
  tgSent: false,
  feishuSent: false,
  message: '📊 *测试报告* from local\n\n🔹 *比特币* (BTC)\n   💵 `$1.00(¥7.20)[汇率: 7.20]`\n   🔗 [Gate](https://www.gate.com/zh/trade/BTC_USDT) | [CoinGlass](https://www.coinglass.com/zh/currencies/BTC) | [CoinGecko](https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/bitcoin)\n\n⏰ 更新时间',
  ...overrides,
});

/** 简单消息（价格预警），不含 🔗 [Gate]( 链接 → 走 text 通道而非卡片 */
const SIMPLE_MESSAGE = '🚨 价格预警\n\n🔺 比特币 (BTC) 突破上限';

describe('runTaskForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBotConfigured.mockReturnValue(true);
  });

  it('成功：runTask + sendViaBot 都返回 ok → ok=true', async () => {
    mockRunTask.mockResolvedValue(fakeResult());
    mockSendViaBot.mockResolvedValue({ ok: true });
    const result = await runTaskForUser('__test_ou_user', 'open_id');
    expect(result.ok).toBe(true);
    expect(result.reportId).toBe(100);
    expect(mockSendViaBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ msg_type: expect.stringMatching(/text|interactive/) }),
      '__test_ou_user',
      'open_id'
    );
  });

  it('runTask 失败 → ok=false, error', async () => {
    mockRunTask.mockResolvedValue(fakeResult({ success: false, okCoins: 0 }));
    const result = await runTaskForUser('__test_ou_user', 'open_id');
    expect(result.ok).toBe(false);
    expect(mockSendViaBot).not.toHaveBeenCalled();
  });

  it('sendViaBot 失败 → ok=true（report 已生成）, error 仅警告', async () => {
    mockRunTask.mockResolvedValue(fakeResult());
    mockSendViaBot.mockResolvedValue({ ok: false, error: 'bot fail' });
    const result = await runTaskForUser('__test_ou_user', 'open_id');
    expect(result.ok).toBe(true);  // 报告生成了就算成功
    expect(result.reportId).toBe(100);
    expect(result.error).toBe('bot fail');
  });

  // ---- 补齐缺口 ----

  it('Bot 未配置 → 直接返回 bot not configured，不跑任务也不推送', async () => {
    mockIsBotConfigured.mockReturnValue(false);
    const result = await runTaskForUser('__test_ou_user', 'open_id');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('bot not configured');
    expect(result.reportId).toBeUndefined();
    expect(mockRunTask).not.toHaveBeenCalled();
    expect(mockSendViaBot).not.toHaveBeenCalled();
  });

  it('runTask 抛错 → 被捕获，返回 ok=false 与错误信息', async () => {
    mockRunTask.mockRejectedValue(new Error('runTask boom'));
    const result = await runTaskForUser('__test_ou_user', 'open_id');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('runTask boom');
    expect(mockSendViaBot).not.toHaveBeenCalled();
  });

  it('sendViaBot 抛错 → 被捕获，返回 ok=false 与错误信息', async () => {
    mockRunTask.mockResolvedValue(fakeResult());
    mockSendViaBot.mockRejectedValue(new Error('sendViaBot boom'));
    const result = await runTaskForUser('__test_ou_user', 'open_id');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('sendViaBot boom');
  });

  it('完整报告 → 走飞书 interactive 卡片通道', async () => {
    mockRunTask.mockResolvedValue(fakeResult());
    mockSendViaBot.mockResolvedValue({ ok: true });
    await runTaskForUser('__test_ou_user', 'open_id');
    const payload = mockSendViaBot.mock.calls[0]![1] as { msg_type: string; card?: unknown };
    expect(payload.msg_type).toBe('interactive');
    expect(payload.card).toBeTruthy();
  });

  it('简单消息（价格预警）→ 降级走 text 通道', async () => {
    mockRunTask.mockResolvedValue(fakeResult({ message: SIMPLE_MESSAGE }));
    mockSendViaBot.mockResolvedValue({ ok: true });
    const result = await runTaskForUser('__test_ou_user', 'open_id');
    expect(result.ok).toBe(true);
    const payload = mockSendViaBot.mock.calls[0]![1] as { msg_type: string; content?: { text: string } };
    expect(payload.msg_type).toBe('text');
    expect(payload.content?.text).toContain('突破上限');
  });

  it('不传 receiveIdType → 默认 open_id', async () => {
    mockRunTask.mockResolvedValue(fakeResult());
    mockSendViaBot.mockResolvedValue({ ok: true });
    await runTaskForUser('__test_ou_user');
    expect(mockSendViaBot).toHaveBeenCalledWith(expect.anything(), expect.anything(), '__test_ou_user', 'open_id');
  });

  it('runTask 失败时也带上 reportId', async () => {
    mockRunTask.mockResolvedValue(fakeResult({ success: false, okCoins: 0, reportId: 321 }));
    const result = await runTaskForUser('__test_ou_user', 'open_id');
    expect(result.ok).toBe(false);
    expect(result.reportId).toBe(321);
    expect(result.error).toBe('coin fetch failed');
  });
});
