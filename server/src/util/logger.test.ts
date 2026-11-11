import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from './logger.js';

describe('logger', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('默认 root logger 写入 stdout/stderr', () => {
    const log = createLogger({ isTTY: false });
    log.info('hello');
    log.error('oops');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain('hello');
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('oops');
  });

  it('child 拼接模块名', () => {
    const log = createLogger({ isTTY: false }).child('http');
    log.info('listening');
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain('[app:http]');
  });

  it('嵌套 child 用 : 分隔', () => {
    const log = createLogger({ isTTY: false }).child('http').child('router');
    log.info('hit');
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain('[app:http:router]');
  });

  it('setLevel 屏蔽低级别日志', () => {
    const log = createLogger({ isTTY: false, level: 'warn' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(stdoutSpy).toHaveBeenCalledTimes(0);
    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });

  it('环形缓冲：超 500 行后只保留最近 500', () => {
    const log = createLogger({ isTTY: false, level: 'debug', ringSize: 500 });
    for (let i = 0; i < 600; i++) {
      log.info(`msg-${i}`);
    }
    const recent = log.recent(10);
    expect(recent.length).toBe(10);
    expect(recent[0]?.msg).toBe('msg-590');
    expect(recent[9]?.msg).toBe('msg-599');
  });

  it('recent(limit) 不超过现有大小', () => {
    const log = createLogger({ isTTY: false });
    log.info('a');
    log.info('b');
    const r = log.recent(100);
    expect(r.length).toBe(2);
    expect(r[0]?.msg).toBe('a');
    expect(r[1]?.msg).toBe('b');
  });

  it('非 string 参数 JSON 序列化', () => {
    const log = createLogger({ isTTY: false });
    log.info('data', { a: 1 }, [1, 2]);
    const out = String(stdoutSpy.mock.calls[0]?.[0]);
    expect(out).toContain('{"a":1}');
    expect(out).toContain('[1,2]');
  });

  it('环形缓冲抛错对象也能序列化', () => {
    const log = createLogger({ isTTY: false });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log.info('circular', circular);
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain('circular');
  });

  it('LOG_LEVEL env 覆盖默认级别', () => {
    const original = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'error';
    const log = createLogger({ isTTY: false });
    log.info('hidden');
    log.error('visible');
    expect(stdoutSpy).toHaveBeenCalledTimes(0);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    process.env.LOG_LEVEL = original;
  });

  it('LOG_LEVEL 非法值回落 info', () => {
    const original = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'nonsense';
    const log = createLogger({ isTTY: false });
    log.debug('hidden');
    log.info('visible');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    process.env.LOG_LEVEL = original;
  });

  it('字符串类型的额外参数原样输出（不做 JSON 序列化）', () => {
    const log = createLogger({ isTTY: false });
    log.info('msg', '__test_plain_string');
    const out = String(stdoutSpy.mock.calls[0]?.[0]);
    // JSON.stringify('__test_plain_string') 会带上引号 → 这里断言没有引号
    expect(out).toContain('__test_plain_string');
    expect(out).not.toContain('"__test_plain_string"');
  });

  it('setLevel 可在运行时动态调整日志级别', () => {
    const log = createLogger({ isTTY: false, level: 'error' });
    log.info('hidden-before');
    expect(stdoutSpy).toHaveBeenCalledTimes(0);

    log.setLevel('debug');
    log.debug('visible-after');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toContain('visible-after');
  });

  it('TTY 模式输出带 ANSI 颜色码与复位码', () => {
    const log = createLogger({ isTTY: true });
    log.info('colored-info');
    const out = String(stdoutSpy.mock.calls[0]?.[0]);
    expect(out).toContain('\x1b[36m'); // info 颜色
    expect(out).toContain('\x1b[0m'); // 复位码
  });

  it('TTY 模式下 warn/error 走 stderr 且同样带颜色码', () => {
    const log = createLogger({ isTTY: true });
    log.warn('warn-msg');
    log.error('error-msg');
    expect(stdoutSpy).toHaveBeenCalledTimes(0);
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('\x1b[33m'); // warn 颜色
    expect(String(stderrSpy.mock.calls[1]?.[0])).toContain('\x1b[31m'); // error 颜色
  });

  it('recent(0) 实际返回全部条目（slice(-0) === slice(0)，源码既有行为）', () => {
    const log = createLogger({ isTTY: false });
    log.info('a');
    // 注意：ring.slice(-0) 等价于 slice(0) → 返回整个环形缓冲，而不是空数组。
    // 这里固化当前实现，便于后续若修正行为时能第一时间发现回归。
    expect(log.recent(0).length).toBe(1);
  });
});