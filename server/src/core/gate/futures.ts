import { httpGet, HttpError } from '../../util/http.js';
import { getConfig } from '../config.js';

/** Gate 永续合约的日频统计（contract_stats）。 */
interface GateContractStat {
  time: number;
  /** 账户多空比（全市场账户数） */
  lsr_account?: number;
  /** 主动成交买卖比 */
  lsr_taker?: number;
  /** 大户账户多空比 */
  top_lsr_account?: number;
  /** 持多账户数 */
  long_users?: number;
  /** 持空账户数 */
  short_users?: number;
  /** 持仓量（币数 / USD 名义） */
  open_interest?: number;
  open_interest_usd?: number;
  /** 本周期多/空头爆仓额（USD） */
  long_liq_usd?: number;
  short_liq_usd?: number;
  /** 本周期最后一次资金费率 */
  last_funding_rate?: string;
  mark_price?: number;
}

/** 单个交易日的合约情绪明细（contract_stats 的一行）。 */
export interface GateDerivativesDay {
  /** 该日 00:00 UTC 的时间戳 */
  ts: number;
  /** 全市场账户多空比 */
  lsrAccount: number | null;
  /** 大户账户多空比 */
  topLsrAccount: number | null;
  /** 主动成交买卖比（>1 主动买盘占优） */
  takerRatio: number | null;
  /** 持多账户数 */
  longUsers: number | null;
  /** 持空账户数 */
  shortUsers: number | null;
  /** 持仓量（USD 名义） */
  openInterestUsd: number | null;
  /** 该日最后一次资金费率 */
  fundingRate: number | null;
  /** 该日多头爆仓额（USD） */
  longLiquidationUsd: number;
  /** 该日空头爆仓额（USD） */
  shortLiquidationUsd: number;
}

/** 从合约市场聚合出来的情绪指标（用于趋势研判）。 */
export interface GateDerivatives {
  /** 最新资金费率（每 8 小时一次） */
  fundingRate: number | null;
  /** 区间平均资金费率 */
  fundingRateAvg: number | null;
  /** 最新持仓量（USD 名义） */
  openInterestUsd: number | null;
  /** 区间内持仓量变化百分比 */
  openInterestChangePct: number | null;
  /** 区间内多头爆仓总额（USD） */
  longLiquidationUsd: number;
  /** 区间内空头爆仓总额（USD） */
  shortLiquidationUsd: number;
  /** 区间覆盖的完整交易日数（爆仓额/持仓变化的统计窗口） */
  days: number;
  /**
   * 日频明细（升序）。
   * 不含「当日进行中」的那一根 —— 当天的多空比/主动买卖比是半天的量，噪声大，
   * 拿去做均值和对比会失真；当日实时持仓/资金费率仍在上面的字段里。
   */
  daily: GateDerivativesDay[];
}

/**
 * 拉取 Gate 永续合约的日频统计并聚合成情绪指标。
 * 该接口只对存在永续合约的交易对存在（没有的返回 400）→ 调用方拿不到时降级即可。
 * @param days 需要的**完整交易日**数量（会多请求一天，用于剔除"今天"这根进行中的）
 */
export async function getGateDerivatives(contract: string, days = 7): Promise<GateDerivatives | null> {
  const cfg = getConfig();
  const url = `https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${encodeURIComponent(contract)}&interval=1d&limit=${days + 1}`;
  let res;
  try {
    res = await httpGet<GateContractStat[]>(url, {
      timeoutMs: cfg.request_timeout_ms,
      retries: cfg.max_retries,
      headers: { 'User-Agent': cfg.ua },
      doh: cfg.doh_enabled ? { endpoint: `https://${cfg.doh_server}/dns-query`, bypass: new Set(cfg.doh_bypass) } : null,
    });
  } catch (err) {
    // 该交易对没有永续合约时 Gate 返回 400 —— 属于"没有这个数据"而不是故障，直接降级。
    if (err instanceof HttpError && err.status === 400) return null;
    throw err;
  }
  if (!Array.isArray(res.data) || res.data.length === 0) return null;

  const rows = [...res.data].sort((a, b) => a.time - b.time);
  const num = (v: unknown): number | null => {
    // 注意：Number(null) === 0、Number('') === 0 —— 直接转换会把"字段缺失"变成"数值 0"，
    // 在多空比这种指标上会误报成极端读数，必须先挡掉空值。
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // Gate 的日频桶按 UTC 00:00 切；最后一行若是「今天」则是进行中的半天数据 → 剔除。
  // 注意单位：Date.now() 是毫秒，这里要换算成秒，和 r.time 对齐。
  const todayStart = Math.floor(Date.now() / 86_400_000) * 86400;
  const completeRows = rows.filter((r) => r.time < todayStart);
  // 全部行都是"今天"（新上架合约等）时，退化为"去掉最后一根"，
  // 仍然保证 daily[] 里不含进行中的那一根（否则会污染 7 日均值）。
  const dailyRows = completeRows.length > 0 ? completeRows : rows.slice(0, -1);

  // 资金费率取最新一次（含今天，今天的更实时）
  const fundingRates = rows.map((r) => num(r.last_funding_rate)).filter((v): v is number => v !== null);
  // 持仓 / 爆仓按完整交易日统计，窗口口径与 daily[] 一致
  const oiSeries = dailyRows.map((r) => num(r.open_interest_usd)).filter((v): v is number => v !== null);
  const longLiq = dailyRows.reduce((sum, r) => sum + (num(r.long_liq_usd) ?? 0), 0);
  const shortLiq = dailyRows.reduce((sum, r) => sum + (num(r.short_liq_usd) ?? 0), 0);

  const daily: GateDerivativesDay[] = dailyRows.slice(-days).map((r) => ({
    ts: r.time,
    lsrAccount: num(r.lsr_account),
    topLsrAccount: num(r.top_lsr_account),
    takerRatio: num(r.lsr_taker),
    longUsers: num(r.long_users),
    shortUsers: num(r.short_users),
    openInterestUsd: num(r.open_interest_usd),
    fundingRate: num(r.last_funding_rate),
    longLiquidationUsd: num(r.long_liq_usd) ?? 0,
    shortLiquidationUsd: num(r.short_liq_usd) ?? 0,
  }));

  return {
    fundingRate: fundingRates.length ? fundingRates[fundingRates.length - 1]! : null,
    fundingRateAvg: fundingRates.length
      ? fundingRates.reduce((a, b) => a + b, 0) / fundingRates.length
      : null,
    openInterestUsd: oiSeries.length ? oiSeries[oiSeries.length - 1]! : null,
    openInterestChangePct: oiSeries.length >= 2 && oiSeries[0]! !== 0
      ? ((oiSeries[oiSeries.length - 1]! - oiSeries[0]!) / oiSeries[0]!) * 100
      : null,
    longLiquidationUsd: longLiq,
    shortLiquidationUsd: shortLiq,
    days,
    daily,
  };
}
