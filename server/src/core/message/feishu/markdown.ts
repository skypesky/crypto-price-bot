import type { FeishuCardElement } from './types.js';

/** 行内 Markdown 转换：`*X*` → `**X**`，反引号 → 加粗。 */
export function toLarkMd(text: string): string {
  return text
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '**$1**')
    .replace(/`([^`\n]+)`/g, '**$1**');
}

/** 把 `标签：内容` 行里的标签加粗，如 `4h：偏空 · 箱体：…`。 */
export function boldLabels(text: string): string {
  return text.replace(/(^| · )([^·：\s][^·：]*?)：/g, '$1**$2**：');
}

/** 拆出 `标签：内容`；没有冒号返回 null。 */
export function splitLabel(line: string): { label: string; value: string } | null {
  const idx = line.indexOf('：');
  if (idx < 0) return null;
  return { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
}

/**
 * 把折行后的续行合并回逻辑行。
 * buildMessage 只在 ` · ` 处折行且不拆数据项，因此续行可以直接用 ` · ` 拼回。
 */
export function mergeLogicalLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (/^\s{5,}\S/.test(raw) && out.length > 0) {
      out[out.length - 1] += ` · ${raw.trim()}`;
    } else {
      out.push(raw.trim());
    }
  }
  return out;
}

/** 构造一个 markdown 元素。 */
export function markdown(
  content: string,
  opts: { text_size?: string; text_align?: 'left' | 'center' | 'right'; margin?: string } = {},
): FeishuCardElement {
  return { tag: 'markdown', content, ...opts };
}

/** 灰底面板：用于紧凑展示一组指标 / 提示。 */
export function panel(content: string, opts: { large?: boolean } = {}): FeishuCardElement {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        padding: '8px 10px',
        background_style: 'grey',
        elements: [markdown(content, { text_size: opts.large ? 'large' : 'normal' })],
      },
    ],
  };
}

/** 分区标题。 */
export function sectionTitle(title: string): FeishuCardElement {
  return markdown(`**${title}**`, { text_size: 'heading-4' });
}

/** 解读列表：`解读` 小标题 + 每条一个 `- `。 */
export function insightBlock(insights: string[]): string {
  return `**解读**\n${insights.map((s) => `- ${toLarkMd(s)}`).join('\n')}`;
}
