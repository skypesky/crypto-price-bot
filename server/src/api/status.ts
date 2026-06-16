import { Router, type Handler } from '../http/router.js';
import { sendOk } from '../http/response.js';
import { pingDb, getDb } from '../core/db.js';
import { getConfig } from '../core/config.js';
import { nextRunAt } from '../core/scheduler.js';
import { lastReport } from '../core/models/report.js';
import { listEnabledCoins } from '../core/models/coin.js';
import { countUsers } from '../core/models/user.js';
import { getVersion } from '../version.js';

export function registerStatus(r: Router): void {
  const h: Handler = async (ctx) => {
    const cfg = getConfig();
    const last = lastReport();
    sendOk(ctx.res, {
      version: getVersion(),
      uptime: process.uptime(),
      dbOk: pingDb(),
      sqliteVersion: getDbVersion(),
      totalCoins: listEnabledCoins().length,
      userCount: await countUsers(),
      nextRunAt: nextRunAt()?.toISOString() ?? null,
      lastReportAt: last ? new Date(last.created_at).toISOString() : null,
      timezone: cfg.timezone,
      scheduleRule: cfg.schedule_rule,
    });
  };
  r.get('/api/status', h);
}

function getDbVersion(): string | null {
  try {
    const row = getDb().prepare('SELECT sqlite_version() as v').get() as { v: string };
    return row.v;
  } catch {
    return null;
  }
}