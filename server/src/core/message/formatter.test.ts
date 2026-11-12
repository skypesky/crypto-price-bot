import { describe, it, expect } from 'vitest';
import {
  isFullReportMessage,
  messageToFeishuCard,
  messageToFeishuCards,
  normalizeMessageForTextChannel,
  type FeishuCardElement,
  type FeishuCardPayload,
} from './formatter.js';

/** 取卡片元素里所有可见文本，便于按语义断言（不依赖元素顺序）。 */
function elementText(e: FeishuCardElement): string {
  switch (e.tag) {
    case 'markdown':
      return e.content;
    case 'column_set':
      return e.columns.map(elementText).join('\n');
    case 'column':
      return e.elements.map(elementText).join('\n');
    default:
      return '';
  }
}

/** 整张卡片的可见文本。 */
function cardText(card: FeishuCardPayload): string {
  return card.card.body.elements.map(elementText).join('\n');
}

/** 递归统计卡片元素数量（飞书 2.0 上限 200）。 */
function countElements(elements: FeishuCardElement[]): number {
  let count = 0;
  for (const e of elements) {
    count += 1;
    if (e.tag === 'column_set') {
      for (const c of e.columns) count += 1 + countElements(c.elements);
    } else if (e.tag === 'column') {
      count += countElements(e.elements);
    }
  }
  return count;
}

/** 递归找卡片里所有指定 tag 的元素。 */
function findAll(card: FeishuCardPayload, tag: FeishuCardElement['tag']): FeishuCardElement[] {
  const out: FeishuCardElement[] = [];
  const walk = (e: FeishuCardElement) => {
    if (e.tag === tag) out.push(e);
    if (e.tag === 'column_set') e.columns.forEach(walk);
    else if (e.tag === 'column') e.elements.forEach(walk);
  };
  card.card.body.elements.forEach(walk);
  return out;
}

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
   💵 \`$50,000.00(¥360,000.00)[汇率: 7.20]\`
   ──────── 📈 趋势分析 ────────
   📅 7天:   🔺 +5.5%    📅 30天:  🔺 +10.2%
   📅 90天:  🔺 +20.0%   📅 180天: 🔺 +30.0%
   📅 1年:   🔺 +50.0%
   ──────── 📊 均线 (MA) ────────
   MA7:   ➡️ $49,000.00(¥352,800.00)
   MA30:  ➡️ $48,000.00(¥345,600.00)
   MA90:  📈 $45,000.00(¥324,000.00) (偏高)
   MA180: 📈 $40,000.00(¥288,000.00) (偏高)
   MA365: 📈 $30,000.00(¥216,000.00) (偏高)
   🔗 [Gate](https://www.gate.com/zh/trade/BTC_USDT) | [Binance](https://www.binance.com/zh-CN/trade/BTC_USDT?type=spot) | [CoinGlass](https://www.coinglass.com/zh/currencies/BTC) | [CoinGecko](https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/bitcoin)

⏰ 更新时间: 2026/9/17 00:00:00
⚠️ MA（移动平均线）仅供参考，不构成投资建议
数据展示以 CoinGecko 数据为准`;

// binance_pair=null 的币种报告（只有 Gate + CoinGlass + CoinGecko 三个链接）
const SAMPLE_GT_REPORT = `📊 *加密货币价格报告 (含技术指标) from local*

🔹 *Gate* (GT)
   💵 \`$9.00(¥63.00)[汇率: 7.00]\`
   📈 趋势数据暂时不可用
   🔗 [Gate](https://www.gate.com/zh/trade/GT_USDT) | [CoinGlass](https://www.coinglass.com/zh/currencies/GT) | [CoinGecko](https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/gatechain-token)

⏰ 更新时间: 2026/9/17 00:00:00
⚠️ MA（移动平均线）仅供参考，不构成投资建议
数据展示以 CoinGecko 数据为准`;

