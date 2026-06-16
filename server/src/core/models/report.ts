import { getDb } from '../db.js';

export interface Report {
  id: number;
  triggered_by: string;
  success: number;
  total_coins: number;
  ok_coins: number;
  tg_sent: number;
  feishu_sent: number;
  message: string;
  summary: string;
  created_at: number;
}

export interface CreateReportInput {
  triggered_by: 'cron' | 'manual' | 'test' | 'resend';
  success: boolean;
  total_coins: number;
  ok_coins: number;
  tg_sent: boolean;
  feishu_sent: boolean;
  message: string;
  summary: Record<string, unknown>;
}

export function createReport(input: CreateReportInput): Report {
  const now = Date.now();
  const info = getDb().prepare(
    'INSERT INTO reports (triggered_by, success, total_coins, ok_coins, tg_sent, feishu_sent, message, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    input.triggered_by,
    input.success ? 1 : 0,
    input.total_coins,
    input.ok_coins,
    input.tg_sent ? 1 : 0,
    input.feishu_sent ? 1 : 0,
    input.message,
    JSON.stringify(input.summary),
    now,
  );
  return findById(Number(info.lastInsertRowid))!;
}

export function findById(id: number): Report | null {
  const row = getDb().prepare('SELECT * FROM reports WHERE id = ?').get(id) as Report | undefined;
  return row ?? null;
}

export function listReports(limit = 50): Report[] {
  return getDb().prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT ?').all(limit) as Report[];
}

export function lastReport(): Report | null {
  const row = getDb().prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT 1').get() as Report | undefined;
  return row ?? null;
}