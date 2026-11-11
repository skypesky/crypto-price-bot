import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../util/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../util/http.js')>();
  return { ...actual, httpGet: vi.fn() };
});

vi.mock('../config.js', () => ({
  getConfig: vi.fn(),
}));

import { getGateCandles, getGateCandlesByInterval, getGateKlines } from './klines.js';
import { httpGet, HttpError } from '../../util/http.js';
import { getConfig } from '../config.js';

const mockHttpGet = httpGet as unknown as ReturnType<typeof vi.fn>;
const mockGetConfig = getConfig as unknown as ReturnType<typeof vi.fn>;

/** 造一个测试用配置；doh_enabled 可切换，用于覆盖 DoH 分支。 */
const fakeCfg = (over: Partial<Record<string, unknown>> = {}) => ({
  tg_bot_token: null,
  tg_chat_id: null,
  feishu_webhook_url: null,
  feishu_app_id: null,
  feishu_app_secret: null,
  feishu_encrypt_key: null,
  feishu_verification_token: null,
  feishu_default_receive_id: null,
  feishu_default_receive_id_type: 'chat_id' as const,
  timezone: 'Asia/Shanghai',
  schedule_rule: '0 */10 * * * *',
  ua: 'test-ua',
  doh_enabled: true,
  doh_server: '1.1.1.1',
  doh_bypass: ['1.1.1.1', 'one.one.one.one'],
  request_timeout_ms: 10000,
  max_retries: 3,
  alert_cooldown_hours: 24,
  ...over,
});

/** 造一行 Gate K 线：[时间戳, 计价币成交量, 收盘, 最高, 最低, 基础币成交量] */
const kline = (ts: number | string, close: string, high: string, low: string, volume: string) =>
  [ts, '123.45', close, high, low, volume] as unknown[];

/** 让 httpGet 返回指定数据。 */
function mockData(data: unknown) {
  mockHttpGet.mockResolvedValueOnce({ status: 200, headers: new Headers(), data });
}

/** 取出发给 httpGet 的第一个参数（URL）。 */
function calledUrl(): string {
  return mockHttpGet.mock.calls[0]![0] as string;
}

/** 取出发给 httpGet 的第二个参数（options）。 */
function calledOpts(): Record<string, unknown> {
  return mockHttpGet.mock.calls[0]![1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockReturnValue(fakeCfg());
});

