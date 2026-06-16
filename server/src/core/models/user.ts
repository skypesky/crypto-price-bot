import { getDb } from '../db.js';
import { hashPassword, verifyPassword } from '../../util/auth.js';

export interface User {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
  updated_at: number;
}

export async function findByUsername(username: string): Promise<User | null> {
  const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
  return row ?? null;
}

export async function findById(id: number): Promise<User | null> {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  return row ?? null;
}

export async function createUser(username: string, password: string): Promise<User> {
  const now = Date.now();
  const hash = await hashPassword(password);
  const stmt = getDb().prepare(
    'INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)',
  );
  const info = stmt.run(username, hash, now, now);
  return (await findById(Number(info.lastInsertRowid)))!;
}

export async function verifyLogin(username: string, password: string): Promise<User | null> {
  const user = await findByUsername(username);
  if (!user) return null;
  const ok = await verifyPassword(password, user.password_hash);
  return ok ? user : null;
}

export async function changePassword(userId: number, oldPassword: string, newPassword: string): Promise<boolean> {
  const user = await findById(userId);
  if (!user) return false;
  const ok = await verifyPassword(oldPassword, user.password_hash);
  if (!ok) return false;
  const hash = await hashPassword(newPassword);
  getDb().prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hash, Date.now(), userId);
  return true;
}

export async function countUsers(): Promise<number> {
  const row = getDb().prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
  return row.c;
}