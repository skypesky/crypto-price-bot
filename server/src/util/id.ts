import { randomBytes, randomInt } from 'node:crypto';

/**
 * 生成 hex 编码的随机 token。
 * @param bytes 字节数（默认 32 → 64 字符 hex）
 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * 生成 URL-safe base64 编码的随机 token（不带 padding）。
 */
export function randomTokenB64(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * [min, max) 区间随机整数。
 */
export function randomIntInclusive(min: number, max: number): number {
  if (max <= min) throw new Error(`randomIntInclusive: max (${max}) must be > min (${min})`);
  return randomInt(min, max);
}

let _counter = 0;

/**
 * 单调递增的进程内 ID（用于日志排序、临时标识）。
 */
export function uniqueId(prefix = ''): string {
  _counter = (_counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}${Date.now().toString(36)}${_counter.toString(36)}`;
}