import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../util/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../util/http.js')>();
  return { ...actual, httpGet: vi.fn() };
});

vi.mock('../config.js', () => ({
  getConfig: vi.fn(),
}));

import { getGateTicker } from './ticker.js';
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
  doh_bypass: ['1.1.1.1'],
  request_timeout_ms: 10000,
  max_retries: 3,
  alert_cooldown_hours: 24,
  ...over,
});

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

describe('getGateTicker', () => {
  it('成功返回 → 取数组第一条', async () => {
    mockData([
      {
        currency_pair: 'BTC_USDT',
        last: '65000.12',
        lowest_ask: '65000.5',
        highest_bid: '64999.5',
        change_percentage: '1.23',
        base_volume: '1000.5',
        quote_volume: '65000000',
        high_24h: '66000',
        low_24h: '63000',
      },
      { currency_pair: 'ETH_USDT', last: '3000' },
    ]);

    const t = await getGateTicker('BTC_USDT');

    expect(t.currency_pair).toBe('BTC_USDT');
    expect(t.last).toBe('65000.12');
    expect(t.high_24h).toBe('66000');
    expect(t.low_24h).toBe('63000');
  });

  it('返回体不是数组 → 抛错 "Gate.io ticker empty"', async () => {
    mockData({ code: 2, message: 'unknown currency pair' });

    await expect(getGateTicker('NOPE_USDT')).rejects.toThrow('Gate.io ticker empty: NOPE_USDT');
  });

  it('返回空数组 → 抛错 "Gate.io ticker empty"', async () => {
    mockData([]);

    await expect(getGateTicker('NOPE_USDT')).rejects.toThrow('Gate.io ticker empty: NOPE_USDT');
  });

  it('返回 null → 抛错 "Gate.io ticker empty"', async () => {
    mockData(null);

    await expect(getGateTicker('NOPE_USDT')).rejects.toThrow('Gate.io ticker empty: NOPE_USDT');
  });

  it('字段缺失 → 原样返回，不做默认值填充', async () => {
    mockData([{ currency_pair: 'BTC_USDT' }]);

    const t = await getGateTicker('BTC_USDT');

    expect(t).toEqual({ currency_pair: 'BTC_USDT' });
    expect(t.last).toBeUndefined();
  });

  it('交易对被 URL 编码后放进 query', async () => {
    mockData([{ currency_pair: 'BTC_USDT', last: '1' }]);

    await getGateTicker('BTC/USDT');

    expect(calledUrl()).toContain('currency_pair=BTC%2FUSDT');
    expect(calledUrl()).toContain('/api/v4/spot/tickers');
  });

  it('非法交易对 → 原样编码后请求，不做本地校验', async () => {
    mockData({ code: 2, message: 'invalid pair' });

    await expect(getGateTicker('@@bad pair@@')).rejects.toThrow('Gate.io ticker empty');
    expect(calledUrl()).toContain('currency_pair=%40%40bad%20pair%40%40');
  });

  it('doh_enabled=true → 传入 DoH endpoint 与 bypass 集合', async () => {
    mockData([{ currency_pair: 'BTC_USDT', last: '1' }]);

    await getGateTicker('BTC_USDT');

    const doh = calledOpts().doh as { endpoint: string; bypass: Set<string> };
    expect(doh.endpoint).toBe('https://1.1.1.1/dns-query');
    expect(doh.bypass).toBeInstanceOf(Set);
    expect(doh.bypass.has('1.1.1.1')).toBe(true);
  });

  it('doh_enabled=false → doh 传 null', async () => {
    mockGetConfig.mockReturnValue(fakeCfg({ doh_enabled: false }));
    mockData([{ currency_pair: 'BTC_USDT', last: '1' }]);

    await getGateTicker('BTC_USDT');

    expect(calledOpts().doh).toBeNull();
  });

  it('超时/重试/UA 取自配置并透传给 httpGet', async () => {
    mockData([{ currency_pair: 'BTC_USDT', last: '1' }]);

    await getGateTicker('BTC_USDT');

    expect(calledOpts().timeoutMs).toBe(10000);
    expect(calledOpts().retries).toBe(3);
    expect(calledOpts().headers).toEqual({ 'User-Agent': 'test-ua' });
  });

  it('HTTP 404 → 原样抛出 HttpError', async () => {
    mockHttpGet.mockRejectedValueOnce(new HttpError('HTTP 404 https://api.gateio.ws/...', 404));

    await expect(getGateTicker('NOPE_USDT')).rejects.toBeInstanceOf(HttpError);
  });

  it('网络异常（fetch reject / DNS 失败）→ 原样抛出', async () => {
    mockHttpGet.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.gateio.ws'));

    await expect(getGateTicker('BTC_USDT')).rejects.toThrow('getaddrinfo ENOTFOUND api.gateio.ws');
  });

  it('超时（AbortError）→ 原样抛出', async () => {
    mockHttpGet.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));

    await expect(getGateTicker('BTC_USDT')).rejects.toThrow('The operation was aborted due to timeout');
  });
});
