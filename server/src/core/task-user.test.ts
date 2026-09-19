import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock 依赖：runTask（来自 ./task.js）+ sendViaBot（来自 ./notify/feishu-bot.js）
vi.mock('./task.js', () => ({
  runTask: vi.fn(),
}));

vi.mock('./notify/feishu-bot.js', () => ({
  sendViaBot: vi.fn(),
  isBotConfigured: vi.fn(() => true),
}));

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({})),
}));

import { runTaskForUser } from './task-user.js';
import { runTask, type TaskRunResult } from './task.js';
import { sendViaBot } from './notify/feishu-bot.js';

const mockRunTask = runTask as unknown as ReturnType<typeof vi.fn>;
const mockSendViaBot = sendViaBot as unknown as ReturnType<typeof vi.fn>;

const fakeResult = (overrides: Partial<TaskRunResult> = {}): TaskRunResult => ({
  reportId: 100,
  triggered_by: 'manual',
  success: true,
  totalCoins: 7,
  okCoins: 7,
  tgSent: false,
  feishuSent: false,
  message: '📊 *测试报告* from local\n\n🔹 *比特币* (BTC)\n   💰 人民币：`¥1.00`\n   🔗 [Gate](https://gate.com/btc) | [CoinGecko](https://cg.com/btc)\n\n⏰ 更新时间',
  ...overrides,
});

describe('runTaskForUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功：runTask + sendViaBot 都返回 ok → ok=true', async () => {
    mockRunTask.mockResolvedValue(fakeResult());
    mockSendViaBot.mockResolvedValue({ ok: true });
    const result = await runTaskForUser('ou_user', 'open_id');
    expect(result.ok).toBe(true);
    expect(result.reportId).toBe(100);
    expect(mockSendViaBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ msg_type: expect.stringMatching(/text|interactive/) }),
      'ou_user',
      'open_id'
    );
  });

  it('runTask 失败 → ok=false, error', async () => {
    mockRunTask.mockResolvedValue(fakeResult({ success: false, okCoins: 0 }));
    const result = await runTaskForUser('ou_user', 'open_id');
    expect(result.ok).toBe(false);
    expect(mockSendViaBot).not.toHaveBeenCalled();
  });

  it('sendViaBot 失败 → ok=true（report 已生成）, error 仅警告', async () => {
    mockRunTask.mockResolvedValue(fakeResult());
    mockSendViaBot.mockResolvedValue({ ok: false, error: 'bot fail' });
    const result = await runTaskForUser('ou_user', 'open_id');
    expect(result.ok).toBe(true);  // 报告生成了就算成功
    expect(result.reportId).toBe(100);
    expect(result.error).toBe('bot fail');
  });
});