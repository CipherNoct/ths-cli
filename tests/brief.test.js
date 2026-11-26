import { describe, it, expect } from 'vitest';
import cmdBrief from '../lib/commands/brief.js';

const { digestMarket, enrichPosition, sessionLabel } = cmdBrief;

const raw = [
  { code: '1A0001', name: '上证指数', price: 3476.88, prevClose: 3476.5, upCount: 1200, downCount: 800, amount: 600e8 },
  { code: '399001', name: '深证成指', price: 10084, prevClose: 10100, upCount: 2000, downCount: 900, amount: 700e8 },
  { code: '399006', name: '创业板指', price: 2189.8, prevClose: 2180, upCount: 600, downCount: 200, amount: 300e8 },
];

describe('digestMarket（brief 大盘摘要）', () => {
  it('涨跌家数按沪+深合计，不重复计创业板', () => {
    const d = digestMarket(raw);
    expect(d.up).toBe(3200);
    expect(d.down).toBe(1700);
    expect(d.amount).toBe(1300e8);
  });
  it('指数涨跌幅按现价/昨收现算', () => {
    const d = digestMarket(raw);
    expect(d.shPct).toBeCloseTo(0.011, 2);
    expect(d.cybPct).toBeCloseTo(0.45, 1);
  });
  it('空/异常输入返回 null 或空字段', () => {
    expect(digestMarket([])).toBe(null);
    expect(digestMarket(null)).toBe(null);
    const partial = digestMarket([{ code: '1A0001', price: 3000 }]);
    expect(partial.up).toBe(null);
    expect(partial.shPct).toBe(null);
  });
});

describe('enrichPosition（持仓+止损距离）', () => {
  const pos = { code: '600519', name: '贵州茅台', qty: 100, avgCost: 1400, stopPrice: 1450 };
  it('有行情时算浮盈与距止损%', () => {
    const s = enrichPosition(pos, { price: 1500, pct: 2 });
    expect(s.floatPct).toBeCloseTo(7.14, 1);
    expect(s.stopDistancePct).toBeCloseTo(3.33, 1);
  });
  it('无行情用成本价，不出现 -100% 浮亏', () => {
    const s = enrichPosition(pos, null);
    expect(s.price).toBe(1400);
    expect(s.floatPct).toBe(0);
    expect(s.stopDistancePct).toBeCloseTo(-3.57, 1);
  });
  it('未设止损 stopDistancePct 为 null', () => {
    expect(enrichPosition({ ...pos, stopPrice: null }, { price: 1500 }).stopDistancePct).toBe(null);
  });
});

describe('sessionLabel', () => {
  it('按北京时间切晨报/盘中/晚报', () => {
    expect(sessionLabel({ minutes: 8 * 60 })).toBe('晨报');
    expect(sessionLabel({ minutes: 10 * 60 })).toBe('盘中');
    expect(sessionLabel({ minutes: 16 * 60 })).toBe('晚报');
  });
});