// 排版改造后的新格式报告（分区标题 + 冒号式标签 + 紧凑人民币），
// 与 buildMessage 当前输出一致：币种块之间用空行、块内用 🔹 开头。
const NEW_STYLE_REPORT = `📊 *加密货币价格报告 (含技术指标) from local*

🔹 *比特币* BTC · \`$50,000.00(¥36.0万 @7.20)\`
   ──── 📈 趋势 ────
   涨跌：+5.50%(7d) · +10.20%(30d) · N/A(90d)
         N/A(180d) · N/A(1y)
   均线：7 > 49,000(¥35.3万) · 30 > 48,000(¥34.6万)
         90 > 45,000(¥32.4万) · 180 > 40,000(¥28.8万)
         365 > 30,000(¥21.6万)
   ──── ⚡ 日内 ────
   4h：震荡 · 箱体：$48,000.00~$52,000.00(8.0% 中部50%)
   BOLL4h：上$50,500.00/中$49,500.00/下$48,500.00(带宽4.2% 正常)
   💡 箱体中部观望，等边缘或放量突破
   ──── 📌 结论 ────
   各周期一致走弱 → 观望
   🔗 [Gate](https://www.gate.com/zh/trade/BTC_USDT) | [Binance](https://www.binance.com/zh-CN/trade/BTC_USDT?type=spot) | [CoinGlass](https://www.coinglass.com/zh/currencies/BTC) | [CoinGecko](https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/bitcoin)

⏰ 更新时间: 2026/9/17 00:00:00
⚠️ MA（移动平均线）仅供参考，不构成投资建议
数据展示以 CoinGecko 数据为准`;

// 同上但只有两个币种（第二个币种没有 Binance 链接）
const NEW_STYLE_TWO_COINS = `📊 *加密货币价格报告 (含技术指标) from local*

🔹 *比特币* BTC · \`$50,000.00(¥36.0万 @7.20)\`
   ──── 📈 趋势 ────
   涨跌：+5.50%(7d) · +10.20%(30d)
   均线：7 > 49,000(¥35.3万)
   🔗 [Gate](https://www.gate.com/zh/trade/BTC_USDT) | [Binance](https://www.binance.com/zh-CN/trade/BTC_USDT?type=spot) | [CoinGlass](https://www.coinglass.com/zh/currencies/BTC) | [CoinGecko](https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/bitcoin)

🔹 *Gate* GT · \`$9.00(¥64.80 @7.20)\`
   ──── 📈 趋势 ────
   涨跌：趋势数据暂时不可用
   🔗 [Gate](https://www.gate.com/zh/trade/GT_USDT) | [CoinGlass](https://www.coinglass.com/zh/currencies/GT) | [CoinGecko](https://www.coingecko.com/zh/%E6%95%B0%E5%AD%97%E8%B4%A7%E5%B8%81/gatechain-token)

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

describe('messageToFeishuCard（JSON 2.0）', () => {
  it('顶层使用 schema 2.0 + header 标题/副标题 + body.elements', () => {
    const card = messageToFeishuCard(NEW_STYLE_REPORT);
    expect(card).not.toBeNull();
    if (!card) return;

    expect(card.msg_type).toBe('interactive');
    expect(card.card.schema).toBe('2.0');
    expect(card.card.config.width_mode).toBe('fill');
    expect(card.card.header.title.content).toBe('📊 加密货币价格报告 (含技术指标) from local');
    expect(card.card.header.subtitle?.content).toContain('⏰ 更新时间:');
    expect(card.card.body.direction).toBe('vertical');
    expect(card.card.body.elements.length).toBeGreaterThan(0);
  });

  it('币种头部是 column_set 双列（币种 / 价格）', () => {
    const card = messageToFeishuCard(NEW_STYLE_REPORT)!;
    // 整个币种包在灰底面板里，头部是面板内的双列 column_set
    const header = findAll(card, 'column_set').find(
      (e) => e.tag === 'column_set' && e.columns.length === 2 && elementText(e).includes('**比特币**')
    );
    expect(header?.tag).toBe('column_set');
    if (header?.tag !== 'column_set') return;
    expect(elementText(header.columns[0]!)).toContain('**比特币**');
    expect(elementText(header.columns[1]!)).toContain('**$50,000.00(¥36.0万 @7.20)**');
  });

  it('趋势 / 均线使用并排双列面板', () => {
    const card = messageToFeishuCard(NEW_STYLE_REPORT)!;
    const text = cardText(card);
    expect(text).toContain('**涨跌**');
    expect(text).toContain('**7d** **+5.50%**');
    expect(text).toContain('**1y** **N/A**');
    expect(text).toContain('**均线**');
    expect(text).toContain('**7** > 49,000(¥35.3万)');
    // 涨跌 / 均线并排成一个双列 column_set
    const trendPanel = findAll(card, 'column_set').find(
      (e) => e.tag === 'column_set' && e.columns.length === 2 && elementText(e).includes('**涨跌**')
    );
    expect(trendPanel).toBeTruthy();
  });

  it('日内指标按 4h / 1h 合并，方向行与建议保留', () => {
    const card = messageToFeishuCard(NEW_STYLE_REPORT)!;
    const text = cardText(card);
    expect(text).toContain('**BOLL4h** 上$50,500.00/中$49,500.00/下$48,500.00(带宽4.2% 正常)');
    expect(text).toContain('**4h**：震荡 · **箱体**：$48,000.00~$52,000.00');
    expect(text).toContain('💡 箱体中部观望，等边缘或放量突破');
  });

  it('周期研判 / 合约使用紧凑面板 + 解读列表', () => {
    const report = `📊 *加密货币价格报告 (含技术指标) from local*

