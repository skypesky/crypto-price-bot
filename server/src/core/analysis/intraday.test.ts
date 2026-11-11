import { describe, it, expect } from 'vitest';
import { analyzeIntraday, type IntradayInput } from './intraday.js';
import type { GateCandle } from '../gate/klines.js';

const STEP = 3600;

/** 横盘 K 线：收盘恒为 price，高低点固定 ±rangePct。 */
function flat(n: number, price: number, rangePct = 0.01): GateCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: 1_700_000_000 + i * STEP,
    close: price,
    high: price * (1 + rangePct),
    low: price * (1 - rangePct),
    volume: 100,
  }));
}

/** 箱体 K 线：所有完整 K 线都在 low ~ high 之间。 */
function range(n: number, low: number, high: number): GateCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: 1_700_000_000 + i * STEP,
    close: (low + high) / 2,
    high,
    low,
    volume: 100,
  }));
}

/** 单边上涨 K 线（close 从 start 起每根 +1）。 */
function uptrend(n: number, start = 100): GateCandle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = start + i;
    return {
      ts: 1_700_000_000 + i * STEP,
      close,
      high: close * 1.005,
      low: close * 0.995,
      volume: 100,
    };
  });
}

/** 由收盘价序列构造 K 线：默认高低点 ±0.5%，volume 可自定义。 */
function fromCloses(
  closes: number[],
  opts: {
    high?: (close: number, i: number) => number;
    low?: (close: number, i: number) => number;
    volume?: (i: number) => number;
  } = {},
): GateCandle[] {
  return closes.map((close, i) => ({
    ts: 1_700_000_000 + i * STEP,
    close,
    high: opts.high ? opts.high(close, i) : close * 1.005,
    low: opts.low ? opts.low(close, i) : close * 0.995,
    volume: opts.volume ? opts.volume(i) : 100,
  }));
}

/** 末尾补一根「进行中」的 K 线，使 slice(0,-1) 恰好还原原收盘序列。 */
function withInProgress(closes: number[]): number[] {
  return [...closes, closes[closes.length - 1]!];
}

/** 先跌后涨（V 形）收盘序列。 */
function vShape(n: number, up: number, down: number): number[] {
  const half = Math.floor(n / 2);
  const out: number[] = [];
  let p = 100;
  for (let i = 0; i < half; i++) {
    out.push(p);
    p *= down;
  }
  for (let i = 0; i < n - half; i++) {
    out.push(p);
    p *= up;
  }
  return out;
}

/** 先涨后跌（倒 V 形）收盘序列。 */
function invShape(n: number, up: number, down: number): number[] {
  const half = Math.floor(n / 2);
  const out: number[] = [];
  let p = 100;
  for (let i = 0; i < half; i++) {
    out.push(p);
    p *= up;
  }
  for (let i = 0; i < n - half; i++) {
    out.push(p);
    p *= down;
  }
  return out;
}

/** 涨势逐根衰减的收盘序列。 */
function decelShape(n: number, decel: number): number[] {
  const out: number[] = [];
  let p = 100;
  let r = 1.05;
  for (let i = 0; i < n; i++) {
    out.push(p);
    p *= r;
    r *= decel;
  }
  return out;
}

/** 等比收盘序列。 */
function ratioSeries(n: number, ratio: number, start = 100): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    out.push(p);
    p *= ratio;
  }
  return out;
}

/** 只用收盘序列构造 4h 输入（自动补进行中的 K 线，1h 为空）。 */
function input4h(closes: number[], opts: Parameters<typeof fromCloses>[1] = {}): IntradayInput {
  return {
    current: closes[closes.length - 1]!,
    candles4h: fromCloses(withInProgress(closes), opts),
    candles1h: [],
  };
}

/** 箱体 K 线：收盘在 low / high 之间交替，高低点固定。 */
function boxCandles(n: number, low: number, high: number): GateCandle[] {
  return fromCloses(
    Array.from({ length: n }, (_, i) => (i % 2 === 0 ? low : high)),
    { high: () => high, low: () => low },
  );
}

/** 4h 横盘（价格 105），1h 箱体 100~110。 */
function baseInput(current: number): IntradayInput {
  return {
    current,
    candles4h: flat(61, 105),
    candles1h: range(49, 100, 110),
  };
}

