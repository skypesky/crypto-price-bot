import { describe, it, expect } from 'vitest';
import {
  isFullReportMessage,
  messageToFeishuCard,
  normalizeMessageForTextChannel,
  type FeishuCardPayload,
} from './formatter.js';

describe('normalizeMessageForTextChannel', () => {
  it('CRLF → LF', () => {
    expect(normalizeMessageForTextChannel('Line1\r\nLine2\r\nLine3')).toBe('Line1\nLine2\nLine3');
  });

  it('Markdown 链接 → text: url', () => {
    expect(normalizeMessageForTextChannel('[Gate 行情](https://www.gate.com/price/gate-gt)'))
      .toBe('Gate 行情: https://www.gate.com/price/gate-gt');
  });

  it('去除 markdown 字符', () => {
    expect(normalizeMessageForTextChannel('**bold** *italic* `code`'))
      .toBe('bold italic code');
  });

  it('混合内容', () => {
    const input = '📊 *今日加密货币价格报告*\n\n🔹 *[比特币](https://example.com/bitcoin)* (BTC)';
    const out = normalizeMessageForTextChannel(input);
    expect(out).toBe('📊 今日加密货币价格报告\n\n🔹 比特币: https://example.com/bitcoin (BTC)');
  });

  it('非字符串输入转字符串', () => {
    expect(normalizeMessageForTextChannel(123)).toBe('123');
    expect(normalizeMessageForTextChannel(null)).toBe('null');
    expect(normalizeMessageForTextChannel(undefined)).toBe('undefined');
  });

  it('空字符串', () => {
    expect(normalizeMessageForTextChannel('')).toBe('');
  });
});

// 完整报告样例（与 buildMessage 输出格式一致）。手写 fixture 避免在 formatter 测试里引入 db。
const SAMPLE_REPORT = `📊 *加密货币价格报告 (含技术指标) from local*

🔹 *比特币* (BTC)
   💰 人民币：\`¥360,000.00(7.20)\`
   💵 美元：\`$50,000.00\`
   ──────── 📈 趋势分析 ────────
   📅 7天:   🔺 +5.5%    📅 30天:  🔺 +10.2%
   📅 90天:  🔺 +20.0%   📅 180天: 🔺 +30.0%
   📅 1年:   🔺 +50.0%
   ──────── 📊 均线 (MA) ────────
   MA7:   ➡️ $49000.00 ¥352,800.00
   MA30:  ➡️ $48000.00 ¥345,600.00
   MA90:  📈 $45000.00 ¥324,000.00 (偏高)
   MA180: 📈 $40000.00 ¥288,000.00 (偏高)
   MA365: 📈 $30000.00 ¥216,000.00 (偏高)
   🔗 [Gate](https://www.gate.com/zh/price/bitcoin-btc) | [Binance](https://www.binance.com/zh-CN/price/bitcoin/) | [CoinGecko](https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/bitcoin)

⏰ 更新时间: 2026/9/17 00:00:00
⚠️ MA（移动平均线）仅供参考，不构成投资建议
数据展示以 CoinGecko 数据为准`;

// binance_slug=null 的币种报告（只有 Gate + CoinGecko 两个链接）
const SAMPLE_GT_REPORT = `📊 *加密货币价格报告 (含技术指标) from local*

🔹 *Gate* (GT)
   💰 人民币：\`¥63.00(7.00)\`
   💵 美元：\`$9.00\`
   📈 趋势数据暂时不可用
   🔗 [Gate](https://www.gate.com/zh/price/gate-gt) | [CoinGecko](https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/gatechain-token)

⏰ 更新时间: 2026/9/17 00:00:00
⚠️ MA（移动平均线）仅供参考，不构成投资建议
数据展示以 CoinGecko 数据为准`;

describe('isFullReportMessage', () => {
  it('含 🔗 [Gate]( 的完整报告 → true', () => {
    expect(isFullReportMessage(SAMPLE_REPORT)).toBe(true);
  });

  it('价格预警（不含链接行）→ false', () => {
    expect(isFullReportMessage('🚨 价格预警\n\n🔺 比特币 (BTC) 突破上限\n当前价：$50000')).toBe(false);
  });

  it('空字符串 → false', () => {
    expect(isFullReportMessage('')).toBe(false);
  });
});