🔹 *比特币* BTC · \`$50,000.00(¥36.0万 @7.20)\`
   ──── 🧭 周期研判 ────
   日线：下跌 -7.99%
   周线：下跌 -9.50%
   月线：下跌 -6.37%
   年线：跌破3年年均线 6.37%
   解读：日线·短期空头占优
         周线·中期偏弱
   ──── 📊 合约 ────
   多空：2.25(多头占优)
   费率：0.010%/8h(年化10.9%,多头付费意愿尚可)
   解读：多空分歧
   🔗 [Gate](https://www.gate.com/zh/trade/BTC_USDT) | [CoinGlass](https://www.coinglass.com/zh/currencies/BTC) | [CoinGecko](https://www.coingecko.com/zh/x)`;
    const card = messageToFeishuCard(report)!;
    const text = cardText(card);

    expect(text).toContain('**日线** 下跌 -7.99%');
    expect(text).toContain('**年线** 跌破3年年均线 6.37%');
    expect(text).toContain('**解读**\n- 日线·短期空头占优\n- 周线·中期偏弱');

    expect(text).toContain('**多空** 2.25(多头占优)');
    expect(text).toContain('- 多空分歧');
  });

  it('结论使用灰底强调块，动作加粗', () => {
    const card = messageToFeishuCard(NEW_STYLE_REPORT)!;
    const text = cardText(card);
    expect(text).toContain('各周期一致走弱 → **观望**');
    const grey = findAll(card, 'column').find(
      (e) => e.tag === 'column' && e.background_style === 'grey'
    );
    expect(grey).toBeTruthy();
  });

  it('链接改为 Markdown 行内链接，卡片不含交互按钮', () => {
    const card = messageToFeishuCard(NEW_STYLE_REPORT)!;
    const text = cardText(card);
    expect(text).toContain('[Gate](https://www.gate.com/zh/trade/BTC_USDT)');
    expect(text).toContain('[CoinGecko](');
    expect(text).not.toContain('立即查询');
  });

  it('旧格式报告仍能解析（链接 / 价格行保留）', () => {
    const card = messageToFeishuCard(SAMPLE_REPORT);
    expect(card).not.toBeNull();
    const text = card ? cardText(card) : '';
    expect(text).toContain('**比特币**');
    expect(text).toContain('$50,000.00');
    expect(text).toContain('MA7:');
    expect(text).toContain('[Gate](');
    // 行内单反引号转成加粗，不残留反引号
    expect(text).not.toContain('`');
  });

  it('binance_pair 为空时链接行只包含 Gate + CoinGlass + CoinGecko', () => {
    const card = messageToFeishuCard(SAMPLE_GT_REPORT)!;
    const text = cardText(card);
    expect(text).toContain('[Gate](');
    expect(text).toContain('[CoinGlass](');
    expect(text).toContain('[CoinGecko](');
    expect(text).not.toContain('[Binance](');
  });

  it('汇率兜底时 header 切换为橙色模板', () => {
    const fallback = SAMPLE_REPORT.replace('from local', 'from local ⚠️汇率兜底');
    expect(messageToFeishuCard(fallback)?.card.header.template).toBe('orange');
    expect(messageToFeishuCard(fallback)?.card.header.title.content).toContain('⚠️汇率兜底');
  });

  it('多个币种：每个币种独立成块，币种之间有 hr', () => {
    const card = messageToFeishuCard(NEW_STYLE_TWO_COINS)!;
    const elements = card.card.body.elements;
    expect(elements.filter((e) => e.tag === 'hr')).toHaveLength(1);

    const hrIdx = elements.findIndex((e) => e.tag === 'hr');
    const firstText = elements.slice(0, hrIdx).map(elementText).join('\n');
    const secondText = elements.slice(hrIdx + 1).map(elementText).join('\n');
    expect(firstText).toContain('**比特币**');
    expect(firstText).not.toContain('**Gate**');
    expect(secondText).toContain('**Gate**');
    expect(secondText).not.toContain('**比特币**');
  });

  it('9 币报告压成单张卡片，体积与元素数都在限制内', () => {
    const coinBlock = (i: number) => [
      `🔹 *币种${i}* C${i} · \`$100.00(¥666.00 @6.66)\``,
      '   ──── 📈 趋势 ────',
      '   涨跌：-11.45%(7d) · -20.22%(30d) · +187.37%(90d)',
      '         +106.52%(180d) · +84.27%(1y)',
      '   均线：7 < 186(¥1,238.76) · 30 < 193(¥1,285.38)',
      '         90 > 144(¥959.04) · 180 > 105(¥699.30)',
      '         365 > 89.57(¥596.54)',
      '   ──── ⚡ 日内 ────',
      '   4h：偏空 · 箱体：$166.04~$195.35(16.2% 下沿4%)',
      '   BOLL4h：上$206.65/中$188.31/下$169.97(带宽19.5% 扩张)',
      '     MACD：空头动能增强 · RSI：26.4(超卖)',
      '   ──── 🧭 周期研判 ────',
      '   日线：大幅走弱 -11.45%，连阴2根，跌破MA7 9.93%，跌破MA30 13.40%，均线纠缠，日均振幅8.0%',
      '   周线：大幅走弱 -13.02%，跌破MA5 11.62%，站上MA20 34.92%，距13周高点回撤55.18%',
      '   月线：强势上涨 +173.78%，跌破MA3 23.41%，站上MA12 59.99%',
      '   年线：强势上涨 +140.66%，连阴2年，站上3年年均线 46.28%',
      '   解读：日线·短期空头占优，均线压制，反弹先看能否收复 MA7',
      '         周线·中期回调但 MA20 未破，趋势结构尚在，关注 MA20 支撑',
      '   ──── 📊 合约 ────',
      '   多空：1.04(多空均衡，7日均 1.13↓)',
      '   大户：0.34(空头占优)',
      '   费率：0.010%/8h(年化11.0%,多头付费意愿尚可)',
      '   ──── 📌 结论 ────',
      '   周期方向分化，趋势待观察 → 观望',
      `   🔗 [Gate](https://www.gate.com/zh/trade/C${i}_USDT) | [CoinGlass](https://www.coinglass.com/zh/currencies/C${i}) | [CoinGecko](https://www.coingecko.com/zh/x)`,
    ].join('\n');
    const report = `📊 *加密货币价格报告 (含技术指标) from local*

${Array.from({ length: 9 }, (_, i) => coinBlock(i + 1)).join('\n\n')}

⏰ 更新时间: 2026/11/12 10:00:00
⚠️ MA（移动平均线）仅供参考`;

    const cards = messageToFeishuCards(report);
    // 9 币报告压成单张卡片（用户要求只发一条消息）
    expect(cards).toHaveLength(1);
    for (const card of cards) {
      expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(30000);
      expect(countElements(card.card.body.elements)).toBeLessThanOrEqual(200);
    }
    // 单卡时标题不带分页后缀
    expect(cards[0]!.card.header.title.content).toBe('📊 加密货币价格报告 (含技术指标) from local');

    for (let i = 1; i <= 9; i++) {
      expect(cardText(cards[0]!)).toContain(`**币种${i}**`);
    }
    expect(cardText(cards[0]!)).toContain('仅供参考');
  });

  it('报告尾部为空时不生成 footer 小字', () => {
    const noTrailer = NEW_STYLE_REPORT.split('\n⏰ 更新时间')[0].trimEnd();
    const card = messageToFeishuCard(noTrailer)!;
    expect(card.card.header.subtitle).toBeUndefined();
    expect(cardText(card)).not.toContain('⏰ 更新时间');
    expect(cardText(card)).not.toContain('不构成投资建议');
  });

  it('非完整报告（价格预警等）返回 null', () => {
    expect(messageToFeishuCard('🚨 价格预警\n\n🔺 比特币 (BTC) 突破上限')).toBeNull();
  });

  it('完整报告但缺 CoinGecko 链接 → 返回 null（防御 buildMessage 格式破坏）', () => {
    const weird = '📊 *测试*\n\n🔹 *X* (X)\n   🔗 [Gate](https://gate.com/x-x)\n\n⏰ 时间';
    expect(messageToFeishuCard(weird)).toBeNull();
  });

  it('标题为空时降级为默认标题「加密货币价格报告」', () => {
    const noTitle = `📊 \n\n🔹 *X* X\n   🔗 [Gate](https://www.gate.com/zh/trade/X_USDT) | [CoinGlass](https://www.coinglass.com/zh/currencies/X) | [CoinGecko](https://www.coingecko.com/zh/x)\n\n⏰ 更新时间: 2026/9/17 00:00:00`;
    expect(messageToFeishuCard(noTitle)?.card.header.title.content).toBe('📊 加密货币价格报告');
  });
});
