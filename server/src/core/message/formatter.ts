/**
 * 消息格式化入口。
 *
 * 实现分散在 `feishu/` 子模块：
 * - `types.ts`    卡片 JSON 2.0 类型定义
 * - `markdown.ts` Markdown / Lark 文本转换与基础元素构造
 * - `render.ts`   各分区（趋势 / 日内 / 周期研判 / 合约 / 结论）渲染
 * - `parse.ts`    报告解析、分片与卡片组装
 */

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

export {
  isFullReportMessage,
  messageToFeishuCard,
  messageToFeishuCards,
} from './feishu/parse.js';

export type {
  FeishuCardElement,
  FeishuCardPayload,
  FeishuColumn,
} from './feishu/types.js';
