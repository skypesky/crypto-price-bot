import type { FeishuCardElement, FeishuColumn } from './types.js';
import {
  boldLabels,
  insightBlock,
  markdown,
  mergeLogicalLines,
  splitLabel,
  toLarkMd,
} from './markdown.js';

/** 一个趋势分组：标题（涨跌 / 均线）+ 每项「标签 + 数值」。 */
interface TrendGroup {
  label: string;
  items: { label: string; value: string }[];
}

/** 币种头部：左列币种名，右列价格。 */
export function renderHeader(line: string): FeishuCardElement {
  const parts = line.split(' · ');
  if (parts.length < 2) {
    return {
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, elements: [markdown(toLarkMd(line))] },
      ],
    };
  }
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [markdown(toLarkMd(parts[0]!), { text_size: 'heading-4' })],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'center',
        elements: [markdown(toLarkMd(parts.slice(1).join(' · ')), { text_align: 'right' })],
      },
    ],
  };
}

/** 涨跌项：`-11.45%(7d)` → 标签 7d / 数值加粗。 */
function trendChangeItem(item: string): { label: string; value: string } {
  const m = item.match(/^(.*)\(([^()]+)\)$/);
  return m ? { label: m[2]!, value: `**${m[1]}**` } : { label: '', value: item };
}

/** 均线项：`7 < 186(¥1,238.76)` → 标签 7 / 数值原样。 */
function trendMaItem(item: string): { label: string; value: string } {
  const m = item.match(/^(\S+)\s+(.*)$/);
  return m ? { label: m[1]!, value: m[2]! } : { label: '', value: item };
}

/** 把一行趋势数据转成分组；未知标签按普通文本处理。 */
function toTrendGroup(line: string): TrendGroup {
  const kv = splitLabel(line);
  if (!kv) return { label: '', items: [{ label: '', value: toLarkMd(boldLabels(line)) }] };

  const raw = kv.value.split(' · ').map((s) => s.trim()).filter(Boolean);
  if (kv.label === '涨跌') return { label: '涨跌', items: raw.map(trendChangeItem) };
  if (kv.label === '均线') return { label: '均线', items: raw.map(trendMaItem) };
  return { label: '', items: [{ label: '', value: toLarkMd(boldLabels(line)) }] };
}

/** 分组内容：有标题时标题单独成段。 */
function renderTrendGroup(g: TrendGroup): string {
  const body = g.items.map((i) => (i.label ? `**${i.label}** ${i.value}` : i.value)).join('\n');
  return g.label ? `**${g.label}**\n\n${body}` : body;
}

/** 趋势：涨跌 / 均线并排两列，每项「周期 + 数值」一行。 */
export function renderTrend(lines: string[]): FeishuCardElement[] {
  const groups = mergeLogicalLines(lines).map(toTrendGroup);

  if (groups.length === 2 && groups.every((g) => g.label)) {
    return [
      {
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: '8px',
        columns: groups.map((g): FeishuColumn => ({
          tag: 'column',
          width: 'weighted',
          weight: 1,
          padding: '8px',
          background_style: 'grey',
          elements: [markdown(renderTrendGroup(g))],
        })),
      },
    ];
  }
  return groups.map((g) => markdown(renderTrendGroup(g)));
}

/** 日内指标：BOLL 独立成行，MACD/RSI/ATR 按 4h/1h 合并。 */
function intradayMetricLines(h4: Map<string, string>, h1: Map<string, string>): string[] {
  const lines: string[] = [];
  if (h4.has('BOLL')) lines.push(`**BOLL4h** ${h4.get('BOLL')}`);
  if (h1.has('BOLL')) lines.push(`**BOLL1h** ${h1.get('BOLL')}`);
  for (const key of ['MACD', 'RSI', 'ATR']) {
    const parts = [
      h4.has(key) ? `4h ${h4.get(key)}` : '',
      h1.has(key) ? `1h ${h1.get(key)}` : '',
    ].filter(Boolean);
    if (parts.length) lines.push(`**${key}** ${parts.join(' · ')}`);
  }
  return lines;
}

