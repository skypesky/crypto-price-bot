import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * scheduler.ts 依赖 croner 做定时调度。这里把 croner / config / task / logger 全部 mock 掉：
 * - 绝不起真实定时器（否则 vitest 进程会挂住）
 * - 可以精确控制「下一次运行时间」「构造抛错」「配置变更回调」等行为
 */
interface FakeCronInstance {
  pattern: string;
  options: { timezone?: string; name?: string };
  cb?: () => void;
  stopped: boolean;
  nextRun: () => Date | null;
}

const h = vi.hoisted(() => ({
  instances: [] as FakeCronInstance[],
  /** nextRun() 的返回值队列，按调用顺序消费 */
  nextRunQueue: [] as (Date | null)[],
  /** 队列为空时 nextRun() 的默认值 */
  defaultNextRun: null as Date | null,
  /** 构造 Cron 时抛出的错误（用于模拟非法 cron 表达式） */
  constructError: null as Error | null,
  getConfig: vi.fn(),
  onConfigChange: vi.fn(),
  runTask: vi.fn(),
  /** config 变更监听器 */
  listener: null as null | (() => void),
}));

vi.mock('croner', () => {
  class FakeCron {
    pattern: string;
    options: { timezone?: string; name?: string };
    cb?: () => void;
    stopped = false;
    constructor(pattern: string, options: { timezone?: string; name?: string }, cb?: () => void) {
      if (h.constructError) throw h.constructError;
      this.pattern = pattern;
      this.options = options;
      this.cb = cb;
      h.instances.push(this as unknown as FakeCronInstance);
    }
    stop(): void {
      this.stopped = true;
    }
    nextRun(): Date | null {
      if (h.nextRunQueue.length > 0) return h.nextRunQueue.shift() ?? null;
      return h.defaultNextRun;
    }
  }
  return { Cron: FakeCron };
});

vi.mock('./config.js', () => ({
  getConfig: h.getConfig,
  onConfigChange: h.onConfigChange,
}));

vi.mock('./task.js', () => ({
  runTask: h.runTask,
}));

vi.mock('../util/logger.js', () => ({
  createLogger: () => ({
    child: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  }),
}));

const BASE_CFG = {
  schedule_rule: '0 */10 * * * *',
  timezone: 'Asia/Shanghai',
};

/** 每次都拿到全新的 scheduler 模块实例（内部有 _job / _running / _nextRunAt 状态） */
async function loadScheduler(): Promise<typeof import('./scheduler.js')> {
  return await import('./scheduler.js');
}

beforeEach(() => {
  vi.resetModules();
  h.instances.length = 0;
  h.nextRunQueue.length = 0;
  h.defaultNextRun = null;
  h.constructError = null;
  h.listener = null;
  h.getConfig.mockReset();
  h.getConfig.mockReturnValue({ ...BASE_CFG });
  h.onConfigChange.mockReset();
  h.onConfigChange.mockImplementation((fn: () => void) => {
    h.listener = fn;
    return () => { h.listener = null; };
  });
  h.runTask.mockReset();
  h.runTask.mockResolvedValue({ reportId: 1 });
});

afterEach(() => {
  // 彻底清理：确保没有遗留的 cron 任务引用
  h.instances.length = 0;
  h.listener = null;
});

describe('scheduler 注册与触发', () => {
  it('按配置注册 cron 任务（表达式 / 时区 / 名称）', async () => {
    const { startScheduler } = await loadScheduler();
    startScheduler();
    expect(h.instances.length).toBe(1);
    expect(h.instances[0]!.pattern).toBe('0 */10 * * * *');
    expect(h.instances[0]!.options.timezone).toBe('Asia/Shanghai');
    expect(h.instances[0]!.options.name).toBe('crypto-price-bot-main');
  });

  it('重复调用 startScheduler 不会重复注册任务', async () => {
    const { startScheduler } = await loadScheduler();
    startScheduler();
    startScheduler();
    expect(h.instances.length).toBe(1);
  });

  it('startScheduler 会注册配置变更监听器', async () => {
    const { startScheduler } = await loadScheduler();
    startScheduler();
    expect(h.onConfigChange).toHaveBeenCalledTimes(1);
    expect(typeof h.listener).toBe('function');
  });

  it('cron 触发时调用 runTask("cron")', async () => {
    const { startScheduler } = await loadScheduler();
    startScheduler();
    h.instances[0]!.cb!();
    expect(h.runTask).toHaveBeenCalledTimes(1);
    expect(h.runTask).toHaveBeenCalledWith('cron');
  });

  it('runTask 同步抛错时错误不会被调度器吞掉', async () => {
    const { startScheduler } = await loadScheduler();
    h.runTask.mockImplementation(() => { throw new Error('任务炸了'); });
    startScheduler();
    expect(() => h.instances[0]!.cb!()).toThrow('任务炸了');
  });

  it('runTask 返回 rejected promise 时调度器不阻塞其它任务', async () => {
    const { startScheduler } = await loadScheduler();
    const rejected = Promise.reject(new Error('异步失败'));
    // 自行兜住 rejection，避免 vitest 报 unhandled rejection
    rejected.catch(() => {});
    h.runTask.mockReturnValue(rejected);
    startScheduler();
    expect(() => h.instances[0]!.cb!()).not.toThrow();
    expect(h.runTask).toHaveBeenCalledWith('cron');
  });
});

