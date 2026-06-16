import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

let _version: string | null = null;

export function getVersion(): string {
  if (_version) return _version;
  // 尝试从 dist 所在 server 目录找 package.json
  // 1) ../../package.json (从 src/version.js)
  // 2) ../package.json (从 dist/version.js)
  const candidates = [
    join(here, '..', '..', 'package.json'),
    join(here, '..', 'package.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf8')) as { version?: string };
        _version = pkg.version ?? 'unknown';
        return _version;
      } catch { /* fallthrough */ }
    }
  }
  _version = process.env['npm_package_version'] ?? 'unknown';
  return _version;
}