/** 日内：方向行 + 指标 + 建议。 */
export function renderIntraday(title: string, lines: string[]): string {
  const headlines: string[] = [];
  const h4 = new Map<string, string>();
  const h1 = new Map<string, string>();
  let advice: string | null = null;

  for (const line of mergeLogicalLines(lines)) {
    if (line.startsWith('💡')) {
      advice = line;
      continue;
    }
    if (!/(BOLL|MACD|RSI|ATR)/.test(line)) {
      headlines.push(toLarkMd(boldLabels(line)));
      continue;
    }
    // BOLL1h / BOLL4h 决定这一行指标归属哪个周期
    const bucket = line.includes('1h') ? h1 : h4;
    for (const item of line.split(' · ')) {
      const kv = splitLabel(item.trim());
      if (!kv) continue;
      bucket.set(kv.label.replace(/(4h|1h)$/, ''), kv.value);
    }
  }

  const parts = [`**${title}**`, ...headlines, ...intradayMetricLines(h4, h1)];
  if (advice) parts.push(toLarkMd(advice));
  return parts.join('\n\n');
}

/** 周期研判：每个周期一行 + 解读列表。 */
export function renderPeriods(title: string, lines: string[]): string {
  const insights: string[] = [];
  const periodLines: string[] = [];

  for (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;
    if (text.startsWith('解读：')) {
      insights.push(text.slice(3));
      continue;
    }
    // 解读的续行（9 空格缩进）也是独立一条
    if (/^\s{9,}\S/.test(raw)) {
      insights.push(text);
      continue;
    }
    const kv = splitLabel(text);
    periodLines.push(kv ? `**${kv.label}** ${kv.value}` : toLarkMd(text));
  }

  const parts = [`**${title}**`, ...periodLines];
  if (insights.length) parts.push(insightBlock(insights));
  return parts.join('\n\n');
}

/** 合约：指标面板 + 解读列表。 */
export function renderContract(title: string, lines: string[]): string {
  const dataLines: string[] = [];
  const insights: string[] = [];

  for (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;
    if (text.startsWith('解读：')) {
      insights.push(text.slice(3));
      continue;
    }
    for (const item of text.split(' · ')) {
      const kv = splitLabel(item.trim());
      dataLines.push(kv ? `**${kv.label}** ${toLarkMd(kv.value)}` : toLarkMd(item.trim()));
    }
  }

  const parts = [`**${title}**`, ...dataLines];
  if (insights.length) parts.push(insightBlock(insights));
  return parts.join('\n\n');
}

/** 结论：灰底强调块。 */
export function renderConclusion(title: string, lines: string[]): string {
  const text = lines.map((l) => l.trim()).filter(Boolean).join(' ');
  if (!text) return '';
  const [summary, action] = text.split(' → ');
  const content = action
    ? `${toLarkMd(summary!)} → **${toLarkMd(action)}**`
    : toLarkMd(text);
  return `**${title}**\n\n${content}`;
}

/** 未知结构（旧格式）兜底：整段转成飞书 markdown。 */
export function renderFallback(lines: string[]): FeishuCardElement[] {
  const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!content) return [];
  return [markdown(toLarkMd(content))];
}

/** 币种链接行（展示用，不做回调交互）。 */
export function renderLinks(links: {
  gate: string;
  binance: string | null;
  coinglass: string;
  coingecko: string;
}): FeishuCardElement {
  const items = [`[Gate](${links.gate})`];
  if (links.binance) items.push(`[Binance](${links.binance})`);
  items.push(`[CoinGlass](${links.coinglass})`, `[CoinGecko](${links.coingecko})`);
  return markdown(`🔗 ${items.join(' · ')}`, { text_size: 'notation' });
}
