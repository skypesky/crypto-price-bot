import { Cron } from 'croner';
import { getConfig, onConfigChange } from './config.js';
import { createLogger } from '../util/logger.js';
import { runTask } from './task.js';

const log = createLogger({ isTTY: false }).child('scheduler');

let _job: Cron | null = null;
let _running = false;
let _nextRunAt: Date | null = null;

function schedule(): void {
  if (_job) {
    _job.stop();
    _job = null;
  }
  const cfg = getConfig();
  try {
    _job = new Cron(cfg.schedule_rule, {
      timezone: cfg.timezone,
      name: 'crypto-price-bot-main',
    }, () => {
      log.info('cron triggered');
      void runTask('cron');
    });
    _nextRunAt = _job.nextRun() ?? null;
    log.info(`scheduled: "${cfg.schedule_rule}" tz=${cfg.timezone} next=${_nextRunAt?.toISOString() ?? 'n/a'}`);
  } catch (err) {
    log.error(`failed to schedule "${cfg.schedule_rule}": ${(err as Error).message}`);
  }
}

export function startScheduler(): void {
  if (_job) return;
  schedule();
  onConfigChange(() => {
    log.info('config reloaded, rescheduling');
    schedule();
  });
}

export function stopScheduler(): void {
  if (_job) {
    _job.stop();
    _job = null;
  }
  _nextRunAt = null;
}

export function nextRunAt(): Date | null {
  if (!_job) {
    const cfg = getConfig();
    try {
      const tmp = new Cron(cfg.schedule_rule, { timezone: cfg.timezone });
      return tmp.nextRun() ?? null;
    } catch {
      return null;
    }
  }
  return _job.nextRun() ?? _nextRunAt;
}

export function isRunning(): boolean {
  return _running;
}

/** 防止递归 schedule 标记；task 自身用 */
export function _setRunning(v: boolean): void {
  _running = v;
}