describe('scheduler 停止与重启', () => {
  it('stopScheduler 停止当前任务', async () => {
    const { startScheduler, stopScheduler } = await loadScheduler();
    startScheduler();
    const job = h.instances[0]!;
    stopScheduler();
    expect(job.stopped).toBe(true);
  });

  it('未启动时调用 stopScheduler 不报错', async () => {
    const { stopScheduler } = await loadScheduler();
    expect(() => stopScheduler()).not.toThrow();
  });

  it('stop 之后重新 start 会创建新的任务', async () => {
    const { startScheduler, stopScheduler } = await loadScheduler();
    startScheduler();
    stopScheduler();
    startScheduler();
    expect(h.instances.length).toBe(2);
    expect(h.instances[0]!.stopped).toBe(true);
    expect(h.instances[1]!.stopped).toBe(false);
  });
});

describe('scheduler 配置变更后重建任务', () => {
  it('schedule_rule 变更后立即用新表达式重建任务', async () => {
    const { startScheduler } = await loadScheduler();
    startScheduler();
    const old = h.instances[0]!;

    h.getConfig.mockReturnValue({ ...BASE_CFG, schedule_rule: '0 0 18 * * *' });
    h.listener!();

    expect(h.instances.length).toBe(2);
    expect(old.stopped).toBe(true);
    expect(h.instances[1]!.pattern).toBe('0 0 18 * * *');
  });

  it('timezone 变更后立即用新时区重建任务', async () => {
    const { startScheduler } = await loadScheduler();
    startScheduler();

    h.getConfig.mockReturnValue({ ...BASE_CFG, timezone: 'UTC' });
    h.listener!();

    expect(h.instances.length).toBe(2);
    expect(h.instances[1]!.options.timezone).toBe('UTC');
  });

  it('配置变更时旧任务被停止、新任务被创建', async () => {
    const { startScheduler } = await loadScheduler();
    startScheduler();
    const old = h.instances[0]!;
    h.listener!();
    expect(old.stopped).toBe(true);
    expect(h.instances[1]!.stopped).toBe(false);
  });
});

describe('scheduler 非法 cron 表达式', () => {
  it('注册失败时记录错误且不抛出异常', async () => {
    const { startScheduler } = await loadScheduler();
    h.constructError = new Error('Invalid cron expression');
    expect(() => startScheduler()).not.toThrow();
    expect(h.instances.length).toBe(0);
  });

  it('nextRunAt 在表达式非法时返回 null', async () => {
    const { nextRunAt } = await loadScheduler();
    h.constructError = new Error('Invalid cron expression');
    expect(nextRunAt()).toBeNull();
  });
});

describe('scheduler nextRunAt', () => {
  it('已启动时返回已注册任务的下次运行时间', async () => {
    const { startScheduler, nextRunAt } = await loadScheduler();
    const at = new Date('2026-01-01T00:00:00.000Z');
    h.defaultNextRun = at;
    startScheduler();
    expect(nextRunAt()).toBe(at);
  });

  it('未启动时用临时 Cron 计算下次运行时间', async () => {
    const { nextRunAt } = await loadScheduler();
    const at = new Date('2026-02-02T00:00:00.000Z');
    h.defaultNextRun = at;
    expect(nextRunAt()).toBe(at);
    // 只创建临时实例，不会注册真正的调度
    expect(h.instances.length).toBe(1);
    expect(h.instances[0]!.cb).toBeUndefined();
  });

  it('未启动且下一次运行时间为空时返回 null', async () => {
    const { nextRunAt } = await loadScheduler();
    h.defaultNextRun = null;
    expect(nextRunAt()).toBeNull();
  });

  it('已启动但 nextRun() 返回空时回退到缓存的下次运行时间', async () => {
    const { startScheduler, nextRunAt } = await loadScheduler();
    const at = new Date('2026-03-03T00:00:00.000Z');
    // 注册时先拿到具体时间，之后 nextRun() 返回 null
    h.nextRunQueue.push(at);
    h.defaultNextRun = null;
    startScheduler();
    h.nextRunQueue.push(null);
    expect(nextRunAt()).toBe(at);
  });
});

describe('scheduler 运行状态', () => {
  it('默认未在运行中', async () => {
    const { isRunning } = await loadScheduler();
    expect(isRunning()).toBe(false);
  });

  it('_setRunning(true) 后 isRunning 返回 true', async () => {
    const { isRunning, _setRunning } = await loadScheduler();
    _setRunning(true);
    expect(isRunning()).toBe(true);
  });

  it('_setRunning(false) 后 isRunning 返回 false', async () => {
    const { isRunning, _setRunning } = await loadScheduler();
    _setRunning(true);
    _setRunning(false);
    expect(isRunning()).toBe(false);
  });
});
