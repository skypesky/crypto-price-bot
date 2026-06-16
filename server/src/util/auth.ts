import bcrypt from 'bcryptjs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomTokenB64 } from './id.js';

const BCRYPT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * 简易 HMAC 签名 token：base64url(payload).hex(hmac-sha256)
 * payload = `${userId}.${expiresAt}`
 * secret 通过 initAuth(secret) 注入
 */

let _secret = '';

export function initAuth(secret: string): void {
  if (!secret || secret.length < 16) {
    throw new Error('initAuth: secret must be at least 16 chars');
  }
  _secret = secret;
}

interface TokenPayload {
  userId: number;
  expiresAt: number; // ms epoch
}

function sign(payload: string): string {
  return createHmac('sha256', _secret).update(payload).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function createToken(userId: number, ttlMs: number): string {
  if (!_secret) throw new Error('auth not initialized: call initAuth(secret) first');
  const expiresAt = Date.now() + ttlMs;
  const payload = `${userId}.${expiresAt}`;
  const sig = sign(payload);
  const body = Buffer.from(payload, 'utf8').toString('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token: string): TokenPayload | null {
  if (!_secret) throw new Error('auth not initialized');
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  let payload: string;
  try {
    payload = Buffer.from(body, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = sign(payload);
  if (!safeEqual(sig, expected)) return null;
  const parts = payload.split('.');
  if (parts.length !== 2) return null;
  const userId = parseInt(parts[0] ?? '', 10);
  const expiresAt = parseInt(parts[1] ?? '', 10);
  if (!Number.isFinite(userId) || !Number.isFinite(expiresAt)) return null;
  if (Date.now() >= expiresAt) return null;
  return { userId, expiresAt };
}

/**
 * 生成 session token（仅随机串，不签名）。
 * 用作 cookie 携带的 session id，配合 DB sessions 表校验。
 */
export function generateSessionToken(): string {
  return randomTokenB64(32);
}