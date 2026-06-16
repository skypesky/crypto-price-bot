import { getDb } from '../db.js';
import { generateSessionToken } from '../../util/auth.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface Session {
  token: string;
  user_id: number;
  expires_at: number;
  created_at: number;
}

export function createSession(userId: number): Session {
  const now = Date.now();
  const token = generateSessionToken();
  const expiresAt = now + SESSION_TTL_MS;
  getDb().prepare(
    'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  ).run(token, userId, expiresAt, now);
  return { token, user_id: userId, expires_at: expiresAt, created_at: now };
}

export function findValidSession(token: string): Session | null {
  if (!token) return null;
  const row = getDb().prepare(
    'SELECT * FROM sessions WHERE token = ? AND expires_at > ?',
  ).get(token, Date.now()) as Session | undefined;
  return row ?? null;
}

export function deleteSession(token: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function deleteUserSessions(userId: number): void {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeExpired(): number {
  const info = getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  return info.changes;
}