import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDb, closeDb } from './db.js';
import type { GateCandle } from './gate/klines.js';
import type { GateDerivatives } from './gate/futures.js';
import type { CoinResult } from './message/builder.js';

// ============================================================================
// Mock 依赖：行情层 / 推送层 / 配置 / 写入层
// 全部在模块边界 mock —— 绝不发起真实网络请求，也绝不写真实 DB 文件（只用 :memory:）
// ============================================================================

vi.mock('./gate/ticker.js', () => ({ getGateTicker: vi.fn() }));
vi.mock('./gate/klines.js', () => ({ getGateCandles: vi.fn(), getGateCandlesByInterval: vi.fn() }));
vi.mock('./gate/futures.js', () => ({ getGateDerivatives: vi.fn() }));
vi.mock('./notify/telegram.js', () => ({ sendToTG: vi.fn() }));
vi.mock('./notify/feishu.js', () => ({ sendToFeishu: vi.fn() }));
vi.mock('./config.js', () => ({ getConfig: vi.fn() }));

// fx 模块保留真实常量（FALLBACK_USDT_TO_CNY），只替换汇率拉取
vi.mock('./gate/fx.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gate/fx.js')>();
  return { ...actual, getUsdtToCnyRate: vi.fn() };
});

// buildMessage 包一层：把入参 CoinResult[] 挂到 globalThis，测试可断言 source / error 等内部字段
vi.mock('./message/builder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./message/builder.js')>();
  return {
    ...actual,
    buildMessage: (results: unknown, ctx?: unknown) => {
      (globalThis as Record<string, unknown>)['__capturedCoinResults'] = results;
      return actual.buildMessage(results as never, ctx as never);
    },
  };
});

// updateCoin 包一层（可注入异常），listEnabledCoins 保持真实（走内存 DB）
vi.mock('./models/coin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./models/coin.js')>();
  return { ...actual, updateCoin: vi.fn(actual.updateCoin) };
});

import { getGateTicker } from './gate/ticker.js';
import { getGateCandles, getGateCandlesByInterval } from './gate/klines.js';
import { getGateDerivatives } from './gate/futures.js';
import { getUsdtToCnyRate } from './gate/fx.js';
import { sendToTG } from './notify/telegram.js';
import { sendToFeishu } from './notify/feishu.js';
import { getConfig } from './config.js';
import { updateCoin } from './models/coin.js';
import { runTask, resendReport } from './task.js';

const actualCoinModule = await vi.importActual<typeof import('./models/coin.js')>('./models/coin.js');

const mockTicker = vi.mocked(getGateTicker);
const mockCandles = vi.mocked(getGateCandles);
const mockCandlesByInterval = vi.mocked(getGateCandlesByInterval);
const mockDerivatives = vi.mocked(getGateDerivatives);
const mockFx = vi.mocked(getUsdtToCnyRate);
const mockTG = vi.mocked(sendToTG);
const mockFeishu = vi.mocked(sendToFeishu);
const mockConfig = vi.mocked(getConfig);
const mockUpdateCoin = vi.mocked(updateCoin);

// ============================================================================
// 测试夹具
// ============================================================================

const fakeCfg = () => ({
  tg_bot_token: null as string | null,
  tg_chat_id: null as string | null,
  feishu_webhook_url: null as string | null,
  feishu_app_id: null as string | null,
  feishu_app_secret: null as string | null,
  feishu_encrypt_key: null as string | null,
  feishu_verification_token: null as string | null,
  feishu_default_receive_id: null as string | null,
  feishu_default_receive_id_type: 'chat_id' as const,
  timezone: 'Asia/Shanghai',
  schedule_rule: '0 */10 * * * *',
  ua: '__test_ua',
  doh_enabled: false,
  doh_server: '1.1.1.1',
  doh_bypass: [] as string[],
  request_timeout_ms: 1000,
  max_retries: 1,
  alert_cooldown_hours: 24,
});

