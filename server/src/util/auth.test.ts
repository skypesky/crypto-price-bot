import { describe, it, expect, beforeAll } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  generateSessionToken,
  initAuth,
} from './auth.js';

beforeAll(() => {
  initAuth('test-secret-must-be-at-least-16-chars');
});

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