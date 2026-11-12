import type { CardTemplate, FeishuCardElement, FeishuCardPayload } from './types.js';
import { markdown, panel, sectionTitle, toLarkMd } from './markdown.js';
import {
  renderConclusion,
  renderContract,
  renderFallback,
  renderHeader,
  renderIntraday,
  renderLinks,
  renderPeriods,
  renderTrend,
} from './render.js';

/** 分区标题行：`   ──── 📈 趋势 ────`。 */
const DIVIDER_RE = /^\s*────\s*(.+?)\s*────\s*$/;

/** 单张卡片的 JSON 体积预算（飞书 interactive 卡片上限 30KB）。 */
const CARD_SIZE_BUDGET = 29500;

/** 单张卡片的元素数量预算（飞书 2.0 上限 200 个元素/组件）。 */
const CARD_ELEMENT_BUDGET = 198;

type CoinLinks = {
  gate: string;
  binance: string | null;
  coinglass: string;
  coingecko: string;
};

type CoinBlock = {
  elements: FeishuCardElement[];
  links: CoinLinks;
};

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

/** 从链接行里抽取各交易所链接。 */
function extractLinks(line: string): Partial<CoinLinks> {
  const found: Partial<CoinLinks> = {};
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(line)) !== null) {
    const [, label, url] = m;
    if (label === 'Gate') found.gate = url;
    else if (label === 'Binance') found.binance = url;
    else if (label === 'CoinGlass') found.coinglass = url;
    else if (label === 'CoinGecko') found.coingecko = url;
  }
  return found;
}

/** 币种段的解析结果：头部行 + 按分区标题拆开的段落。 */
interface CoinSection {
  header: string | null;
  sections: { title: string; lines: string[] }[];
  looseLines: string[];
  links: Partial<CoinLinks>;
}

/** 把币种段按 `🔗` 链接行和 `────` 分区标题拆开。 */
function splitCoinSection(section: string): CoinSection {
  const links: Partial<CoinLinks> = {};
  const sections: { title: string; lines: string[] }[] = [];
  const looseLines: string[] = [];
  let header: string | null = null;

  for (const line of section.split('\n')) {
    if (line.trim().startsWith('🔗')) {
      Object.assign(links, extractLinks(line));
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

  return { header, sections, looseLines, links };
}

/** 按分区标题分派到对应的渲染器。 */
function renderCoinSections(sections: { title: string; lines: string[] }[]): {
  elements: FeishuCardElement[];
  bodyParts: string[];
} {
  const elements: FeishuCardElement[] = [];
  const bodyParts: string[] = [];

  for (const s of sections) {
    const name = s.title.replace(/\s/g, '');
    if (name.includes('趋势')) {
      elements.push(sectionTitle(s.title));
      elements.push(...renderTrend(s.lines));
    } else if (name.includes('日内')) {
      bodyParts.push(renderIntraday(s.title, s.lines));
    } else if (name.includes('周期研判')) {
      bodyParts.push(renderPeriods(s.title, s.lines));
    } else if (name.includes('合约')) {
      bodyParts.push(renderContract(s.title, s.lines));
    } else if (name.includes('结论')) {
      bodyParts.push(renderConclusion(s.title, s.lines));
    } else {
      elements.push(sectionTitle(s.title));
      elements.push(...renderFallback(s.lines));
    }
  }

  return { elements, bodyParts };
}

/**
 * 解析单个币种段：剥离链接行，按分区标题拆成卡片元素。
 * 解析不出 Gate/CoinGlass/CoinGecko 链接时返回 null（防御：buildMessage 格式被破坏）。
 */
function parseCoinSection(section: string): CoinBlock | null {
  const { header, sections, looseLines, links } = splitCoinSection(section);
  if (!links.gate || !links.coinglass || !links.coingecko) return null;

  const coinElements: FeishuCardElement[] = [];
  if (header) coinElements.push(renderHeader(header));
  // 标题与第一个分区之间的内容（旧格式的价格行等）
  if (looseLines.length) coinElements.push(...renderFallback(looseLines));

  // 日内/周期研判/合约/结论合并进同一个灰底面板，减少元素数量、控制卡片高度
  const { elements, bodyParts } = renderCoinSections(sections);
  coinElements.push(...elements);
  if (bodyParts.length) coinElements.push(panel(bodyParts.join('\n\n')));

  const coinLinks: CoinLinks = {
    gate: links.gate,
    binance: links.binance ?? null,
    coinglass: links.coinglass,
    coingecko: links.coingecko,
  };
  coinElements.push(renderLinks(coinLinks));

  return { elements: coinElements, links: coinLinks };
}

/** 报告的解析结果：标题行 / 各币种块 / 尾部说明。 */
interface ParsedReport {
  titleLines: string[];
  coinBlocks: CoinBlock[];
  trailerLines: string[];
}

/** 把 buildMessage 输出的整份报告按 `🔹` 边界切成币种块。 */
function splitReport(message: string): ParsedReport {
  const titleLines: string[] = [];
  const coinBlocks: CoinBlock[] = [];
  const trailerLines: string[] = [];
  let current: string[] | null = null;
  let inTrailer = false;

  for (const line of message.split('\n')) {
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

  return { titleLines, coinBlocks, trailerLines };
}

/** 按体积 + 元素数量分片：两项都在飞书限制内。 */
function chunkCoinBlocks(coinBlocks: CoinBlock[]): CoinBlock[][] {
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
  return chunks;
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

/** 把币种块拼成卡片元素，币种之间用 hr 分隔。 */
function buildChunkElements(blocks: CoinBlock[]): FeishuCardElement[] {
  const elements: FeishuCardElement[] = [];
  for (const [j, c] of blocks.entries()) {
    elements.push(...c.elements);
    if (j < blocks.length - 1) elements.push({ tag: 'hr', margin: '8px 0' });
  }
  return elements;
}

/**
 * 把 buildMessage 输出的 Markdown 字符串解析成 1..N 张飞书 2.0 卡片。
 * 不是完整报告或解析失败时返回空数组，调用方应降级到 text 通道。
 */
export function messageToFeishuCards(message: string): FeishuCardPayload[] {
  if (!isFullReportMessage(message)) return [];

  const { titleLines, coinBlocks, trailerLines } = splitReport(message);
  if (coinBlocks.length === 0) return [];

  // 标题去掉 `📊 ` 前缀和 `*...*` 包装（飞书 plain_text 不渲染 markdown）
  const titlePlain = titleLines.join('\n')
    .replace(/^\s*📊\s*\*?/, '')
    .replace(/\*?\s*$/, '')
    .trim() || '加密货币价格报告';

  // 汇率兜底时用橙色 header 提示用户
  const template: CardTemplate = /⚠️汇率兜底/.test(message) ? 'orange' : 'blue';

  // 更新时间放副标题，尾部其余说明放 notation 小字
  const timeLine = trailerLines.find((l) => l.trim().startsWith('⏰'));
  const footerLines = trailerLines
    .filter((l) => l !== timeLine && l.trim())
    .map((l) => l.trim());

  const chunks = chunkCoinBlocks(coinBlocks);

  return chunks.map((blocks, i) => {
    const elements = buildChunkElements(blocks);
    // 尾部小字只挂在最后一张卡片上
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

/** 检测消息是否是 buildMessage 产出的完整报告（含 `🔗 [Gate](` 链接行）。 */
export function isFullReportMessage(message: string): boolean {
  return /🔗\s*\[Gate\]\(/.test(message);
}