/** 生成 n 根升序 K 线，最后一根收盘价 = endPrice */
function makeCandles(n: number, stepSec: number, endPrice: number, drift = 0.5): GateCandle[] {
  const out: GateCandle[] = [];
  const start = endPrice - (n - 1) * drift;
  for (let i = 0; i < n; i++) {
    const close = start + i * drift;
    out.push({
      ts: 1_700_000_000 + i * stepSec,
      close,
      high: close * 1.012,
      low: close * 0.988,
      volume: 1000 + i * 3,
    });
  }
  return out;
}

/** 合约情绪夹具（结构对齐 GateDerivatives） */
function makeDerivatives(): GateDerivatives {
  const daily = Array.from({ length: 7 }, (_, i) => ({
    ts: 1_700_000_000 + i * 86400,
    lsrAccount: 1.2,
    topLsrAccount: 1.1,
    takerRatio: 1.02,
    longUsers: 300,
    shortUsers: 100,
    openInterestUsd: 1_000_000 + i * 1000,
    fundingRate: 0.0001,
    longLiquidationUsd: 1000,
    shortLiquidationUsd: 500,
  }));
  return {
    fundingRate: 0.0001,
    fundingRateAvg: 0.0001,
    openInterestUsd: 1_006_000,
    openInterestChangePct: 1.2,
    longLiquidationUsd: 7000,
    shortLiquidationUsd: 3500,
    days: 7,
    daily,
  };
}

const SCHEMA = `
CREATE TABLE coins (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol         TEXT    UNIQUE NOT NULL,
  name           TEXT    NOT NULL,
  gate_pair      TEXT,
  gate_slug      TEXT,
  binance_pair   TEXT,
  cg_id          TEXT    NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  alert_above    REAL,
  alert_below    REAL,
  last_price     REAL,
  last_alert_at  INTEGER NOT NULL DEFAULT 0,
  last_alert_dir TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE TABLE reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  triggered_by  TEXT    NOT NULL,
  success       INTEGER NOT NULL,
  total_coins   INTEGER NOT NULL,
  ok_coins      INTEGER NOT NULL,
  tg_sent       INTEGER NOT NULL,
  feishu_sent   INTEGER NOT NULL,
  message       TEXT    NOT NULL,
  summary       TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);
`;

let db: Database.Database;
let coinSeq = 0;

/** 每个交易对的 ticker 返回值 */
let tickerMap: Record<string, { last: string; change_percentage?: string }> = {};
/** 这些交易对的 ticker 直接抛错（模拟行情接口故障） */
let failingTickerPairs = new Set<string>();
/** 这些周期拉取直接抛错（模拟 K 线接口故障） */
let failingIntervals = new Set<string>();
/** 各周期返回的 K 线 */
let intervalCandles: Record<string, GateCandle[]> = {};
/** 合约统计返回值（null = 没有永续合约） */
let derivativesResult: GateDerivatives | null = makeDerivatives();