describe('analyzeIntraday', () => {
  it('4h / 1h 都没数据 → null', () => {
    expect(analyzeIntraday({ current: 100, candles4h: [], candles1h: [] })).toBeNull();
    expect(analyzeIntraday({ current: 0, candles4h: flat(61, 100), candles1h: range(49, 100, 110) })).toBeNull();
  });

  it('横盘：识别箱体震荡，价格在中部时建议观望', () => {
    const r = analyzeIntraday(baseInput(105))!;
    expect(r.headline).toContain('4h：震荡');
    expect(r.headline).toContain('箱体：');
    expect(r.headline).toContain('中部50%');
    expect(r.advice).toContain('箱体中部');
  });

  it('箱体上沿：不追多', () => {
    const r = analyzeIntraday(baseInput(108))!;
    expect(r.headline).toContain('上沿80%');
    expect(r.advice).toContain('箱体上沿');
  });

  it('箱体下沿：轻仓试多 + 跌破箱底止损', () => {
    const r = analyzeIntraday(baseInput(102))!;
    expect(r.headline).toContain('下沿20%');
    expect(r.advice).toContain('轻仓试多');
    expect(r.advice).toContain('跌破箱底止损');
  });

  it('突破箱体上沿：提示突破与假突破风险', () => {
    const r = analyzeIntraday(baseInput(112))!;
    expect(r.headline).toContain('已突破上沿');
    expect(r.advice).toContain('突破');
  });

  it('跌破箱体下沿：提示下探风险', () => {
    const r = analyzeIntraday(baseInput(98))!;
    expect(r.headline).toContain('已跌破下沿');
    expect(r.advice).toContain('跌破箱底');
  });

  it('4h 上涨：方向偏多，4h / 1h 指标各一行并给出布林上中下轨', () => {
    const r = analyzeIntraday({
      current: 160,
      candles4h: uptrend(61),
      candles1h: flat(49, 160),
    })!;
    expect(r.headline).toContain('偏多');

    // 4h：BOLL 上/中/下 + MACD + RSI + ATR 压缩在一行
    expect(r.h4).toContain('BOLL4h：上$');
    expect(r.h4).toContain('/中$');
    expect(r.h4).toContain('/下$');
    expect(r.h4).toContain('MACD');
    expect(r.h4).toContain('RSI');
    expect(r.h4).toContain('ATR');

    // 1h：BOLL 上/中/下 + %B + MACD/RSI 压缩在一行
    expect(r.h1).toContain('BOLL1h：上$');
    expect(r.h1).toContain('/中$');
    expect(r.h1).toContain('/下$');
    expect(r.h1).toContain('%B');

    expect(r.advice.length).toBeGreaterThan(0);
  });

  it('只有 4h：不输出箱体，仍返回 4h 方向', () => {
    const r = analyzeIntraday({ current: 160, candles4h: uptrend(61), candles1h: [] })!;
    expect(r.headline).not.toContain('箱体');
    expect(r.headline).toContain('偏多');
    expect(r.h1).toBeNull();
  });

  it('只有 1h：4h 显示数据不足，箱体照常输出', () => {
    const r = analyzeIntraday({ current: 105, candles4h: [], candles1h: range(49, 100, 110) })!;
    expect(r.headline).toContain('4h：数据不足');
    expect(r.headline).toContain('箱体：');
    expect(r.h4).toBeNull();
  });

  describe('价格展示精度', () => {
    it('价格低于 1 美元时保留 6 位小数', () => {
      const r = analyzeIntraday({
        current: 0.5,
        candles4h: flat(40, 0.5),
        candles1h: [],
      })!;
      expect(r.h4).toContain('$0.500000');
    });

    it('价格高于 1 美元时保留 2 位小数', () => {
      const r = analyzeIntraday({
        current: 105,
        candles4h: flat(40, 105),
        candles1h: [],
      })!;
      expect(r.h4).toContain('$105.00');
    });
  });

  describe('布林带宽收敛度', () => {
    it('完整 K 线不足 24 根时算不出百分位，不输出收敛标记', () => {
      const r = analyzeIntraday({
        current: 100,
        candles4h: flat(22, 100),
        candles1h: [],
      })!;
      expect(r.h4).toContain('带宽0.0%');
      expect(r.h4).not.toContain('收敛');
      expect(r.h4).not.toContain('正常');
      expect(r.h4).not.toContain('扩张');
    });

    it('带宽处于历史高位时标记「扩张」', () => {
      // 波动逐根放大，最后 20 根的带宽是整个回看窗口里最大的
      const closes = Array.from({ length: 30 }, (_, i) => 100 + 0.01 * i * i);
      const r = analyzeIntraday(input4h(closes))!;
      expect(r.h4).toContain('扩张');
    });

    it('带宽处于历史低位时标记「收敛」', () => {
      const closes = Array.from({ length: 30 }, (_, i) => 100 + 0.01 * (29 - i) * (29 - i));
      const r = analyzeIntraday(input4h(closes))!;
      expect(r.h4).toContain('收敛');
    });

    it('带宽处于历史中位时标记「正常」', () => {
      const r = analyzeIntraday(input4h(new Array(30).fill(100)))!;
      expect(r.h4).toContain('正常');
    });

    it('1h 带宽也能给出收敛度标记', () => {
      const closes = Array.from({ length: 30 }, (_, i) => 100 + 0.01 * i * i);
      const r = analyzeIntraday({
        current: closes[closes.length - 1]!,
        candles4h: flat(40, 100),
        candles1h: fromCloses(withInProgress(closes)),
      })!;
      expect(r.h1).toContain('扩张');
    });
  });

  describe('MACD 状态', () => {
    it('DIF 上穿 DEA 判定为「刚金叉」', () => {
      const r = analyzeIntraday(input4h(decelShape(36, 0.99)))!;
      expect(r.h4).toContain('MACD：刚金叉');
    });

    it('DIF 下穿 DEA 判定为「刚死叉」', () => {
      const r = analyzeIntraday(input4h(decelShape(41, 0.999)))!;
      expect(r.h4).toContain('MACD：刚死叉');
    });

    it('红柱放大判定为「多头动能增强」', () => {
      const r = analyzeIntraday(input4h(vShape(35, 1.1, 0.995)))!;
      expect(r.h4).toContain('MACD：多头动能增强');
    });

    it('红柱收缩判定为「多头动能减弱」', () => {
      const r = analyzeIntraday(input4h(decelShape(35, 0.999)))!;
      expect(r.h4).toContain('MACD：多头动能减弱');
    });

    it('红柱持平判定为「多头动能平缓」', () => {
      const r = analyzeIntraday(input4h(vShape(35, 1.002, 0.995)))!;
      expect(r.h4).toContain('MACD：多头动能平缓');
    });

    it('绿柱放大判定为「空头动能增强」', () => {
      const r = analyzeIntraday(input4h(decelShape(42, 0.999)))!;
      expect(r.h4).toContain('MACD：空头动能增强');
    });

    it('绿柱收缩判定为「空头动能减弱」', () => {
      const r = analyzeIntraday(input4h(invShape(35, 1.002, 0.97)))!;
      expect(r.h4).toContain('MACD：空头动能减弱');
    });

    it('绿柱持平判定为「空头动能平缓」', () => {
      const r = analyzeIntraday(input4h(invShape(35, 1.002, 0.995)))!;
      expect(r.h4).toContain('MACD：空头动能平缓');
    });

    it('柱体为 0 时判定为「动能中性」', () => {
      const r = analyzeIntraday(input4h(new Array(35).fill(100)))!;
      expect(r.h4).toContain('MACD：动能中性');
    });
  });

  describe('RSI 定性', () => {
    it('RSI 低于 30 判定为「超卖」', () => {
      const r = analyzeIntraday(input4h(invShape(30, 1.002, 0.995)))!;
      expect(r.h4).toContain('RSI：');
      expect(r.h4).toContain('(超卖)');
    });

    it('RSI 低于 45 判定为「偏弱」', () => {
      const r = analyzeIntraday(input4h(vShape(30, 1.002, 0.995)))!;
      expect(r.h4).toContain('(偏弱)');
    });

    it('RSI 在 45~55 之间判定为「中性」', () => {
      const r = analyzeIntraday(input4h(vShape(30, 1.005, 0.99)))!;
      expect(r.h4).toContain('(中性)');
    });

    it('RSI 高于 55 判定为「偏强」', () => {
      const r = analyzeIntraday(input4h(vShape(30, 1.005, 0.995)))!;
      expect(r.h4).toContain('(偏强)');
    });

    it('RSI 高于 70 判定为「超买」', () => {
      const r = analyzeIntraday(input4h(vShape(30, 1.01, 0.995)))!;
      expect(r.h4).toContain('(超买)');
    });
  });

  describe('1h 布林带位置（%B）', () => {
    const pctBCase = (current: number) =>
      analyzeIntraday({
        current,
        candles4h: flat(40, 100),
        candles1h: boxCandles(21, 90, 110),
      })!;

    it('%B 大于等于 100 判定为「突破上轨」', () => {
      expect(pctBCase(125).h1).toContain('突破上轨');
    });

    it('%B 在 80~100 之间判定为「上轨附近」', () => {
      expect(pctBCase(116).h1).toContain('上轨附近');
    });

    it('%B 在 55~80 之间判定为「中轨上方」', () => {
      expect(pctBCase(108).h1).toContain('中轨上方');
    });

    it('%B 在 45~55 之间判定为「中轨附近」', () => {
      expect(pctBCase(100).h1).toContain('中轨附近');
    });

    it('%B 在 20~45 之间判定为「中轨下方」', () => {
      expect(pctBCase(90).h1).toContain('中轨下方');
    });

    it('%B 在 0~20 之间判定为「下轨附近」', () => {
      expect(pctBCase(86).h1).toContain('下轨附近');
    });

    it('%B 小于等于 0 判定为「跌破下轨」', () => {
      expect(pctBCase(76).h1).toContain('跌破下轨');
    });
  });

  describe('ATR 波动水平', () => {
    it('4h 振幅极小时标记「低波动」', () => {
      const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.01);
      const r = analyzeIntraday({
        current: closes[closes.length - 1]!,
        candles4h: fromCloses(withInProgress(closes), {
          high: (c) => c * 1.001,
          low: (c) => c * 0.999,
        }),
        candles1h: [],
      })!;
      expect(r.h4).toContain('(低波动)');
    });

    it('4h 振幅适中时标记「波动中等」', () => {
      const r = analyzeIntraday({
        current: 100,
        candles4h: flat(40, 100),
        candles1h: [],
      })!;
      expect(r.h4).toContain('(波动中等)');
    });

    it('4h 振幅很大时标记「波动偏高」', () => {
      const closes = vShape(35, 1.1, 0.995);
      const r = analyzeIntraday(input4h(closes))!;
      expect(r.h4).toContain('(波动偏高)');
    });
  });

  describe('箱体识别', () => {
    it('1h 高低点全为无效值时识别不出箱体', () => {
      const r = analyzeIntraday({
        current: 100,
        candles4h: flat(40, 100),
        candles1h: fromCloses(new Array(11).fill(100), { high: () => 0, low: () => 0 }),
      })!;
      expect(r.headline).not.toContain('箱体');
    });

    it('1h 最高价不高于最低价时识别不出箱体', () => {
      const r = analyzeIntraday({
        current: 100,
        candles4h: flat(40, 100),
        candles1h: fromCloses(new Array(11).fill(100), { high: () => 100, low: () => 100 }),
      })!;
      expect(r.headline).not.toContain('箱体');
    });

    it('1h 存在收盘价为 0 的 K 线时仍能识别箱体（振幅按 0 计）', () => {
      const closes = [...new Array(4).fill(100), 0, ...new Array(6).fill(100)];
      const r = analyzeIntraday({
        current: 100,
        candles4h: flat(40, 100),
        candles1h: fromCloses(closes, { high: () => 110, low: () => 90 }),
      })!;
      expect(r.headline).toContain('箱体：');
      expect(r.headline).toContain('中部50%');
    });

    it('箱体上下沿判定：上沿', () => {
      const r = analyzeIntraday({
        current: 106,
        candles4h: flat(40, 100),
        candles1h: boxCandles(21, 90, 110),
      })!;
      expect(r.headline).toContain('上沿80%');
    });

    it('箱体上下沿判定：下沿', () => {
      const r = analyzeIntraday({
        current: 94,
        candles4h: flat(40, 100),
        candles1h: boxCandles(21, 90, 110),
      })!;
      expect(r.headline).toContain('下沿20%');
    });
  });

  describe('量能', () => {
    it('近 6 根量能明显放大时输出量能行', () => {
      const closes = new Array(30).fill(100);
      const r = analyzeIntraday({
        current: 100,
        candles4h: fromCloses(closes, { volume: (i) => (i >= closes.length - 7 ? 200 : 100) }),
        candles1h: [],
      })!;
      expect(r.h4).toContain('量能：+100%');
    });

    it('近 6 根量能明显萎缩时输出量能行', () => {
      const closes = new Array(30).fill(100);
      const r = analyzeIntraday({
        current: 100,
        candles4h: fromCloses(closes, { volume: (i) => (i >= closes.length - 7 ? 50 : 100) }),
        candles1h: [],
      })!;
      expect(r.h4).toContain('量能：-50%');
    });

    it('量能变化不明显时不输出量能行', () => {
      const r = analyzeIntraday({
        current: 100,
        candles4h: flat(30, 100),
        candles1h: [],
      })!;
      expect(r.h4).not.toContain('量能');
    });
  });

  describe('操作建议', () => {
    it('4h 偏多且无箱体时给出低吸建议', () => {
      const closes = ratioSeries(40, 1.01);
      const r = analyzeIntraday(input4h(closes))!;
      expect(r.headline).toContain('4h：偏多');
      expect(r.advice).toContain('4h偏多');
    });

    it('4h 偏空且无箱体时给出勿追多建议', () => {
      const closes = invShape(30, 1.002, 0.995);
      const r = analyzeIntraday(input4h(closes))!;
      expect(r.headline).toContain('4h：偏空');
      expect(r.advice).toContain('4h偏空');
    });

    it('4h 方向不明且无箱体时给出观望建议', () => {
      const closes = vShape(30, 1.002, 0.995);
      const r = analyzeIntraday(input4h(closes))!;
      expect(r.headline).toContain('4h：震荡');
      expect(r.advice).toContain('方向不明');
    });

    it('突破箱顶且量能与动能同步时提示可轻仓跟随', () => {
      const closes = vShape(35, 1.1, 0.995);
      const r = analyzeIntraday({
        current: 115,
        candles4h: fromCloses(withInProgress(closes), {
          volume: (i) => (i >= closes.length - 6 ? 101 : 100),
        }),
        candles1h: boxCandles(21, 90, 110),
      })!;
      expect(r.advice).toContain('突破箱顶且量能配合');
    });

    it('突破箱顶但量能不足时提示防假突破', () => {
      const r = analyzeIntraday({
        current: 115,
        candles4h: flat(40, 100),
        candles1h: boxCandles(21, 90, 110),
      })!;
      expect(r.advice).toContain('防假突破');
    });

    it('箱体上沿且 RSI 超买时提示不追多', () => {
      const closes = ratioSeries(30, 1.01);
      const r = analyzeIntraday({
        current: 106,
        candles4h: fromCloses(withInProgress(closes)),
        candles1h: boxCandles(21, 90, 110),
      })!;
      expect(r.advice).toContain('箱体上沿且RSI超买');
    });

    it('箱体上沿但 RSI 未超买时仍提示部分止盈', () => {
      const r = analyzeIntraday({
        current: 106,
        candles4h: flat(40, 100),
        candles1h: boxCandles(21, 90, 110),
      })!;
      expect(r.advice).toContain('箱体上沿不追多');
    });

    it('箱体下沿且 RSI 超卖时提示可轻仓试多', () => {
      const closes = ratioSeries(30, 0.99);
      const r = analyzeIntraday({
        current: 94,
        candles4h: fromCloses(withInProgress(closes)),
        candles1h: boxCandles(21, 90, 110),
      })!;
      expect(r.advice).toContain('箱体下沿且RSI超卖');
    });

    it('箱体下沿但 RSI 未超卖时仍提示轻仓试多', () => {
      const r = analyzeIntraday({
        current: 94,
        candles4h: flat(40, 100),
        candles1h: boxCandles(21, 90, 110),
      })!;
      expect(r.advice).toContain('箱体下沿可轻仓试多');
    });
  });
});
