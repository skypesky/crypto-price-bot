import type { IncomingMessage } from 'node:http';

const MAX_BODY = 1 * 1024 * 1024; // 1 MB

export async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error(`request body exceeds ${MAX_BODY} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers['cookie'];
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) result[k] = decodeURIComponent(v);
  }
  return result;
}

export function getPathname(url: string | undefined): string {
  if (!url) return '/';
  const i = url.indexOf('?');
  return (i < 0 ? url : url.slice(0, i)) || '/';
}

export function getQuery(url: string | undefined): URLSearchParams {
  if (!url) return new URLSearchParams();
  const i = url.indexOf('?');
  if (i < 0) return new URLSearchParams();
  return new URLSearchParams(url.slice(i + 1));
}