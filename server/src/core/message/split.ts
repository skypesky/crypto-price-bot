/**
 * 把长报告按段落拆成多条消息。
 *
 * Telegram sendMessage 的文本上限是 4096 字符，而完整报告（10 个币 × 趋势+均线+研判+链接）
 * 轻松超过 6000 字符 → 必须分段发，否则整条推送会被 Telegram 拒掉（message is too long）。
 *
 * 段落边界用空行（\n\n）—— buildMessage 输出里每个币种块、标题、尾部之间都是空行，
 * 按空行切不会把一个币种块劈成两半。
 */
export function splitMessage(message: string, limit = 3800): string[] {
  if (message.length <= limit) return [message];

  const blocks = message.split(/\n\n+/).filter((b) => b.trim().length > 0);
  const out: string[] = [];
  let cur = '';

  for (const block of blocks) {
    const candidate = cur ? `${cur}\n\n${block}` : block;
    if (candidate.length > limit && cur) {
      out.push(cur);
      cur = block;
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);

  // 极端情况：单个块本身就超限（不该发生，但别把内容丢掉）→ 兜底硬切
  return out.flatMap((part) => (part.length > limit ? hardSplit(part, limit) : [part]));
}

/** 兜底：按行硬切，避免单块超限时丢内容。 */
function hardSplit(text: string, limit: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > limit) {
      out.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) out.push(cur);
  return out;
}
