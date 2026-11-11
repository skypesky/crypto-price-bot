import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * version.ts 通过 node:fs 探测 package.json，这里把 fs mock 掉，
 * 以便稳定地覆盖「候选文件不存在 / 解析失败 / 缺字段 / 环境变量兜底」等分支。
 * 注意：mock 的是同一批稳定的 vi.fn，vi.resetModules() 之后依然生效。
 */
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMock.existsSync.mockImplementation(actual.existsSync);
  fsMock.readFileSync.mockImplementation(actual.readFileSync);
  return {
    ...actual,
    existsSync: fsMock.existsSync,
    readFileSync: fsMock.readFileSync,
  };
});

/** server/package.json 的绝对路径（src/version.ts 的第二个候选） */
const SERVER_PKG = new URL('../package.json', import.meta.url).pathname;

beforeEach(() => {
  vi.resetModules();
  fsMock.existsSync.mockClear();
  fsMock.readFileSync.mockClear();
});

afterEach(() => {
  delete process.env['npm_package_version'];
});

/** 每次都拿到全新的模块实例（version.ts 内部有 _version 缓存） */
async function loadVersion(): Promise<typeof import('./version.js')> {
  return await import('./version.js');
}

describe('version', () => {
  it('从 server/package.json 读取版本号', async () => {
    const { getVersion } = await loadVersion();
    const raw = fsMock.readFileSync(SERVER_PKG, 'utf8') as string;
    const expected = JSON.parse(raw).version as string;
    expect(getVersion()).toBe(expected);
  });

  it('第二次调用走缓存，不再重复读文件', async () => {
    const { getVersion } = await loadVersion();
    const first = getVersion();
    const callsAfterFirst = fsMock.readFileSync.mock.calls.length;
    const second = getVersion();
    expect(second).toBe(first);
    expect(fsMock.readFileSync.mock.calls.length).toBe(callsAfterFirst);
  });

  it('候选路径顺序为 ../../package.json 然后 ../package.json', async () => {
    const { getVersion } = await loadVersion();
    const checked: string[] = [];
    fsMock.existsSync.mockImplementation((p: unknown) => {
      checked.push(String(p));
      return false;
    });
    fsMock.readFileSync.mockImplementation(() => {
      throw new Error('不应该读文件');
    });
    getVersion();
    expect(checked.length).toBe(2);
    expect(checked[0]).toContain('/package.json');
    expect(checked[0]).not.toBe(checked[1]);
    // 第一个候选是仓库根目录，第二个候选是 server 目录
    expect(checked[1]).toBe(SERVER_PKG);
  });

  it('package.json 没有 version 字段时返回 unknown', async () => {
    const { getVersion } = await loadVersion();
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ name: 'no-version' }));
    expect(getVersion()).toBe('unknown');
  });

  it('package.json 解析失败时继续尝试下一个候选文件', async () => {
    const { getVersion } = await loadVersion();
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockImplementation((p: unknown) => {
      if (String(p) === SERVER_PKG) return JSON.stringify({ version: '9.9.9' });
      throw new Error('坏 JSON');
    });
    expect(getVersion()).toBe('9.9.9');
  });

  it('所有候选文件都不存在时回退到 npm_package_version 环境变量', async () => {
    const { getVersion } = await loadVersion();
    fsMock.existsSync.mockReturnValue(false);
    process.env['npm_package_version'] = '1.2.3';
    expect(getVersion()).toBe('1.2.3');
  });

  it('候选文件都不存在且无环境变量时返回 unknown', async () => {
    const { getVersion } = await loadVersion();
    fsMock.existsSync.mockReturnValue(false);
    delete process.env['npm_package_version'];
    expect(getVersion()).toBe('unknown');
  });
});
