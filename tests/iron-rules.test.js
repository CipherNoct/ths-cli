// tests/iron-rules.test.js — 交易成本/整手/T+1/仓位/风险/环境系数（M7-3）
import { describe, it, expect } from 'vitest';
import {
  estimateFee, checkLot, checkT1, checkPositionCap, checkRiskPerTrade, envPositionFactor, dayOf,
} from '../lib/iron-rules.js';

describe('estimateFee（费用估算）', () => {
  it('买入只收佣金+过户费，佣金有 5 元保底', () => {
    const buy = estimateFee({ action: 'buy', qty: 100, price: 10 }); // 1000 元
    expect(buy.commission).toBe(5);
    expect(buy.stamp).toBe(0);
    expect(buy.total).toBeCloseTo(5.01, 2);
  });
  it('卖出加收印花税万5', () => {
    const sell = estimateFee({ action: 'sell', qty: 1000, price: 10 }); // 10000 元
    expect(sell.commission).toBe(5);
    expect(sell.stamp).toBeCloseTo(5, 2);
    expect(sell.total).toBeCloseTo(10.1, 2);
  });
  it('大额佣金按万2.5', () => {
    const f = estimateFee({ action: 'buy', qty: 10000, price: 10 }); // 10 万
    expect(f.commission).toBe(25);
    expect(f.transfer).toBeCloseTo(1, 2);
  });
  it('零/负参数不产生费用', () => {
    expect(estimateFee({ action: 'buy', qty: 0, price: 0 }).total).toBe(0);
    expect(estimateFee({ action: 'sell', qty: -100, price: 10 }).total).toBe(0);
  });
});

describe('checkLot（整手）', () => {
  it('主板非整手提示，整手通过', () => {
    expect(checkLot('600519', 150).ok).toBe(false);
    expect(checkLot('600519', 200).ok).toBe(true);
  });
  it('科创板最低 200 股', () => {
    expect(checkLot('688981', 100).ok).toBe(false);
    expect(checkLot('688981', 200).ok).toBe(true);
  });
  it('卖出允许零股', () => {
    expect(checkLot('600519', 37, 'sell').ok).toBe(true);
  });
});

describe('checkT1（当日买入不可卖）', () => {
  const pos = {
    qty: 300,
    trades: [
      { action: 'buy', date: '2026-11-26', qty: 200 },
      { action: 'buy', date: '2026-11-20', qty: 100 },
    ],
  };
  it('当日买入部分不可卖', () => {
    const r = checkT1(pos, 100, '2026-11-26');
    expect(r.ok).toBe(true);
    expect(r.sellable).toBe(100);
  });
  it('超过可卖数量被拦截', () => {
    const r = checkT1(pos, 200, '2026-11-26');
    expect(r.ok).toBe(false);
    expect(r.sellable).toBe(100);
  });
  it('次日全部可卖；trade 时间戳按日期截断比较', () => {
    const ts = { qty: 100, trades: [{ action: 'buy', date: '2026-11-26T10:01:00', qty: 100 }] };
    expect(checkT1(ts, 100, '2026-11-27').ok).toBe(true);
    expect(checkT1(ts, 100, '2026-11-26').ok).toBe(false);
  });
  it('无量持仓时空仓卖出被拦', () => {
    expect(checkT1({ qty: 0, trades: [] }, 100, '2026-11-26').ok).toBe(false);
  });
});

describe('checkPositionCap / checkRiskPerTrade', () => {
  it('单票超 20% 报警', () => {
    expect(checkPositionCap(25000, 100000).ok).toBe(false);
    expect(checkPositionCap(20000, 100000).ok).toBe(true);
  });
  it('没有资金数据时不误报', () => {
    expect(checkPositionCap(50000, 0).ok).toBe(true);
  });
  it('单笔风险超 2% 报警', () => {
    const r = checkRiskPerTrade({ entry: 10, stop: 8, qty: 2000, totalCapital: 100000 });
    expect(r.ok).toBe(false);
    expect(r.riskPct).toBe(4);
  });
  it('止损高于买入价视为无风险空间', () => {
    expect(checkRiskPerTrade({ entry: 10, stop: 11, qty: 100, totalCapital: 100000 }).ok).toBe(false);
  });
});

describe('envPositionFactor（大盘→仓位系数）', () => {
  const above = { aboveMA20: true };
  const below = { aboveMA20: false };
  it('普涨给进攻档', () => {
    const f = envPositionFactor({ mood: '🔥 普涨强势', indices: { '1A0001': above, '399006': above } });
    expect(f.factor).toBe(1);
    expect(f.singleStockPct).toBe(20);
  });
  it('普跌收缩到 0.5', () => {
    expect(envPositionFactor({ mood: '❄ 普跌' }).factor).toBe(0.5);
  });
  it('分化默认 0.8', () => {
    expect(envPositionFactor({ mood: '⚖ 分化震荡' }).factor).toBe(0.8);
  });
  it('指数全破 MA20 再降一档，下限 0.5', () => {
    expect(envPositionFactor({ mood: '🔥 普涨强势', indices: { '1A0001': below, '399006': below } }).factor).toBe(0.8);
    expect(envPositionFactor({ mood: '⚖ 分化', indices: { '1A0001': below, '399006': below } }).factor).toBe(0.6);
  });
});

describe('dayOf', () => {
  it('截断时间戳、空值返回 null', () => {
    expect(dayOf('2026-11-26T10:00:00')).toBe('2026-11-26');
    expect(dayOf(null)).toBe(null);
  });
});
