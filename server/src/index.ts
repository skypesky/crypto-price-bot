/**
 * 进程入口：loadConfig → init db → 注册路由 → http listen → start scheduler。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Node 20.6+ 内置 --env-file 支持。若未通过 flag 传入且存在 .env，自动加载。
if (!process.env['__CPB_ENV_LOADED__']) {
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) {
    try {
      const text = readFileSync(envFile, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
      process.env['__CPB_ENV_LOADED__'] = '1';
    } catch { /* ignore */ }
  }
}

import { initDb, closeDb, pingDb } from './core/db.js';
import { initDefaults as initSettingDefaults } from './core/models/setting.js';
import { initDefaultCoins } from './core/models/coin.js';
import { loadConfig, getConfig } from './core/config.js';
import { initAuth } from './util/auth.js';
import { createLogger } from './util/logger.js';
import { buildApp, listen } from './http/server.js';
import { authMiddleware } from './http/middleware.js';
import { registerStatus } from './api/status.js';
import { registerAuth, resolveAuthedUser } from './api/auth.js';
import { registerSettings } from './api/settings.js';
import { registerCoins } from './api/coins.js';
import { registerReports } from './api/reports.js';
import { registerTask } from './api/task.js';
import { registerLogs } from './api/logs.js';
import { startScheduler, stopScheduler } from './core/scheduler.js';
import { runTask } from './core/task.js';
import { createUser, countUsers } from './core/models/user.js';
import { disposeHttp } from './util/http.js';

const log = createLogger({ isTTY: process.stdout.isTTY ?? false }).child('main');

const here = dirname(fileURLToPath(import.meta.url));

function resolveDbPath(): string {
  const fromEnv = process.env['DATABASE_PATH'];
  if (fromEnv) return resolve(fromEnv);
  // 默认 ./data/crypto.db（相对 cwd）
  return resolve(process.cwd(), 'data', 'crypto.db');
}

function resolveStaticDir(): string | undefined {
  // dist/index.js → ../../src/static
  const distStatic = resolve(here, '..', 'src', 'static');
  if (existsSync(distStatic)) return distStatic;
  // 开发态：src/static
  const srcStatic = resolve(here, 'static');
  if (existsSync(srcStatic)) return srcStatic;
  return undefined;
}

async function bootstrap(): Promise<void> {
  // 1. 读取环境
  const port = parseInt(process.env['PORT'] ?? '8787', 10);
  const dbPath = resolveDbPath();

  // 2. 初始化 DB
  initDb(dbPath);
  initSettingDefaults();
  initDefaultCoins();

  // 3. 初始化默认用户（仅当 users 表为空且 env 提供）
  if ((await countUsers()) === 0) {
    const username = process.env['INIT_USERNAME'] || 'admin';
    const password = process.env['INIT_PASSWORD'] || 'admin123456';
    await createUser(username, password);
    log.warn(`no users found, created default admin user: ${username} / ${password} (please change!)`);
  }

  // 4. 加载配置（会读 env 覆盖 db）
  loadConfig();

  // 5. 初始化 auth secret（从 env 拿；没有则用静态 dbPath 的 hash）
  const authSecret = process.env['AUTH_SECRET']
    || createHash('sha256').update(dbPath + ':cpb').digest('hex');
  initAuth(authSecret);

  // 6. 装配 HTTP
  const app = buildApp({
    resolveSession: resolveAuthedUser,
    staticDir: resolveStaticDir(),
  });

  // 注册路由
  registerStatus(app.router);
  registerAuth(app.router);
  // 受保护路由：先插 auth 中间件
  app.middlewares.push(authMiddleware(resolveAuthedUser));
  registerSettings(app.router);
  registerCoins(app.router);
  registerReports(app.router);
  registerTask(app.router);
  registerLogs(app.router);

  // 7. 启动 server
  const { server, close: closeHttp } = await listen(app, {
    port,
    host: process.env['HOST'] ?? '0.0.0.0',
    resolveSession: resolveAuthedUser,
    staticDir: resolveStaticDir(),
  });

  // 8. 启动调度器
  const isGitHubActions = process.env['GITHUB_ACTIONS'] === 'true';
  if (!isGitHubActions) {
    startScheduler();
  }

  log.info(`ready: port=${port} db=${dbPath} dbOk=${pingDb()} scheduler=${!isGitHubActions}`);

  // 9. GitHub Actions 模式：执行一次任务后退出
  if (isGitHubActions) {
    log.info('GITHUB_ACTIONS mode: running single task then exit');
    // schedule 触发 = cron；workflow_dispatch 触发 = manual
    const triggeredBy: 'cron' | 'manual' =
      process.env['GITHUB_EVENT_NAME'] === 'schedule' ? 'cron' : 'manual';
    runTask(triggeredBy).then(() => {
      log.info(`GITHUB_ACTIONS task (${triggeredBy}) done, exiting`);
      setTimeout(() => shutdown(server, closeHttp), 5000);
    }).catch((err) => {
      log.error('GITHUB_ACTIONS task failed', err);
      process.exit(1);
    });
  }

  // 10. 优雅退出
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log.info(`received ${sig}, shutting down`);
      shutdown(server, closeHttp);
    });
  }
}

function shutdown(server: import('node:http').Server, closeHttp: () => Promise<void>): void {
  stopScheduler();
  server.close();
  closeHttp().then(() => {
    closeDb();
    disposeHttp();
    log.info('shutdown complete');
    process.exit(0);
  }).catch((err) => {
    log.error('shutdown error', err);
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  console.error('bootstrap failed:', err);
  process.exit(1);
});
