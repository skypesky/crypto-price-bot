/**
 * 把 Markdown 文本转换为飞书纯文本：
 * - CRLF → LF
 * - [text](url) → text: url
 * - 去除 * _ ` 等 markdown 字符
 */
export function normalizeMessageForTextChannel(message: unknown): string {
  return String(message)
    .replace(/\r\n/g, '\n')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2')
    .replace(/[*_`]/g, '');
}

// --- 飞书 interactive 卡片（JSON 2.0） -------------------------------------
//
// 目标：只做信息展示，不做交互。
// - 卡片 JSON 2.0：`schema: "2.0"` + `body.elements`
// - 每个币种 → 一个灰底面板（头部双列 + 趋势双列 + 文本区块）
// - 趋势 → column_set 双列（涨跌 / 均线）
// - 日内 / 周期研判 / 合约 / 结论 → 紧凑 Markdown 区块
// - 尾部说明 → notation 小字
// - 链接 → Markdown 行内链接
//
// 单张卡片上限：请求体 30KB、元素 200 个；超限飞书会拒绝或降级，所以按币种自动分片。

/** 卡片 JSON 2.0 允许的主题色。 */
type CardTemplate = 'blue' | 'green' | 'red' | 'orange' | 'purple' | 'grey';

/** 分栏列容器。 */
export interface FeishuColumn {
  tag: 'column';
  width: 'weighted' | 'auto';
  weight?: number;
  padding?: string;
  background_style?: string;
  vertical_align?: 'top' | 'center' | 'bottom';
  elements: FeishuCardElement[];
}

/** 飞书 2.0 卡片元素（只覆盖展示类组件）。 */
export type FeishuCardElement =
  | {
      tag: 'markdown';
      content: string;
      text_size?: string;
      text_align?: 'left' | 'center' | 'right';
      margin?: string;
    }
  | { tag: 'hr'; margin?: string }
  | {
      tag: 'column_set';
      flex_mode?: 'none' | 'bisect' | 'stretch' | 'flow' | 'trisect';
      horizontal_spacing?: string;
      background_style?: string;
      columns: FeishuColumn[];
    }
  | FeishuColumn;

export interface FeishuCardPayload {
  msg_type: 'interactive';
  card: {
    schema: '2.0';
    config: { width_mode: 'fill' };
    header: {
      title: { tag: 'plain_text'; content: string };
      subtitle?: { tag: 'plain_text'; content: string };
      template: CardTemplate;
    };
    body: {
      direction: 'vertical';
      padding: string;
      vertical_spacing: string;
      elements: FeishuCardElement[];
    };
  };
}

/**
 * 检测消息是否是 buildMessage 产出的完整报告（含 `🔗 [Gate](` 链接行）。
 * 价格预警等短消息不含此特征，会被识别为简单消息。
 */
export function isFullReportMessage(message: string): boolean {
  return /🔗\s*\[Gate\]\(/.test(message);
}

/** 分区标题行：`   ──── 📈 趋势 ────`。 */
const DIVIDER_RE = /^\s*────\s*(.+?)\s*────\s*$/;

/** 单张卡片的 JSON 体积预算（飞书 interactive 卡片上限 30KB）。 */
const CARD_SIZE_BUDGET = 29500;

/** 单张卡片的元素数量预算（飞书 2.0 上限 200 个元素/组件）。 */
const CARD_ELEMENT_BUDGET = 198;

/** 递归统计卡片元素数量（column_set 里的列和列内组件都计入）。 */
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

type CoinLinks = { gate: string; binance: string | null; coinglass: string; coingecko: string };

type CoinBlock = {
  elements: FeishuCardElement[];
  links: CoinLinks;
};

/** 行内 Markdown 转换：`*X*` → `**X**`，反引号 → 加粗。 */
function toLarkMd(text: string): string {
  return text
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '**$1**')
    .replace(/`([^`\n]+)`/g, '**$1**');
}

/** 把 `标签：内容` 行里的标签加粗，如 `4h：偏空 · 箱体：…`。 */
function boldLabels(text: string): string {
  return text.replace(/(^| · )([^·：\s][^·：]*?)：/g, '$1**$2**：');
}

/** 拆出 `标签：内容`；没有冒号返回 null。 */
function splitLabel(line: string): { label: string; value: string } | null {
  const idx = line.indexOf('：');
  if (idx < 0) return null;
  return { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
}

/**
 * 把折行后的续行合并回逻辑行。
 * buildMessage 只在 ` · ` 处折行且不拆数据项，因此续行可以直接用 ` · ` 拼回。
 */
function mergeLogicalLines(lines: string[]): string[] {
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

function markdown(
  content: string,
  opts: { text_size?: string; text_align?: 'left' | 'center' | 'right'; margin?: string } = {},
): FeishuCardElement {
  return { tag: 'markdown', content, ...opts };
}

/** 灰底面板：用于紧凑展示一组指标 / 提示。 */
function panel(content: string, opts: { large?: boolean } = {}): FeishuCardElement {
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
function sectionTitle(title: string): FeishuCardElement {
  return markdown(`**${title}**`, { text_size: 'heading-4' });
}

/** 币种头部：左列币种名，右列价格。 */
function renderHeader(line: string): FeishuCardElement {
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

/** 趋势：涨跌 / 均线并排两列，每项「周期 + 数值」一行。 */
function renderTrend(lines: string[]): FeishuCardElement[] {
  const groups: Array<{ label: string; items: Array<{ label: string; value: string }> }> = [];

  for (const line of mergeLogicalLines(lines)) {
    const kv = splitLabel(line);
    if (!kv) {
      groups.push({ label: '', items: [{ label: '', value: toLarkMd(boldLabels(line)) }] });
      continue;
    }
    const raw = kv.value.split(' · ').map((s) => s.trim()).filter(Boolean);
    if (kv.label === '涨跌') {
      groups.push({
        label: '涨跌',
        items: raw.map((item) => {
          // `-11.45%(7d)` → 7d / -11.45%
          const m = item.match(/^(.*)\(([^()]+)\)$/);
          return m ? { label: m[2]!, value: `**${m[1]}**` } : { label: '', value: item };
        }),
      });
    } else if (kv.label === '均线') {
      groups.push({
        label: '均线',
        items: raw.map((item) => {
          // `7 < 186(¥1,238.76)` → 7 / < 186(¥1,238.76)
          const m = item.match(/^(\S+)\s+(.*)$/);
          return m ? { label: m[1]!, value: m[2]! } : { label: '', value: item };
        }),
      });
    } else {
      groups.push({ label: '', items: [{ label: '', value: toLarkMd(boldLabels(line)) }] });
    }
  }

  const renderGroup = (g: { label: string; items: Array<{ label: string; value: string }> }) => {
    const body = g.items
      .map((i) => (i.label ? `**${i.label}** ${i.value}` : i.value))
      .join('\n');
    return g.label ? `**${g.label}**\n\n${body}` : body;
  };

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
          elements: [markdown(renderGroup(g))],
        })),
      },
    ];
  }
  return groups.map((g) => markdown(renderGroup(g)));
}

/** 日内：方向行 + 指标（BOLL 独立成行，MACD/RSI/ATR 按 4h/1h 合并）+ 建议。 */
function renderIntraday(title: string, lines: string[]): string {
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

  const contentLines: string[] = [`**${title}**`, ...headlines];
  if (h4.has('BOLL')) contentLines.push(`**BOLL4h** ${h4.get('BOLL')}`);
  if (h1.has('BOLL')) contentLines.push(`**BOLL1h** ${h1.get('BOLL')}`);
  for (const key of ['MACD', 'RSI', 'ATR']) {
    const parts = [
      h4.has(key) ? `4h ${h4.get(key)}` : '',
      h1.has(key) ? `1h ${h1.get(key)}` : '',
    ].filter(Boolean);
    if (parts.length) contentLines.push(`**${key}** ${parts.join(' · ')}`);
  }
  const parts: string[] = [`**${title}**`, ...contentLines.slice(1)];
  if (advice) parts.push(toLarkMd(advice));
  return parts.join('\n\n');
}

/** 周期研判：每个周期一行 + 解读列表。 */
function renderPeriods(title: string, lines: string[]): string {
  const insights: string[] = [];
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
  }

  const periodLines: string[] = [];
  for (const raw of lines) {
    const text = raw.trim();
    if (!text || text.startsWith('解读：') || /^\s{9,}\S/.test(raw)) continue;
    const kv = splitLabel(text);
    periodLines.push(kv ? `**${kv.label}** ${kv.value}` : toLarkMd(text));
  }

  const parts: string[] = [`**${title}**`, ...periodLines];
  if (insights.length) {
    parts.push(`**解读**\n${insights.map((s) => `- ${toLarkMd(s)}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** 合约：灰底指标面板 + 解读列表。 */
function renderContract(title: string, lines: string[]): string {
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

  const parts: string[] = [`**${title}**`, ...dataLines];
  if (insights.length) {
    parts.push(`**解读**\n${insights.map((s) => `- ${toLarkMd(s)}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** 结论：灰底强调块。 */
function renderConclusion(title: string, lines: string[]): string {
  const text = lines.map((l) => l.trim()).filter(Boolean).join(' ');
  if (!text) return '';
  const [summary, action] = text.split(' → ');
  const content = action
    ? `${toLarkMd(summary!)} → **${toLarkMd(action)}**`
    : toLarkMd(text);
  return `**${title}**\n\n${content}`;
}

/** 未知结构（旧格式）兜底：整段转成飞书 markdown。 */
function renderFallback(lines: string[]): FeishuCardElement[] {
  const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!content) return [];
  return [markdown(toLarkMd(content))];
}


/** 币种链接行（展示用，不做回调交互）。 */
function renderLinks(links: CoinLinks): FeishuCardElement {
  const items = [`[Gate](${links.gate})`];
  if (links.binance) items.push(`[Binance](${links.binance})`);
  items.push(`[CoinGlass](${links.coinglass})`, `[CoinGecko](${links.coingecko})`);
  return markdown(`🔗 ${items.join(' · ')}`, { text_size: 'notation' });
}

/** 组装一张 2.0 卡片；分片时在标题后标注 `（1/2）`。 */
function buildCard(
  title: string,
  subtitle: string | undefined,
  template: CardTemplate,
  elements: FeishuCardElement[],
  index: number,
  total: number,
): FeishuCardPayload {
  const page = total > 1 ? `（${index + 1}/${total}）` : '';
  return {
    msg_type: 'interactive',
    card: {
      schema: '2.0',
      config: { width_mode: 'fill' },
      header: {
        title: { tag: 'plain_text', content: `📊 ${title}${page}` },
        ...(subtitle ? { subtitle: { tag: 'plain_text', content: subtitle } } : {}),
        template,
      },
      body: {
        direction: 'vertical',
        padding: '10px',
        vertical_spacing: '6px',
        elements,
      },
    },
  };
}

/**
 * 把 buildMessage 输出的 Markdown 字符串解析成 1..N 张飞书 2.0 卡片。
 * 不是完整报告或解析失败时返回空数组，调用方应降级到 text 通道。
 */
export function messageToFeishuCards(message: string): FeishuCardPayload[] {
  if (!isFullReportMessage(message)) return [];

  const lines = message.split('\n');
  const titleLines: string[] = [];
  const coinBlocks: CoinBlock[] = [];
  const trailerLines: string[] = [];
  let current: string[] | null = null;
  let inTrailer = false;

  for (const line of lines) {
    if (line.startsWith('🔹')) {
      if (current) {
        const parsed = parseCoinSection(current.join('\n'));
        if (parsed) coinBlocks.push(parsed);
      }
      current = [line];
      inTrailer = false;
      continue;
    }
    if (inTrailer) {
      trailerLines.push(line);
      continue;
    }
    if (current) {
      current.push(line);
      // 链接行是币种块的收尾，之后的都是报告尾部
      if (line.trim().startsWith('🔗')) inTrailer = true;
    } else if (coinBlocks.length === 0) {
      titleLines.push(line);
    } else {
      trailerLines.push(line);
    }
  }
  if (current) {
    const parsed = parseCoinSection(current.join('\n'));
    if (parsed) coinBlocks.push(parsed);
  }

  // 标题去掉 `📊 ` 前缀和 `*...*` 包装（飞书 plain_text 不渲染 markdown）
  const titlePlain = titleLines.join('\n')
    .replace(/^\s*📊\s*\*?/, '')
    .replace(/\*?\s*$/, '')
    .trim() || '加密货币价格报告';

  if (coinBlocks.length === 0) return [];

  // 汇率兜底时用橙色 header 提示用户
  const hasFxFallback = /⚠️汇率兜底/.test(message);
  const template: CardTemplate = hasFxFallback ? 'orange' : 'blue';

  // 更新时间放副标题，尾部其余说明放 notation 小字
  const timeLine = trailerLines.find((l) => l.trim().startsWith('⏰'));
  const footerLines = trailerLines
    .filter((l) => l !== timeLine && l.trim())
    .map((l) => l.trim());

  // 按体积 + 元素数量分片：两项都在飞书限制内
  const chunks: CoinBlock[][] = [];
  let chunk: CoinBlock[] = [];
  let chunkBytes = 0;
  let chunkElements = 0;
  for (const c of coinBlocks) {
    const size = Buffer.byteLength(JSON.stringify(c.elements), 'utf8') + 16; // hr 余量
    const elems = countElements(c.elements) + 1; // hr 余量
    if (
      chunk.length > 0 &&
      (chunkBytes + size > CARD_SIZE_BUDGET || chunkElements + elems > CARD_ELEMENT_BUDGET)
    ) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
      chunkElements = 0;
    }
    chunk.push(c);
    chunkBytes += size;
    chunkElements += elems;
  }
  if (chunk.length) chunks.push(chunk);

  return chunks.map((blocks, i) => {
    const elements: FeishuCardElement[] = [];
    for (const [j, c] of blocks.entries()) {
      elements.push(...c.elements);
      // 币种之间用 hr 分隔
      if (j < blocks.length - 1) elements.push({ tag: 'hr', margin: '8px 0' });
    }

    if (i === chunks.length - 1 && footerLines.length) {
      elements.push(
        markdown(footerLines.map((l) => `<font color='grey'>${toLarkMd(l)}</font>`).join('\n'), {
          text_size: 'notation',
        }),
      );
    }

    return buildCard(titlePlain, timeLine?.trim(), template, elements, i, chunks.length);
  });
}

/**
 * 兼容单卡调用：返回第一张卡片。
 * 完整报告请用 messageToFeishuCards，避免多卡报告被截断。
 */
export function messageToFeishuCard(message: string): FeishuCardPayload | null {
  return messageToFeishuCards(message)[0] ?? null;
}

/**
 * 解析单个币种段：剥离链接行（链接转展示用链接），按分区标题拆成卡片元素。
 * 解析不出 Gate/CoinGlass/CoinGecko 链接时返回 null（防御：buildMessage 格式被破坏）。
 */
function parseCoinSection(section: string): CoinBlock | null {
  const lines = section.split('\n');
  const links: { gate?: string; binance?: string | null; coinglass?: string; coingecko?: string } = {};
  let header: string | null = null;
  const sections: { title: string; lines: string[] }[] = [];
  const looseLines: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith('🔗')) {
      const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(line)) !== null) {
        const [, label, url] = m;
        if (label === 'Gate') links.gate = url;
        else if (label === 'Binance') links.binance = url;
        else if (label === 'CoinGlass') links.coinglass = url;
        else if (label === 'CoinGecko') links.coingecko = url;
      }
      continue;
    }

    const divider = line.match(DIVIDER_RE);
    if (divider) {
      sections.push({ title: divider[1]!, lines: [] });
      continue;
    }

    if (sections.length > 0) {
      sections[sections.length - 1]!.lines.push(line);
    } else if (!header) {
      if (line.trim()) header = line.trim();
    } else {
      looseLines.push(line);
    }
  }

  if (!links.gate || !links.coinglass || !links.coingecko) return null;

  const coinElements: FeishuCardElement[] = [];
  if (header) coinElements.push(renderHeader(header));
  // 标题与第一个分区之间的内容（旧格式的价格行等）
  if (looseLines.length) coinElements.push(...renderFallback(looseLines));
  // 日内/周期研判/合约/结论合并进同一个灰底面板，减少元素数量、控制卡片高度
  const bodyParts: string[] = [];
  for (const s of sections) {
    const name = s.title.replace(/\s/g, '');
    if (name.includes('趋势')) {
      coinElements.push(sectionTitle(s.title));
      coinElements.push(...renderTrend(s.lines));
    } else if (name.includes('日内')) {
      bodyParts.push(renderIntraday(s.title, s.lines));
    } else if (name.includes('周期研判')) {
      bodyParts.push(renderPeriods(s.title, s.lines));
    } else if (name.includes('合约')) {
      bodyParts.push(renderContract(s.title, s.lines));
    } else if (name.includes('结论')) {
      bodyParts.push(renderConclusion(s.title, s.lines));
    } else {
      coinElements.push(sectionTitle(s.title));
      coinElements.push(...renderFallback(s.lines));
    }
  }
  if (bodyParts.length) coinElements.push(panel(bodyParts.join('\n\n')));

  coinElements.push(renderLinks({
    gate: links.gate,
    binance: links.binance ?? null,
    coinglass: links.coinglass,
    coingecko: links.coingecko,
  }));

  return {
    elements: coinElements,
    links: {
      gate: links.gate,
      binance: links.binance ?? null,
      coinglass: links.coinglass,
      coingecko: links.coingecko,
    },
  };
}
