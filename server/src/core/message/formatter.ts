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