describe('getGateCandlesByInterval', () => {
  it('成功返回 → 按时间升序解析出 ts/close/high/low/volume 并转成数字', async () => {
    mockData([
      kline(1700000000, '100.5', '110', '90', '12.5'),
      kline(1700086400, '101', '111', '91', '13'),
    ]);

    const candles = await getGateCandlesByInterval('BTC_USDT', '1d', 2);

    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({ ts: 1700000000, close: 100.5, high: 110, low: 90, volume: 12.5 });
    expect(candles[1]).toEqual({ ts: 1700086400, close: 101, high: 111, low: 91, volume: 13 });
  });

  it('时间戳是字符串 → 也能转成数字 ts', async () => {
    mockData([kline('1700000000', '1', '2', '0.5', '3')]);

    const candles = await getGateCandlesByInterval('BTC_USDT', '1d', 1);

    expect(candles[0]!.ts).toBe(1700000000);
  });

  it('收盘价非法（NaN）→ 该行被跳过，不进入结果', async () => {
    mockData([
      kline(1700000000, 'abc', '110', '90', '12'),
      kline(1700086400, '100', '110', '90', '12'),
    ]);

    const candles = await getGateCandlesByInterval('BTC_USDT', '1d', 2);

    expect(candles).toHaveLength(1);
    expect(candles[0]!.ts).toBe(1700086400);
  });

  it('最高价非法 → 回退用收盘价', async () => {
    mockData([kline(1700000000, '100', 'abc', '90', '12')]);

    const candles = await getGateCandlesByInterval('BTC_USDT', '1d', 1);

    expect(candles[0]!.high).toBe(100);
  });

  it('最低价非法 → 回退用收盘价', async () => {
    mockData([kline(1700000000, '100', '110', 'abc', '12')]);

    const candles = await getGateCandlesByInterval('BTC_USDT', '1d', 1);

    expect(candles[0]!.low).toBe(100);
  });

  it('成交量非法 → 回退为 0', async () => {
    mockData([kline(1700000000, '100', '110', '90', 'abc')]);

    const candles = await getGateCandlesByInterval('BTC_USDT', '1d', 1);

    expect(candles[0]!.volume).toBe(0);
  });

  it('字段为 null → Number(null)=0 被当成合法数值（不是 NaN）', async () => {
    mockData([[1700000000, null, '100', null, null, null]]);

    const candles = await getGateCandlesByInterval('BTC_USDT', '1d', 1);

    expect(candles[0]).toEqual({ ts: 1700000000, close: 100, high: 0, low: 0, volume: 0 });
  });

  it('字段缺失（数组长度不足）→ 缺失的数值字段回退为 0 / 收盘价', async () => {
    mockData([[1700000000, '1', '100']]);

    const candles = await getGateCandlesByInterval('BTC_USDT', '1d', 1);

    expect(candles[0]).toEqual({ ts: 1700000000, close: 100, high: 100, low: 100, volume: 0 });
  });

  it('返回体不是数组 → 抛错 "Gate.io klines invalid"', async () => {
    mockData({ code: 2, message: 'unknown currency pair' });

    await expect(getGateCandlesByInterval('NOPE_USDT', '1d', 10)).rejects.toThrow(
      'Gate.io klines invalid: NOPE_USDT',
    );
  });

  it('返回空数组 → 返回空结果数组', async () => {
    mockData([]);

    expect(await getGateCandlesByInterval('BTC_USDT', '1d', 10)).toEqual([]);
  });

  it('交易对被 URL 编码后放进 query', async () => {
    mockData([]);

    await getGateCandlesByInterval('BTC/USDT', '1d', 10);

    expect(calledUrl()).toContain('currency_pair=BTC%2FUSDT');
  });

  it('interval 与 limit 原样进入 query', async () => {
    mockData([]);

    await getGateCandlesByInterval('BTC_USDT', '4h', 120);

    expect(calledUrl()).toContain('interval=4h');
    expect(calledUrl()).toContain('limit=120');
  });

  it('非法 interval → 原样透传给 API（源码不做白名单校验）', async () => {
    mockData([]);

    await getGateCandlesByInterval('BTC_USDT', '2h' as never, 10);

    expect(calledUrl()).toContain('interval=2h');
  });

  it('doh_enabled=true → 传入 DoH endpoint 与 bypass 集合', async () => {
    mockData([]);

    await getGateCandlesByInterval('BTC_USDT', '1d', 10);

    const doh = calledOpts().doh as { endpoint: string; bypass: Set<string> };
    expect(doh.endpoint).toBe('https://1.1.1.1/dns-query');
    expect(doh.bypass).toBeInstanceOf(Set);
    expect(doh.bypass.has('1.1.1.1')).toBe(true);
  });

  it('doh_enabled=false → doh 传 null', async () => {
    mockGetConfig.mockReturnValue(fakeCfg({ doh_enabled: false }));
    mockData([]);

    await getGateCandlesByInterval('BTC_USDT', '1d', 10);

    expect(calledOpts().doh).toBeNull();
  });

  it('超时/重试/UA 取自配置并透传给 httpGet', async () => {
    mockData([]);

    await getGateCandlesByInterval('BTC_USDT', '1d', 10);

    expect(calledOpts().timeoutMs).toBe(10000);
    expect(calledOpts().retries).toBe(3);
    expect(calledOpts().headers).toEqual({ 'User-Agent': 'test-ua' });
  });

  it('HTTP 404 → 原样抛出 HttpError', async () => {
    mockHttpGet.mockRejectedValueOnce(new HttpError('HTTP 404 https://api.gateio.ws/...', 404));

    await expect(getGateCandlesByInterval('NOPE_USDT', '1d', 10)).rejects.toBeInstanceOf(HttpError);
  });

  it('网络异常（fetch reject / DNS 失败）→ 原样抛出', async () => {
    mockHttpGet.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.gateio.ws'));

    await expect(getGateCandlesByInterval('BTC_USDT', '1d', 10)).rejects.toThrow(
      'getaddrinfo ENOTFOUND api.gateio.ws',
    );
  });

  it('超时（AbortError）→ 原样抛出', async () => {
    mockHttpGet.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));

    await expect(getGateCandlesByInterval('BTC_USDT', '1d', 10)).rejects.toThrow(
      'The operation was aborted due to timeout',
    );
  });
});

describe('getGateCandles', () => {
  it('按天取数 → interval 固定为 1d，limit 等于传入的天数', async () => {
    mockData([]);

    await getGateCandles('BTC_USDT', 30);

    expect(calledUrl()).toContain('interval=1d');
    expect(calledUrl()).toContain('limit=30');
  });

  it('不传天数 → 使用默认 365 天', async () => {
    mockData([]);

    await getGateCandles('BTC_USDT');

    expect(calledUrl()).toContain('limit=365');
  });

  it('limit=0 → 原样传给 API（不做校验）', async () => {
    mockData([]);

    await getGateCandles('BTC_USDT', 0);

    expect(calledUrl()).toContain('limit=0');
  });

  it('非法交易对 → 原样编码后请求，不做本地校验', async () => {
    mockData({ code: 2, message: 'invalid pair' });

    await expect(getGateCandles('@@bad pair@@', 10)).rejects.toThrow('Gate.io klines invalid');
    expect(calledUrl()).toContain('currency_pair=%40%40bad%20pair%40%40');
  });
});

describe('getGateKlines', () => {
  it('成功返回 → 只取收盘价数组，按升序', async () => {
    mockData([
      kline(1700000000, '100', '110', '90', '1'),
      kline(1700086400, '101.5', '111', '91', '2'),
    ]);

    expect(await getGateKlines('BTC_USDT', 2)).toEqual([100, 101.5]);
  });

  it('不传天数 → 使用默认 365 天', async () => {
    mockData([]);

    await getGateKlines('BTC_USDT');

    expect(calledUrl()).toContain('limit=365');
  });
});