describe('messageToFeishuCard', () => {
  it('完整报告：生成 header + 每币种 markdown+actions + trailer', () => {
    const card = messageToFeishuCard(SAMPLE_REPORT);
    expect(card).not.toBeNull();
    if (!card) return;

    expect(card.msg_type).toBe('interactive');
    expect(card.card.header.title.content).toBe('📊 加密货币价格报告 (含技术指标) from local');
    expect(card.card.header.template).toBe('blue');

    // 1 个币种 = 1 markdown + 1 actions + 1 trailer markdown + 1 立即查询按钮 = 4 element
    expect(card.card.elements).toHaveLength(4);

    // 第 1 个：币种 markdown 块
    const md = card.card.elements[0];
    expect(md.tag).toBe('markdown');
    if (md.tag === 'markdown') {
      // *X* 转为 **X**（飞书加粗）
      expect(md.content).toContain('**比特币**');
      expect(md.content).not.toMatch(/(?<!\*)\*比特币\*(?!\*)/);
      // 链接行不进入 markdown 块（会单独渲染为按钮）
      expect(md.content).not.toContain('[Gate](');
      expect(md.content).toContain('`¥360,000.00(7.20)`');
      expect(md.content).toContain('MA7:');
    }

    // 第 2 个：action 按钮容器（3 个按钮）。飞书 schema：容器 tag 必须是 "action"（单数），
    // 数组字段名才是 "actions"。复数 tag 会触发 "unsupported type of block; ErrorValue: actions"。
    const actions = card.card.elements[1];
    expect(actions.tag).toBe('action');
    if (actions.tag === 'action') {
      expect(actions.actions).toHaveLength(3);
      expect(actions.actions[0]).toMatchObject({
        tag: 'button',
        text: { tag: 'plain_text', content: 'Gate' },
        type: 'primary',
        url: 'https://www.gate.com/zh/price/bitcoin-btc',
      });
      expect(actions.actions[1]).toMatchObject({
        tag: 'button',
        text: { tag: 'plain_text', content: 'Binance' },
        type: 'default',
        url: 'https://www.binance.com/zh-CN/price/bitcoin/',
      });
      expect(actions.actions[2]).toMatchObject({
        tag: 'button',
        text: { tag: 'plain_text', content: 'CoinGecko' },
        type: 'default',
        url: 'https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/bitcoin',
      });
    }

    // 第 3 个：trailer markdown
    const trailer = card.card.elements[2];
    expect(trailer.tag).toBe('markdown');
    if (trailer.tag === 'markdown') {
      expect(trailer.content).toContain('⏰ 更新时间:');
      expect(trailer.content).toContain('⚠️ MA（移动平均线）仅供参考');
      expect(trailer.content).toContain('数据展示以 CoinGecko 数据为准');
    }
  });

  it('binance_slug 为空时只渲染 Gate + CoinGecko 两个按钮', () => {
    const card = messageToFeishuCard(SAMPLE_GT_REPORT);
    expect(card).not.toBeNull();
    if (!card) return;

    const actions = card.card.elements[1];
    expect(actions.tag).toBe('action');
    if (actions.tag === 'action') {
      expect(actions.actions).toHaveLength(2);
      expect(actions.actions.map(a => a.text.content)).toEqual(['Gate', 'CoinGecko']);
      // 没有 Binance 按钮
      expect(actions.actions.find(a => a.text.content === 'Binance')).toBeUndefined();
    }
  });

  it('汇率兜底时 header 切换为橙色模板', () => {
    const fallback = SAMPLE_REPORT.replace('from local', 'from local ⚠️汇率兜底');
    const card = messageToFeishuCard(fallback);
    expect(card?.card.header.template).toBe('orange');
    expect(card?.card.header.title.content).toContain('⚠️汇率兜底');
  });

  it('多个币种：每个币种独立生成 markdown+actions，币种间用 hr 分隔', () => {
    const twoCoins = SAMPLE_REPORT + '\n\n' + SAMPLE_GT_REPORT.split('\n\n').slice(2).join('\n\n');
    // 构造一个含 2 个币种的消息
    const two = `📊 *加密货币价格报告 (含技术指标) from local*

🔹 *比特币* (BTC)
   💰 人民币：\`¥360,000.00(7.20)\`
   🔗 [Gate](https://www.gate.com/zh/price/bitcoin-btc) | [Binance](https://www.binance.com/zh-CN/price/bitcoin/) | [CoinGecko](https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/bitcoin)

🔹 *Gate* (GT)
   💰 人民币：\`¥63.00(7.00)\`
   🔗 [Gate](https://www.gate.com/zh/price/gate-gt) | [CoinGecko](https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/gatechain-token)

⏰ 更新时间: 2026/9/17 00:00:00
⚠️ MA（移动平均线）仅供参考`;
    const card = messageToFeishuCard(two);
    expect(card).not.toBeNull();
    if (!card) return;

    // 2 个币种：(md + actions + hr) * 2 - 1 (末尾不加分隔) + 1 trailer + 1 立即查询按钮 = 7
    expect(card.card.elements).toHaveLength(7);
    expect(card.card.elements[0].tag).toBe('markdown');
    expect(card.card.elements[1].tag).toBe('action');
    expect(card.card.elements[2].tag).toBe('hr');
    expect(card.card.elements[3].tag).toBe('markdown');
    expect(card.card.elements[4].tag).toBe('action');
    expect(card.card.elements[5].tag).toBe('markdown');
    expect(card.card.elements[6].tag).toBe('action');

    // 第一个币种 3 个按钮，第二个币种 2 个按钮
    expect((card.card.elements[1] as { actions: unknown[] }).actions).toHaveLength(3);
    expect((card.card.elements[4] as { actions: unknown[] }).actions).toHaveLength(2);
  });

  it('非完整报告（价格预警等）返回 null', () => {
    expect(messageToFeishuCard('🚨 价格预警\n\n🔺 比特币 (BTC) 突破上限')).toBeNull();
  });

  it('消息中没有可识别的币种段时返回 null（防御：格式被破坏）', () => {
    const broken = '📊 *测试*\n\n随便一段文本\n\n⏰ 更新时间';
    // 不含 🔗 [Gate]( → isFullReportMessage 已是 false
    expect(messageToFeishuCard(broken)).toBeNull();
  });

  it('完整报告但缺 CoinGecko 链接 → 返回 null（防御 buildMessage 格式破坏）', () => {
    // 手工构造一个含 🔗 但没 coingecko 的恶意/异常输入
    const weird = '📊 *测试*\n\n🔹 *X* (X)\n   🔗 [Gate](https://gate.com/x-x)\n\n⏰ 时间';
    expect(messageToFeishuCard(weird)).toBeNull();
  });

  it('输出的 msg_type 必须是 interactive（飞书 webhook 用）', () => {
    const card: FeishuCardPayload | null = messageToFeishuCard(SAMPLE_REPORT);
    expect(card?.msg_type).toBe('interactive');
  });

  it('卡片末尾有「立即查询」按钮', () => {
    const card = messageToFeishuCard(SAMPLE_REPORT);
    expect(card).not.toBeNull();
    if (!card) return;

    // 找到最后一个 action 元素
    const lastActionIdx = card.card.elements.findIndex(
      e => e.tag === 'action' && e.actions.some(a => a.text.content === '🔄 立即查询')
    );
    expect(lastActionIdx).toBeGreaterThanOrEqual(0);

    const lastAction = card.card.elements[lastActionIdx];
    if (lastAction.tag !== 'action') return;
    expect(lastAction.actions).toHaveLength(1);
    expect(lastAction.actions[0]).toMatchObject({
      tag: 'button',
      text: { tag: 'plain_text', content: '🔄 立即查询' },
      type: 'primary',
      value: { action: 'query_now', v: 1 },
    });

    // 「立即查询」按钮必须在 trailer 之后
    const trailerIdx = card.card.elements.findIndex(
      e => e.tag === 'markdown' && e.content.includes('⏰ 更新时间')
    );
    expect(lastActionIdx).toBeGreaterThan(trailerIdx);
  });
});