function insertCoin(c: {
  symbol: string;
  name?: string;
  gate_pair?: string | null;
  alert_above?: number | null;
  alert_below?: number | null;
  last_price?: number | null;
  last_alert_at?: number;
  last_alert_dir?: 'above' | 'below' | null;
  enabled?: number;
  sort_order?: number;
}): number {
  coinSeq += 1;
  const info = db
    .prepare(
      `INSERT INTO coins (symbol, name, gate_pair, gate_slug, binance_pair, cg_id, sort_order, enabled,
         alert_above, alert_below, last_price, last_alert_at, last_alert_dir, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      c.symbol,
      c.name ?? c.symbol,
      c.gate_pair ?? null,
      c.symbol.toLowerCase(),
      null,
      c.symbol.toLowerCase(),
      c.sort_order ?? coinSeq,
      c.enabled ?? 1,
      c.alert_above ?? null,
      c.alert_below ?? null,
      c.last_price ?? null,
      c.last_alert_at ?? 0,
      c.last_alert_dir ?? null,
      1_700_000_000,
      1_700_000_000,
    );
  return Number(info.lastInsertRowid);
}

/** 读取最后一次写入的 report 行 */
function lastReportRow() {
  return db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 1').get() as Record<string, unknown> | undefined;
}

/** 读取最后一次 buildMessage 的入参 */
function capturedResults(): CoinResult[] {
  return (globalThis as Record<string, unknown>)['__capturedCoinResults'] as CoinResult[];
}

const originalGithubActions = process.env['GITHUB_ACTIONS'];

beforeEach(() => {
  vi.clearAllMocks();

  db = new Database(':memory:');
  db.exec(SCHEMA);
  setDb(db);
  coinSeq = 0;

  delete process.env['GITHUB_ACTIONS'];

  // ---- 默认行情夹具 ----
  tickerMap = {};
  failingTickerPairs = new Set();
  failingIntervals = new Set();
  intervalCandles = {
    '7d': makeCandles(120, 7 * 86400, 295, 0.8),
    '30d': makeCandles(60, 30 * 86400, 290, 1.5),
    '4h': makeCandles(120, 4 * 3600, 298, 0.2),
    '1h': makeCandles(168, 3600, 299, 0.05),
  };
  derivativesResult = makeDerivatives();

  // ---- 默认 mock 实现 ----
  mockConfig.mockReturnValue(fakeCfg());

  mockTicker.mockImplementation(async (pair: string) => {
    if (failingTickerPairs.has(pair)) throw new Error(`ticker boom: ${pair}`);
    const t = tickerMap[pair] ?? { last: '299.50' };
    return {
      currency_pair: pair,
      last: t.last,
      change_percentage: t.change_percentage ?? '2.50',
    };
  });

  mockCandles.mockImplementation(async () => makeCandles(400, 86400, 299.5));

  mockCandlesByInterval.mockImplementation(async (_pair: string, interval: string) => {
    if (failingIntervals.has(interval)) throw new Error(`klines boom: ${interval}`);
    return intervalCandles[interval] ?? [];
  });

  mockDerivatives.mockImplementation(async () => derivativesResult);

  mockFx.mockResolvedValue({ rate: 7.2, source: 'live', origin: 'coingecko' });

  mockTG.mockResolvedValue({ ok: true });
  mockFeishu.mockResolvedValue({ ok: true });

  mockUpdateCoin.mockImplementation(actualCoinModule.updateCoin);
});

afterEach(() => {
  closeDb();
  if (originalGithubActions === undefined) delete process.env['GITHUB_ACTIONS'];
  else process.env['GITHUB_ACTIONS'] = originalGithubActions;
});

// ============================================================================
// runTask —— 正常流程
// ============================================================================

describe('runTask 正常流程', () => {
  it('单个币种：拉行情 + K线 + 合约 → 生成消息 → 推送 → 写 report', async () => {
    insertCoin({ symbol: '__test_BTC', name: '比特币', gate_pair: '__test_BTC_USDT' });
    tickerMap['__test_BTC_USDT'] = { last: '299.50', change_percentage: '2.50' };

    const result = await runTask('cron');

    // 行情层调用参数正确
    expect(mockTicker).toHaveBeenCalledWith('__test_BTC_USDT');
    expect(mockCandles).toHaveBeenCalledWith('__test_BTC_USDT', 365);
    expect(mockCandlesByInterval).toHaveBeenCalledWith('__test_BTC_USDT', '7d', 120);
    expect(mockCandlesByInterval).toHaveBeenCalledWith('__test_BTC_USDT', '30d', 60);
    expect(mockCandlesByInterval).toHaveBeenCalledWith('__test_BTC_USDT', '4h', 120);
    expect(mockCandlesByInterval).toHaveBeenCalledWith('__test_BTC_USDT', '1h', 168);
    expect(mockDerivatives).toHaveBeenCalledWith('__test_BTC_USDT', 7);

    // 消息里带上了研判与结论
    expect(result.message).toContain('比特币');
    expect(result.message).toContain('📌 结论');
    expect(result.message).toContain('📊 合约');

    // 两个推送通道都收到同一份消息
    expect(mockTG).toHaveBeenCalledWith(result.message);
    expect(mockFeishu).toHaveBeenCalledWith(result.message);

    // report 已落库
    const row = lastReportRow()!;
    expect(row['success']).toBe(1);
    expect(row['total_coins']).toBe(1);
    expect(row['ok_coins']).toBe(1);
    expect(row['tg_sent']).toBe(1);
    expect(row['feishu_sent']).toBe(1);
    expect(row['triggered_by']).toBe('cron');
    expect(row['message']).toBe(result.message);

    // 返回值
    expect(result.success).toBe(true);
    expect(result.totalCoins).toBe(1);
    expect(result.okCoins).toBe(1);
    expect(result.tgSent).toBe(true);
    expect(result.feishuSent).toBe(true);
    expect(result.triggered_by).toBe('cron');
    expect(result.reportId).toBe(Number(row['id']));
  });

  it('默认触发方式是 manual（不传参）', async () => {
    insertCoin({ symbol: '__test_BTC', gate_pair: '__test_BTC_USDT' });
    const result = await runTask();
    expect(result.triggered_by).toBe('manual');
    expect(lastReportRow()!['triggered_by']).toBe('manual');
  });

  it('GITHUB_ACTIONS=true → 报告标题标记为 ci', async () => {
    process.env['GITHUB_ACTIONS'] = 'true';
    insertCoin({ symbol: '__test_BTC', gate_pair: '__test_BTC_USDT' });

    const result = await runTask('manual');
    expect(result.message).toContain('from ci');
  });

  it('没有启用任何币种 → okCoins=0，success=false', async () => {
    insertCoin({ symbol: '__test_BTC', gate_pair: '__test_BTC_USDT', enabled: 0 });

    const result = await runTask('manual');
    expect(result.totalCoins).toBe(0);
    expect(result.okCoins).toBe(0);
    expect(result.success).toBe(false);
    expect(lastReportRow()!['success']).toBe(0);
  });
});

// ============================================================================
// runTask —— 多币种容错
// ============================================================================

describe('runTask 多币种容错', () => {
  it('某个币种 ticker 失败不中断其他币种，okCoins>0 仍算成功', async () => {
    insertCoin({ symbol: '__test_BTC', name: '比特币', gate_pair: '__test_BTC_USDT', sort_order: 1 });
    insertCoin({ symbol: '__test_ETH', name: '以太坊', gate_pair: '__test_ETH_USDT', sort_order: 2 });
    failingTickerPairs.add('__test_ETH_USDT');

    const result = await runTask('manual');

    expect(result.okCoins).toBe(1);
    expect(result.totalCoins).toBe(2);
    expect(result.success).toBe(true);
    expect(result.message).toContain('比特币');
    expect(result.message).toContain('⚠️ 数据获取失败');

    // 失败币种的 error 写进了 summary
    const summary = JSON.parse(lastReportRow()!['summary'] as string);
    const eth = summary.coins.find((c: { symbol: string }) => c.symbol === '__test_ETH');
    expect(eth.ok).toBe(false);
    expect(eth.error).toBe('ticker boom: __test_ETH_USDT');
  });

  it('全部币种都失败 → okCoins=0，success=false，但仍生成 report', async () => {
    insertCoin({ symbol: '__test_ETH', gate_pair: '__test_ETH_USDT' });
    failingTickerPairs.add('__test_ETH_USDT');

    const result = await runTask('manual');

    expect(result.okCoins).toBe(0);
    expect(result.success).toBe(false);
    const row = lastReportRow()!;
    expect(row['success']).toBe(0);
    expect(row['ok_coins']).toBe(0);
    expect(row['total_coins']).toBe(1);
  });

  it('完全失败：ticker 抛错 → source=failed 且带 error 字段', async () => {
    insertCoin({ symbol: '__test_ETH', gate_pair: '__test_ETH_USDT' });
    failingTickerPairs.add('__test_ETH_USDT');

    await runTask('manual');

    const results = capturedResults();
    expect(results).toHaveLength(1);
    expect(results[0]!.source).toBe('failed');
    expect(results[0]!.ticker).toBeNull();
    expect(results[0]!.indicators).toBeNull();
    expect(results[0]!.analysis).toBeNull();
    expect(results[0]!.intraday).toBeNull();
    expect(results[0]!.error).toBe('ticker boom: __test_ETH_USDT');
  });
});

// ============================================================================
// runTask —— 推送降级
// ============================================================================

describe('runTask 推送降级', () => {
  it('TG 失败不影响飞书推送', async () => {
    insertCoin({ symbol: '__test_BTC', gate_pair: '__test_BTC_USDT' });
    mockTG.mockRejectedValue(new Error('tg network down'));

    const result = await runTask('manual');

    expect(result.tgSent).toBe(false);
    expect(result.feishuSent).toBe(true);
    expect(mockFeishu).toHaveBeenCalledTimes(1);
    const row = lastReportRow()!;
    expect(row['tg_sent']).toBe(0);
    expect(row['feishu_sent']).toBe(1);
  });

  it('飞书失败不影响 TG 推送', async () => {
    insertCoin({ symbol: '__test_BTC', gate_pair: '__test_BTC_USDT' });
    mockFeishu.mockRejectedValue(new Error('feishu network down'));

    const result = await runTask('manual');

    expect(result.tgSent).toBe(true);
    expect(result.feishuSent).toBe(false);
    expect(mockTG).toHaveBeenCalledTimes(1);
  });

  it('推送返回 ok=false（无 error 字段）→ 记为 unknown 错误', async () => {
    insertCoin({ symbol: '__test_BTC', gate_pair: '__test_BTC_USDT' });
    mockTG.mockResolvedValue({ ok: false });
    mockFeishu.mockResolvedValue({ ok: false });

    const result = await runTask('manual');

    expect(result.tgSent).toBe(false);
    expect(result.feishuSent).toBe(false);
    const row = lastReportRow()!;
    expect(row['tg_sent']).toBe(0);
    expect(row['feishu_sent']).toBe(0);
  });

  it('两个推送都失败仍生成 report（币种成功时 success 仍为 true）', async () => {
    insertCoin({ symbol: '__test_BTC', gate_pair: '__test_BTC_USDT' });
    mockTG.mockRejectedValue(new Error('tg down'));
    mockFeishu.mockRejectedValue(new Error('feishu down'));

    const result = await runTask('manual');

    // report 依然落库
    const row = lastReportRow()!;
    expect(row['id']).toBeDefined();
    expect(row['tg_sent']).toBe(0);
    expect(row['feishu_sent']).toBe(0);
    // 注意：success 反映的是「币种抓取是否成功」，与推送成败无关
    expect(result.success).toBe(true);
    expect(result.okCoins).toBe(1);
  });

  it('币种也失败 + 两个推送都失败 → report 的 success=false', async () => {
    insertCoin({ symbol: '__test_ETH', gate_pair: '__test_ETH_USDT' });
    failingTickerPairs.add('__test_ETH_USDT');
    mockTG.mockRejectedValue(new Error('tg down'));
    mockFeishu.mockRejectedValue(new Error('feishu down'));

    const result = await runTask('manual');

    expect(result.success).toBe(false);
    expect(lastReportRow()!['success']).toBe(0);
  });
});

// ============================================================================
// runTask —— K 线周期降级 / 合约缺失
// ============================================================================

describe('runTask 数据降级', () => {
  it('周/月/4h/1h 全部拉取失败 → 只降级这些周期，价格侧报告照常产出', async () => {
    insertCoin({ symbol: '__test_BTC', gate_pair: '__test_BTC_USDT' });
    failingIntervals.add('7d');
    failingIntervals.add('30d');
    failingIntervals.add('4h');
    failingIntervals.add('1h');

    const result = await runTask('manual');

    expect(result.success).toBe(true);
    expect(result.okCoins).toBe(1);
    // 价格侧（趋势 + 结论）仍然有
    expect(result.message).toContain('📌 结论');
    expect(result.message).toContain('📈 趋势');
    // 周/月线研判显示「数据不足」，日内段缺失
    expect(result.message).toContain('周线：数据不足');
    expect(result.message).toContain('月线：数据不足');
    expect(result.message).not.toContain('⚡ 日内');
  });

  it('单个周期（周线）失败 → 只影响周线，其余周期正常', async () => {
    insertCoin({ symbol: '__test_BTC', gate_pair: '__test_BTC_USDT' });
    failingIntervals.add('7d');

    const result = await runTask('manual');

    expect(result.message).toContain('周线：数据不足');
    expect(result.message).toContain('月线：');
    expect(result.message).toContain('⚡ 日内');
  });

  it('没有永续合约（getGateDerivatives 返回 null）→ 只出结论不出情绪', async () => {
    insertCoin({ symbol: '__test_BTC', gate_pair: '__test_BTC_USDT' });
    derivativesResult = null;

    const result = await runTask('manual');

    expect(result.message).toContain('📌 结论');
    expect(result.message).not.toContain('📊 合约');
    // 合约数据缺失不影响价格侧
    expect(result.message).toContain('📈 趋势');
  });

  it('合约统计接口抛错 → 降级为 null，不影响价格侧报告', async () => {
    insertCoin({ symbol: '__test_BTC', gate_pair: '__test_BTC_USDT' });
    mockDerivatives.mockRejectedValue(new Error('contract stats boom'));

    const result = await runTask('manual');

    expect(result.success).toBe(true);
    expect(result.message).toContain('📌 结论');
    expect(result.message).not.toContain('📊 合约');
  });
});

// ============================================================================
// runTask —— 稳定币
// ============================================================================

describe('runTask 稳定币', () => {
  it('gate_pair 为空 → source=stable，ticker 固定用 1.0，不请求行情接口', async () => {
    insertCoin({ symbol: '__test_USDT', name: '泰达币', gate_pair: null });

    const result = await runTask('manual');

    expect(mockTicker).not.toHaveBeenCalled();
    expect(mockCandles).not.toHaveBeenCalled();
    expect(mockDerivatives).not.toHaveBeenCalled();

    const results = capturedResults();
    expect(results[0]!.source).toBe('stable');
    expect(results[0]!.ticker).toEqual({ last: '1.0' });
    expect(results[0]!.indicators).toBeNull();
    expect(results[0]!.analysis).toBeNull();
    expect(results[0]!.intraday).toBeNull();

    // 消息里价格是 1.00
    expect(result.message).toContain('$1.00');
    expect(result.okCoins).toBe(1);
  });
});

// ============================================================================
// runTask —— 价格预警（runPriceAlerts）
// ============================================================================

describe('runTask 价格预警', () => {
  it('首次运行（last_price 为 null）→ 只记录 last_price，不发预警', async () => {
    insertCoin({ symbol: '__test_BTC', gate_pair: '__test_BTC_USDT', alert_above: 200 });

    await runTask('manual');

    // 只有主报告那一次飞书调用，没有预警消息
    expect(mockFeishu).toHaveBeenCalledTimes(1);
    const row = db.prepare('SELECT last_price FROM coins WHERE symbol = ?').get('__test_BTC') as { last_price: number };
    expect(row.last_price).toBe(299.5);
  });

  it('上穿阈值 → 飞书收到预警消息，并记录 last_alert_at / last_alert_dir', async () => {
    insertCoin({ symbol: '__test_AAA', gate_pair: '__test_AAA_USDT', last_price: 100, alert_above: 110 });
    tickerMap['__test_AAA_USDT'] = { last: '120.00' };

    await runTask('manual');

    expect(mockFeishu).toHaveBeenCalledTimes(2);
    const alertMsg = mockFeishu.mock.calls[1]![0] as string;
    expect(alertMsg).toContain('🚨 价格预警');
    expect(alertMsg).toContain('突破上限');
    expect(alertMsg).toContain('__test_AAA');

    const row = db.prepare('SELECT * FROM coins WHERE symbol = ?').get('__test_AAA') as Record<string, unknown>;
    expect(row['last_price']).toBe(120);
    expect(row['last_alert_at']).toBeGreaterThan(0);
    expect(row['last_alert_dir']).toBe('above');
  });

  it('下穿阈值 → 飞书收到「跌破下限」预警', async () => {
    insertCoin({ symbol: '__test_BBB', gate_pair: '__test_BBB_USDT', last_price: 100, alert_below: 90 });
    tickerMap['__test_BBB_USDT'] = { last: '85.00' };

    await runTask('manual');

    expect(mockFeishu).toHaveBeenCalledTimes(2);
    const alertMsg = mockFeishu.mock.calls[1]![0] as string;
    expect(alertMsg).toContain('跌破下限');
    const row = db.prepare('SELECT * FROM coins WHERE symbol = ?').get('__test_BBB') as Record<string, unknown>;
    expect(row['last_alert_dir']).toBe('below');
  });

  it('上穿但当前价未达阈值 → 不发预警，只更新 last_price', async () => {
    insertCoin({ symbol: '__test_CCC', gate_pair: '__test_CCC_USDT', last_price: 100, alert_above: 110 });
    tickerMap['__test_CCC_USDT'] = { last: '105.00' };

    await runTask('manual');

    expect(mockFeishu).toHaveBeenCalledTimes(1);
    const row = db.prepare('SELECT last_price FROM coins WHERE symbol = ?').get('__test_CCC') as { last_price: number };
    expect(row.last_price).toBe(105);
  });

  it('上次价已高于阈值 → 不构成上穿，不发预警', async () => {
    insertCoin({ symbol: '__test_DDD', gate_pair: '__test_DDD_USDT', last_price: 200, alert_above: 110 });
    tickerMap['__test_DDD_USDT'] = { last: '120.00' };

    await runTask('manual');

    expect(mockFeishu).toHaveBeenCalledTimes(1);
  });

  it('上次价已低于阈值 → 不构成下穿，不发预警', async () => {
    insertCoin({ symbol: '__test_EEE', gate_pair: '__test_EEE_USDT', last_price: 80, alert_below: 90 });
    tickerMap['__test_EEE_USDT'] = { last: '85.00' };

    await runTask('manual');

    expect(mockFeishu).toHaveBeenCalledTimes(1);
  });

  it('下穿但当前价未达阈值 → 不发预警', async () => {
    insertCoin({ symbol: '__test_FFF', gate_pair: '__test_FFF_USDT', last_price: 100, alert_below: 90 });
    tickerMap['__test_FFF_USDT'] = { last: '95.00' };

    await runTask('manual');

    expect(mockFeishu).toHaveBeenCalledTimes(1);
  });

  it('冷却期内同一方向重复穿越 → 不再发预警', async () => {
    insertCoin({
      symbol: '__test_GGG',
      gate_pair: '__test_GGG_USDT',
      last_price: 100,
      alert_above: 110,
      last_alert_at: Date.now() - 1000,
      last_alert_dir: 'above',
    });
    tickerMap['__test_GGG_USDT'] = { last: '120.00' };

    await runTask('manual');

    expect(mockFeishu).toHaveBeenCalledTimes(1);
    const row = db.prepare('SELECT * FROM coins WHERE symbol = ?').get('__test_GGG') as Record<string, unknown>;
    // 冷却期内不刷新 last_alert_at
    expect(row['last_alert_at']).toBeLessThan(Date.now() - 500);
    expect(row['last_price']).toBe(120);
  });

  it('冷却期已过 → 再次发预警', async () => {
    insertCoin({
      symbol: '__test_HHH',
      gate_pair: '__test_HHH_USDT',
      last_price: 100,
      alert_above: 110,
      last_alert_at: Date.now() - 25 * 3600 * 1000,
      last_alert_dir: 'above',
    });
    tickerMap['__test_HHH_USDT'] = { last: '120.00' };

    await runTask('manual');

    expect(mockFeishu).toHaveBeenCalledTimes(2);
    expect(mockFeishu.mock.calls[1]![0] as string).toContain('🚨 价格预警');
  });

  it('上次预警方向不同 → 不在冷却期，正常发预警', async () => {
    insertCoin({
      symbol: '__test_III',
      gate_pair: '__test_III_USDT',
      last_price: 100,
      alert_above: 110,
      last_alert_at: Date.now() - 1000,
      last_alert_dir: 'below',
    });
    tickerMap['__test_III_USDT'] = { last: '120.00' };

    await runTask('manual');

    expect(mockFeishu).toHaveBeenCalledTimes(2);
    expect(mockFeishu.mock.calls[1]![0] as string).toContain('突破上限');
  });

  it('ticker 返回非数字 → 跳过该币的预警更新', async () => {
    insertCoin({ symbol: '__test_JJJ', gate_pair: '__test_JJJ_USDT', last_price: 100, alert_above: 110 });
    tickerMap['__test_JJJ_USDT'] = { last: 'not-a-number' };

    await runTask('manual');

    // last_price 不被更新（非数字价格不会污染看门）
    const row = db.prepare('SELECT last_price FROM coins WHERE symbol = ?').get('__test_JJJ') as { last_price: number };
    expect(row.last_price).toBe(100);
    expect(mockFeishu).toHaveBeenCalledTimes(1);
  });

  it('预警发送失败（返回 ok=false）→ 不影响主流程与 report', async () => {
    insertCoin({ symbol: '__test_KKK', gate_pair: '__test_KKK_USDT', last_price: 100, alert_above: 110 });
    tickerMap['__test_KKK_USDT'] = { last: '120.00' };
    mockFeishu.mockImplementation(async (msg: string) =>
      msg.startsWith('🚨 价格预警') ? { ok: false } : { ok: true },
    );

    const result = await runTask('manual');

    expect(result.success).toBe(true);
    expect(lastReportRow()).toBeDefined();
  });

  it('预警发送抛错 → 被吞掉，不影响主流程与 report', async () => {
    insertCoin({ symbol: '__test_LLL', gate_pair: '__test_LLL_USDT', last_price: 100, alert_above: 110 });
    tickerMap['__test_LLL_USDT'] = { last: '120.00' };
    mockFeishu.mockImplementation(async (msg: string) => {
      if (msg.startsWith('🚨 价格预警')) throw new Error('alert feishu boom');
      return { ok: true };
    });

    const result = await runTask('manual');

    expect(result.success).toBe(true);
    expect(lastReportRow()).toBeDefined();
  });

  it('预警管道整体抛错（DB 写入失败）→ 被捕获，report 仍然生成', async () => {
    insertCoin({ symbol: '__test_MMM', gate_pair: '__test_MMM_USDT', last_price: 100, alert_above: 110 });
    tickerMap['__test_MMM_USDT'] = { last: '120.00' };
    mockUpdateCoin.mockImplementation(() => {
      throw new Error('db is locked');
    });

    const result = await runTask('manual');

    expect(result.success).toBe(true);
    expect(lastReportRow()).toBeDefined();
    expect(result.reportId).toBeGreaterThan(0);
  });
});

// ============================================================================
// resendReport
// ============================================================================

describe('resendReport', () => {
  it('只重发 TG 通道', async () => {
    const out = await resendReport('hello', ['tg']);
    expect(out).toEqual({ tg: true, feishu: false });
    expect(mockTG).toHaveBeenCalledWith('hello');
    expect(mockFeishu).not.toHaveBeenCalled();
  });

  it('只重发飞书通道', async () => {
    const out = await resendReport('hello', ['feishu']);
    expect(out).toEqual({ tg: false, feishu: true });
    expect(mockFeishu).toHaveBeenCalledWith('hello');
    expect(mockTG).not.toHaveBeenCalled();
  });

  it('两个通道都重发', async () => {
    const out = await resendReport('hello', ['tg', 'feishu']);
    expect(out).toEqual({ tg: true, feishu: true });
    expect(mockTG).toHaveBeenCalledWith('hello');
    expect(mockFeishu).toHaveBeenCalledWith('hello');
  });

  it('空通道列表 → 两个都不发', async () => {
    const out = await resendReport('hello', []);
    expect(out).toEqual({ tg: false, feishu: false });
    expect(mockTG).not.toHaveBeenCalled();
    expect(mockFeishu).not.toHaveBeenCalled();
  });

  it('TG 返回失败 → tg=false', async () => {
    mockTG.mockResolvedValue({ ok: false });
    const out = await resendReport('hello', ['tg']);
    expect(out).toEqual({ tg: false, feishu: false });
  });

  it('飞书返回失败 → feishu=false', async () => {
    mockFeishu.mockResolvedValue({ ok: false });
    const out = await resendReport('hello', ['feishu']);
    expect(out).toEqual({ tg: false, feishu: false });
  });
});
