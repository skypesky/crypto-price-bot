import type { GateDerivatives, GateDerivativesDay } from '../gate/futures.js';
import { pct } from './timeframe.js';

/** 资金费率年化（Gate 每 8 小时结算一次 → 每天 3 次 → 365 天）。 */
function annualizedFunding(rate: number): number {
  return rate * 3 * 365 * 100;
}

/** 资金费率显示：值很小时用更多小数位，避免出现 "-0.00%" 这种读不出大小的写法。 */
function formatFundingRate(rate: number): string {
  const p = rate * 100;
  return Math.abs(p) < 0.01 ? p.toFixed(4) : p.toFixed(3);
}

/** 一组数值的平均值（忽略 null）。 */
function avgOf(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** 多空比定性：>2 多头占优，<1 空头占优，其余均衡。 */
function lsrTag(r: number): string {
  if (r > 2) return '多头占优';
  if (r < 1) return '空头占优';
  return '多空均衡';
}

/** 大户多空比定性（阈值比账户多空比更严，因为大户样本少、波动大）。 */
function topLsrTag(r: number): string {
  if (r > 1.2) return '多头占优';
  if (r < 0.8) return '空头占优';
  return '多空均衡';
}

/** 主动成交买卖比定性：>1 主动买盘占优。 */
function takerTag(r: number): string {
  if (r > 1.05) return '买盘主导';
  if (r < 0.95) return '卖盘主导';
  return '基本均衡';
}

/** 爆仓额紧凑写法：百万 / 千。 */
function liqUsd(v: number): string {
  return v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`;
}

/** 资金费率一行：最新费率 + 年化与定性。 */
function fundingLine(d: GateDerivatives): string | null {
  if (d.fundingRate === null) return null;
  const ann = annualizedFunding(d.fundingRate);
  let tag = '中性';
  if (ann > 30) tag = '多头成本偏高';
  else if (ann < -3) tag = '空头成本为负(挤仓风险)';
  else if (ann > 10) tag = '多头付费意愿尚可';
  return `费率：${formatFundingRate(d.fundingRate)}%/8h(年化${ann.toFixed(1)}%,${tag})`;
}

/** 持仓变化一行：区间变化幅度与定性。 */
function openInterestLine(d: GateDerivatives): string | null {
  if (d.openInterestChangePct === null) return null;
  const v = d.openInterestChangePct;
  const tag = v > 5 ? '杠杆资金快速进场' : v < -5 ? '资金明显撤离' : '资金平稳';
  return `持仓：${pct(v)}(${tag})`;
}

/** 爆仓一行：多空哪一侧被清洗（或双方相当）。 */
function liquidationLine(d: GateDerivatives): string | null {
  if (d.longLiquidationUsd + d.shortLiquidationUsd <= 0) return null;
  if (d.longLiquidationUsd > d.shortLiquidationUsd * 1.2) {
    return `${d.days}日多头爆仓：${liqUsd(d.longLiquidationUsd)} 占优(多头被清洗)`;
  }
  if (d.shortLiquidationUsd > d.longLiquidationUsd * 1.2) {
    return `${d.days}日空头爆仓：${liqUsd(d.shortLiquidationUsd)} 占优(空头被清洗)`;
  }
  return `${d.days}日多空爆仓相当`;
}

/** 合约资金面描述（资金费率 / 持仓 / 爆仓）—— 多空比归到「日线情绪」行。 */
export function futuresLines(d: GateDerivatives): string[] {
  const lines: string[] = [];
  const funding = fundingLine(d);
  if (funding) lines.push(funding);
  const oi = openInterestLine(d);
  if (oi) lines.push(oi);
  const liq = liquidationLine(d);
  if (liq) lines.push(liq);
  return lines;
}

/**
 * 日线情绪解读：把多空比组合翻译成一句人话。
 * 关键是看「散户（账户多空比）」和「大户」是否背离，以及主动成交方向。
 */
function sentimentRead(last: GateDerivativesDay): string {
  const bits: string[] = [];
  const acct = last.lsrAccount;
  const top = last.topLsrAccount;
  const taker = last.takerRatio !== null && last.takerRatio > 0 ? last.takerRatio : null;

  if (acct !== null && top !== null) {
    if (acct >= 1.5 && top < 1) bits.push('散户偏多而大户偏空，筹码分歧');
    else if (acct >= 1.5 && top >= 1.5) bits.push('大小资金一致偏多，情绪乐观');
    else if (acct <= 1 && top <= 1) bits.push('大小资金一致偏空，趋势受压');
    else if (acct <= 1 && top >= 1.2) bits.push('大户逆势偏多，存在承接');
    else bits.push('多空分歧，方向未明');
  }

  if (taker !== null) {
    if (taker < 0.95) bits.push('主动卖盘主导，短线抛压明显');
    else if (taker > 1.05) bits.push('主动买盘主导，买盘承接积极');
    else bits.push('主动买卖基本均衡');
  }

  if (acct !== null && acct >= 2) bits.push('多头拥挤，破位易触发连环清算');

  return bits.join('，');
}

/** 多空比一行：最新值 + 定性 + 区间均值与箭头。 */
function lsrLine(last: GateDerivativesDay, avg: number | null, days: number): string | null {
  if (last.lsrAccount === null) return null;
  const arrow = avg === null ? '' : last.lsrAccount > avg * 1.03 ? '↑' : last.lsrAccount < avg * 0.97 ? '↓' : '→';
  return `多空：${last.lsrAccount.toFixed(2)}(${lsrTag(last.lsrAccount)}${avg !== null ? `，${days}日均 ${avg.toFixed(2)}${arrow}` : ''})`;
}

/** 大户多空比一行。 */
function topLsrLine(last: GateDerivativesDay): string | null {
  if (last.topLsrAccount === null) return null;
  return `大户：${last.topLsrAccount.toFixed(2)}(${topLsrTag(last.topLsrAccount)})`;
}

/** 主动成交买卖比一行。 */
function takerLine(last: GateDerivativesDay): string | null {
  // lsr_taker 为 0 表示当期几乎没有主动买盘成交（流动性极差），不是"卖盘主导" → 不展示
  if (last.takerRatio === null || last.takerRatio <= 0) return null;
  return `主动：${last.takerRatio.toFixed(2)}(${takerTag(last.takerRatio)})`;
}

/** 多空用户数比一行。 */
function usersLine(last: GateDerivativesDay): string | null {
  if (last.longUsers === null || last.shortUsers === null || last.shortUsers <= 0) return null;
  return `多空用户：${(last.longUsers / last.shortUsers).toFixed(2)}:1`;
}

/** 日线情绪：最近完整交易日的多空比全景 + 7 日均值 + 解读，每个指标独占一行。 */
export function sentimentLines(d: GateDerivatives): string[] {
  const days = d.daily;
  if (days.length === 0) return [];
  const last = days[days.length - 1]!;
  const lines: string[] = [];

  const lsr = lsrLine(last, avgOf(days.map((x) => x.lsrAccount)), days.length);
  if (lsr) lines.push(lsr);
  const top = topLsrLine(last);
  if (top) lines.push(top);
  const taker = takerLine(last);
  if (taker) lines.push(taker);
  const users = usersLine(last);
  if (users) lines.push(users);

  const read = sentimentRead(last);
  if (read) lines.push(`解读：${read}`);

  return lines;
}
