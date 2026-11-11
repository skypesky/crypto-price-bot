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

// --- 飞书 interactive 卡片（按钮跳转）支持 ---------------------------------
//
// 飞书 `msg_type: text` 不支持 Markdown `[text](url)`，完整 URL 会原样输出且只能
// 由飞书自动识别为可点击。要做出"短文本 + 点击跳转"的效果（与 Telegram 端一致），
// 必须用 `msg_type: interactive` 卡片，链接用 actions 按钮承载。
//
// `buildMessage` 输出结构稳定（标题段 / 每个币种段 / 尾部段），这里按段解析即可。

/** 飞书卡片按钮。type=primary 时按钮高亮，其他交易所保持默认样式。 */
export interface FeishuCardButton {
  tag: 'button';
  text: { tag: 'plain_text'; content: string };
  type: 'primary' | 'default' | 'danger';
  url?: string;
  value?: Record<string, unknown>;
}

/** 飞书卡片元素（简化版，只覆盖我们用到的 tag）。 */
export type FeishuCardElement =
  | { tag: 'markdown'; content: string }
  | { tag: 'action'; actions: FeishuCardButton[] }
  | { tag: 'hr' };

export interface FeishuCardPayload {
  msg_type: 'interactive';
  card: {
    header: {
      title: { tag: 'plain_text'; content: string };
      template: 'blue' | 'green' | 'red' | 'orange' | 'purple' | 'grey';
    };
    elements: FeishuCardElement[];
  };
}

/**
 * 检测消息是否是 buildMessage 产出的完整报告（含 `🔗 [Gate](` 链接行）。
 * 价格预警等短消息不含此特征，会被识别为简单消息。
 */
export function isFullReportMessage(message: string): boolean {
  return /🔗\s*\[Gate\]\(/.test(message);
}

export interface FeishuCardOptions {
  /**
   * 是否追加「🔄 立即查询」回调按钮，默认 true。
   *
   * 该按钮依赖 `card.action.trigger` 事件回调，只有具备事件订阅能力的 Bot 通道
   * （WS / HTTP 回调）才能响应。webhook 自定义机器人没有事件订阅通道，带上就是死按钮
   * → webhook 通道传 false，只保留 url 跳转按钮（点击直接打开链接，不依赖回调）。
   */
  includeQueryButton?: boolean;
}

/**
 * 把 buildMessage 输出的 Markdown 字符串解析成飞书 interactive 卡片。
 * 不是完整报告或解析失败时返回 null，调用方应降级到 text 通道。
 */
export function messageToFeishuCard(message: string, opts?: FeishuCardOptions): FeishuCardPayload | null {
  if (!isFullReportMessage(message)) return null;
  const includeQueryButton = opts?.includeQueryButton ?? true;

  // 报告用空行分隔币种块内的各个分区，所以不能按空行切段 ——
  // 改按 `🔹` 边界切：每个 `🔹` 开头到下一个 `🔹` 之前是一个币种块。
  // 币种块以 `🔗` 链接行结束，之后的内容是报告尾部（更新时间 / 免责声明）。
  type CoinBlock = {
    content: string;
    links: { gate: string; binance: string | null; coinglass: string; coingecko: string };
  };
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

  if (coinBlocks.length === 0) return null;
  // 汇率兜底时用橙色 header 提示用户
  const hasFxFallback = /⚠️汇率兜底/.test(message);
  const template: 'blue' | 'orange' = hasFxFallback ? 'orange' : 'blue';

  const elements: FeishuCardElement[] = [];
  for (const [i, c] of coinBlocks.entries()) {
    elements.push({ tag: 'markdown', content: c.content });
    const buttons: FeishuCardButton[] = [
      { tag: 'button', text: { tag: 'plain_text', content: 'Gate' }, type: 'primary', url: c.links.gate },
    ];
    if (c.links.binance) {
      buttons.push({ tag: 'button', text: { tag: 'plain_text', content: 'Binance' }, type: 'default', url: c.links.binance });
    }
    buttons.push({ tag: 'button', text: { tag: 'plain_text', content: 'CoinGlass' }, type: 'default', url: c.links.coinglass });
    buttons.push({ tag: 'button', text: { tag: 'plain_text', content: 'CoinGecko' }, type: 'default', url: c.links.coingecko });
    // 飞书 schema：按钮容器 tag 必须是 "action"（单数），数组字段名才是 "actions"（复数）。
    // 用 "actions"（复数）会被飞书 API 拒绝：ErrCode 11310 "unsupported type of block"。
    elements.push({ tag: 'action', actions: buttons });
    // 币种之间用 hr 分隔，最后一个币种后不放 hr（避免 trailer 之前出现空分隔）
    if (i < coinBlocks.length - 1) elements.push({ tag: 'hr' });
  }

  if (trailerLines.length > 0) {
    elements.push({ tag: 'markdown', content: trailerLines.join('\n').trim() });
  }

  // 末尾加「立即查询」按钮：用户点击后飞书回调 server 重新拉一次报告并 DM 给点击者
  // 仅 Bot 通道渲染（webhook 无事件订阅通道，按钮点了没反应）
  if (includeQueryButton) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🔄 立即查询' },
          type: 'primary',
          value: { action: 'query_now', v: 1 },
        },
      ],
    });
  }

  return {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: `📊 ${titlePlain}` }, template },
      elements,
    },
  };
}

/**
 * 解析单个币种段：剥离链接行（链接转 actions 按钮），把 `*X*` 转成飞书 markdown 的 `**X**`，
 * 把行内 `code` 转成 `**加粗**`（飞书 markdown 不支持行内单反引号）。
 * 解析不出 Gate/CoinGecko 链接时返回 null（防御：buildMessage 格式被破坏）。
 */
function parseCoinSection(section: string): {
  content: string;
  links: { gate: string; binance: string | null; coinglass: string; coingecko: string };
} | null {
  const lines = section.split('\n');
  const contentLines: string[] = [];
  const links: { gate?: string; binance?: string | null; coinglass?: string; coingecko?: string } = {};

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
    contentLines.push(line);
  }

  if (!links.gate || !links.coinglass || !links.coingecko) return null;

  // Telegram 风格 `*X*` → 飞书 markdown 加粗 `**X**`。负向断言避免误伤 `**X**`。
  // 飞书 markdown 组件不支持行内单反引号（inline code，只支持 ``` 代码块），
  // 留着会原样渲染出 ` 符号 → 转成加粗，保留"重点数据"的视觉区分。
  const content = contentLines.join('\n')
    // 币种块内的空行是分区视觉分隔，飞书 markdown 里会显示成多余空隙 → 收成单个换行
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '**$1**')
    .replace(/`([^`\n]+)`/g, '**$1**');

  return {
    content,
    links: {
      gate: links.gate,
      binance: links.binance ?? null,
      coinglass: links.coinglass,
      coingecko: links.coingecko,
    },
  };
}
