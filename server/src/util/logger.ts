/**
 * 带级别、子 logger、环形缓冲的日志器。
 *
 * 用法：
 *   import { createLogger } from './logger.js';
 *   const log = createLogger();
 *   const modLog = log.child('http');
 *   modLog.info('listening on :8787');
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const RESET = '\x1b[0m';

const RING_SIZE = 500;

export interface LogEntry {
  ts: number;
  level: LogLevel;
  module: string;
  msg: string;
}

export interface Logger {
  debug: (msg: string, ...rest: unknown[]) => void;
  info: (msg: string, ...rest: unknown[]) => void;
  warn: (msg: string, ...rest: unknown[]) => void;
  error: (msg: string, ...rest: unknown[]) => void;
  child: (module: string) => Logger;
  setLevel: (level: LogLevel) => void;
  recent: (limit: number) => LogEntry[];
}

export interface LoggerOptions {
  level?: LogLevel;
  isTTY?: boolean;
  ringSize?: number;
}

function isLogLevel(v: unknown): v is LogLevel {
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error';
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const envLevel = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  const initialLevel: LogLevel = isLogLevel(envLevel) ? envLevel : 'info';
  let level: LogLevel = opts.level ?? initialLevel;
  const isTTY = opts.isTTY ?? Boolean(process.stdout?.isTTY);
  const ringSize = opts.ringSize ?? RING_SIZE;
  const ring: LogEntry[] = [];

  function log(entryLevel: LogLevel, module: string, msg: string, rest: unknown[]) {
    if (LEVEL_RANK[entryLevel] < LEVEL_RANK[level]) return;
    const ts = Date.now();
    const entry: LogEntry = { ts, level: entryLevel, module, msg };
    ring.push(entry);
    if (ring.length > ringSize) ring.shift();
    const time = new Date(ts).toISOString();
    const color = isTTY ? LEVEL_COLOR[entryLevel] : '';
    const r = isTTY ? RESET : '';
    const extra = rest.length > 0 ? ' ' + rest.map(stringify).join(' ') : '';
    const line = `${time} ${color}[${entryLevel.toUpperCase()}]${r} [${module}] ${msg}${extra}`;
    if (entryLevel === 'error' || entryLevel === 'warn') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }

  function stringify(v: unknown): string {
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  function makeChild(module: string): Logger {
    return {
      debug: (msg, ...rest) => log('debug', module, msg, rest),
      info: (msg, ...rest) => log('info', module, msg, rest),
      warn: (msg, ...rest) => log('warn', module, msg, rest),
      error: (msg, ...rest) => log('error', module, msg, rest),
      child: (sub: string) => makeChild(`${module}:${sub}`),
      setLevel: (l) => { level = l; },
      recent: (limit) => ring.slice(-limit),
    };
  }

  return makeChild('app');
}

export const logger = createLogger();