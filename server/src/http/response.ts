import type { ServerResponse } from 'node:http';
import { HttpError } from './errors.js';
import { createLogger } from '../util/logger.js';

const log = createLogger({ isTTY: false }).child('http').child('response');

export function sendJson<T>(res: ServerResponse, status: number, data: T): void {
  const body = JSON.stringify({ ok: status < 400, data });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendOk<T>(res: ServerResponse, data: T): void {
  sendJson(res, 200, data);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error('unhandled error', err);
  sendJson(res, 500, { error: { code: 'internal_error', message } });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.map':  'application/json',
  '.txt':  'text/plain; charset=utf-8',
};

export function mimeFor(filePath: string): string {
  const idx = filePath.lastIndexOf('.');
  if (idx < 0) return 'application/octet-stream';
  return MIME[filePath.slice(idx).toLowerCase()] ?? 'application/octet-stream';
}