import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  generateSessionToken,
  initAuth,
} from './auth.js';

const SECRET = 'test-secret-must-be-at-least-16-chars';

beforeAll(() => {
  initAuth(SECRET);
});

/** 用与源码一致的 HMAC 算法手工签一个 payload，构造边界 token */
function signPayload(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('hex');
}

function makeToken(payload: string): string {
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${signPayload(payload)}`;
}

describe('password hashing', () => {
  it('hash + verify 往返', async () => {
    const h = await hashPassword('mypassword');
    expect(h).toMatch(/^\$2[aby]\$/);
    expect(await verifyPassword('mypassword', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('verify 拒绝空 hash', async () => {
    expect(await verifyPassword('any', '')).toBe(false);
  });

  it('同密码多次 hash 结果不同（bcrypt salt）', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
  });
});

describe('token', () => {
  beforeEach(() => {
    // 其它用例会临时改 secret，这里统一复位，保证签名可复现
    initAuth(SECRET);
  });

  it('create + verify 往返', () => {
    const t = createToken(42, 60_000);
    const p = verifyToken(t);
    expect(p).not.toBeNull();
    expect(p!.userId).toBe(42);
    expect(p!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('过期 token 拒绝', () => {
    const t = createToken(1, -1000);
    expect(verifyToken(t)).toBeNull();
  });

  it('篡改 token 拒绝', () => {
    const t = createToken(99, 60_000);
    const tampered = t.slice(0, -2) + (t.endsWith('00') ? '11' : '00');
    expect(verifyToken(tampered)).toBeNull();
  });

  it('空 token 拒绝', () => {
    expect(verifyToken('')).toBeNull();
    expect(verifyToken('a.b.c')).toBeNull();
    expect(verifyToken('nodot')).toBeNull();
  });

  it('不同 secret 签的 token 拒绝', () => {
    const t = createToken(1, 60_000);
    initAuth('a-different-secret-also-16+');
    expect(verifyToken(t)).toBeNull();
    // 恢复
    initAuth('test-secret-must-be-at-least-16-chars');
  });

  it('签名长度与期望不一致 → 拒绝', () => {
    const t = createToken(7, 60_000);
    // 尾部多两个字符 → 签名长度不同 → safeEqual 直接失败
    expect(verifyToken(`${t}ab`)).toBeNull();
  });

  it('payload 段数不是 2 → 拒绝', () => {
    // 签名正确，但 payload 是三段 → 结构非法
    expect(verifyToken(makeToken('1.2.3'))).toBeNull();
  });

  it('payload 的 userId 不是数字 → 拒绝', () => {
    expect(verifyToken(makeToken('__test_user.99999999999999'))).toBeNull();
  });

  it('payload 的 expiresAt 不是数字 → 拒绝', () => {
    expect(verifyToken(makeToken('5.__test_expire'))).toBeNull();
  });

  it('token 体解码抛异常 → 返回 null 而不是把异常抛给调用方', () => {
    // Node 的 base64url 解码器本身不会抛错，这里用 stub 强制触发源码里的防御分支
    const originalFrom = Buffer.from.bind(Buffer);
    const spy = vi.spyOn(Buffer, 'from').mockImplementation(((...args: unknown[]) => {
      if (args[1] === 'base64url') throw new Error('__test_decode_boom');
      return originalFrom(...(args as [string, BufferEncoding]));
    }) as never);
    try {
      expect(verifyToken(createToken(1, 60_000))).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('initAuth', () => {
  it('secret 少于 16 字符 → 抛错', () => {
    expect(() => initAuth('short-secret')).toThrow(/at least 16 chars/);
  });

  it('secret 为空字符串 → 抛错', () => {
    expect(() => initAuth('')).toThrow(/at least 16 chars/);
  });

  it('secret 恰好 16 字符 → 通过', () => {
    expect(() => initAuth('0123456789abcdef')).not.toThrow();
    initAuth(SECRET);
  });
});

describe('未初始化时的行为', () => {
  it('createToken / verifyToken 均抛「未初始化」错误', async () => {
    // 重置模块缓存，重新 import 得到一个 _secret 为空的新实例
    vi.resetModules();
    const fresh = await import('./auth.js');
    expect(() => fresh.createToken(1, 1000)).toThrow(/auth not initialized/);
    expect(() => fresh.verifyToken('any.token')).toThrow(/auth not initialized/);
  });
});

describe('session token', () => {
  it('generateSessionToken 长度 43 chars (base64url of 32 bytes)', () => {
    const t = generateSessionToken();
    expect(t.length).toBe(43);
    expect(t).not.toMatch(/[+/=]/);
  });

  it('两次结果不同', () => {
    expect(generateSessionToken()).not.toBe(generateSessionToken());
  });
});