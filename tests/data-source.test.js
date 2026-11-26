// tests/data-source.test.js — 行情直连解析 + Bridge→直连降级链
//
// fixture 由真实响应抓取（tests/fixtures/realhead-*.txt / line-day-*.txt / time-*.txt），
// 测试本身不联网：直连实现全部用注入 stub，避免 CI 依赖行情网络。

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseRealheadQuote, parseLineText, parseTimeText, directPeriodCode,
} from '../lib/data-source/direct.js';
import { createDataSource } from '../lib/data-source/index.js';
import { inferMarket } from '../lib/commands/helpers.js';
import { parseKlineArgs } from '../lib/commands/kline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const { parseRealheadJsonp } = require('../lib/parsers/market');

describe('直连实时快照解析（realhead）', () => {
  it('个股：价格/昨收/涨跌/估值/时间 与行情字段同口径', () => {
    const row = parseRealheadQuote('600519', parseRealheadJsonp(read('realhead-600519.txt')), '17');
    expect(row.code).toBe('600519');
    expect(row.market).toBe('17');
    expect(row.name).toBe('贵州茅台');
    expect(row.price).toBeGreaterThan(0);
    expect(row.prevClose).toBeGreaterThan(0);
    expect(row.pct).toBeCloseTo(((row.price - row.prevClose) / row.prevClose) * 100, 1);
    expect(row.change).toBeCloseTo(row.price - row.prevClose, 1);
    expect(row.limitUp).toBeGreaterThan(row.price);
    expect(row.limitDown).toBeLessThan(row.price);
    expect(row.asOf).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(row.source).toBe('direct');
  });

  it('ETF：marketid=20（沪基金），不是个股 17', () => {
    const row = parseRealheadQuote('512000', parseRealheadJsonp(read('realhead-512000.txt')), '20');
    expect(row.market).toBe('20');
    expect(row.name).toContain('ETF');
    expect(row.price).toBeGreaterThan(0);
  });
});

describe('直连 K 线解析（v6/line）', () => {
  const bars = parseLineText(read('line-day-600519.txt'));

  it('条数/字段完整，日期升序', () => {
    expect(bars.length).toBeGreaterThan(100);
    for (const b of bars) {
      expect(b.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(b.close).toBeGreaterThan(0);
    }
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].date >= bars[i - 1].date).toBe(true);
    }
  });

  it('剔除空 OHLC 的占位行', () => {
    expect(bars.every(b => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0)).toBe(true);
    expect(bars.every(b => b.high >= b.close && b.low <= b.close)).toBe(true);
  });

  it('周期/复权映射：日线前复权=01，60分=60，不支持 quarter', () => {
    expect(directPeriodCode('day_1', 'forward')).toBe('01');
    expect(directPeriodCode('day', 'none')).toBe('00');
    expect(directPeriodCode('day', 'backward')).toBe('02');
    expect(directPeriodCode('week_1', 'forward')).toBe('11');
    expect(directPeriodCode('60min', 'forward')).toBe('60');
    expect(directPeriodCode('quarter', 'forward')).toBeNull();
    expect(directPeriodCode('120min', 'forward')).toBeNull();
  });
});

describe('直连分时解析（v6/time）', () => {
  const p = parseTimeText(read('time-600519.txt'));

  it('时间/价格/成交量/成交额字段正确（volume 取第 5 列，amount 取第 3 列）', () => {
    expect(p.points.length).toBeGreaterThan(200);
    const first = p.points[0];
    expect(first.time).toBe('09:30');
    expect(first.price).toBeGreaterThan(0);
    expect(first.amount).toBeGreaterThan(first.volume); // 额(元) > 量(股) 不可能为 200 这种笔数
    expect(p.points[p.points.length - 1].time >= '15:00').toBe(true);
    expect(p.prevClose).toBeGreaterThan(0);
    expect(p.asOf).toMatch(/^\d{4}-\d{2}-\d{2} 1[45]:\d{2}$/);
  });
});

describe('Bridge → 直连降级链', () => {
  const quoteFixture = () => parseRealheadQuote('600519', parseRealheadJsonp(read('realhead-600519.txt')), '17');

  const directStub = () => ({
    fetchQuoteDirect: async ({ code }) => ({ ...quoteFixture(), code, source: 'direct' }),
    fetchKlineDirect: async (p) => ({
      bars: [{ date: '2026-11-25', open: 10, high: 11, low: 9, close: 10.5, volume: 1, amount: 1 }],
      source: 'direct', asOf: '2026-11-25', available: 1,
    }),
    fetchTrendDirect: async () => ({
      points: [{ time: '09:30', price: 10, volume: 1, amount: 10 }],
      source: 'direct', asOf: null, prevClose: 9.9, name: null,
    }),
  });

  it('Bridge 失败 → 自动直连，并标注 source', async () => {
    const ds = createDataSource({
      strategy: 'auto',
      bridgeCall: async () => { throw new Error('Bridge Server 未启动'); },
      direct: directStub(),
    });
    const row = await ds.quote({ code: '600519', market: '17' });
    expect(row.source).toBe('direct');
    expect(row.price).toBeGreaterThan(0);
  });

  it('--source bridge 只走 Bridge，失败直接抛错不降级', async () => {
    const ds = createDataSource({
      strategy: 'bridge',
      bridgeCall: async () => { throw new Error('offline'); },
      direct: directStub(),
    });
    await expect(ds.quote({ code: '600519', market: '17' })).rejects.toThrow(/行情获取失败/);
  });

  it('批量里单只失败不拖垮整批（返回其余行情）', async () => {
    const ds = createDataSource({
      strategy: 'auto',
      bridgeCall: async () => [],
      direct: {
        ...directStub(),
        fetchQuoteDirect: async ({ code }) => {
          if (code === 'BAD') throw new Error('404');
          return { ...quoteFixture(), code, source: 'direct' };
        },
      },
    });
    const rows = await ds.quotes([
      { code: '600519', market: '17' },
      { code: 'BAD', market: '17' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('600519');
  });

  it('直连日 K 落后一根 → 用实时快照补当日 bar', async () => {
    const ds = createDataSource({
      strategy: 'direct',
      direct: directStub(),
      bridgeCall: null,
    });
    const bars = await ds.kline({ code: '600519', market: '17', period: 'day_1', count: 5, adjust: 'forward' });
    // stub 的 bar 停在 2026-11-25；快照 asOf 更新（fixture 抓于 11-26）→ 应补当日
    const lastDate = bars[bars.length - 1].date;
    expect(lastDate > '2026-11-25').toBe(true);
    expect(bars.length).toBe(2);
  });

  it('数值统一化：字符串行情也输出 number', async () => {
    const ds = createDataSource({
      strategy: 'direct',
      bridgeCall: null,
      direct: {
        ...directStub(),
        fetchQuoteDirect: async ({ code }) => ({
          code, market: '17', price: '12.30', pct: '-1.10', change: '-0.14',
          source: 'direct', asOf: null,
        }),
      },
    });
    const row = await ds.quote({ code: '600519', market: '17' });
    expect(row.price).toBe(12.3);
    expect(row.pct).toBeCloseTo(-1.1);
  });
});

describe('ETF/基金市场码（M7-0-8）', () => {
  it('5→20（沪基金），15/16→36（深基金）', () => {
    expect(inferMarket('512000')).toBe('20');
    expect(inferMarket('510300')).toBe('20');
    expect(inferMarket('159766')).toBe('36');
    expect(inferMarket('160105')).toBe('36');
    expect(inferMarket('600519')).toBe('17');
    expect(inferMarket('000001')).toBe('33');
  });

  it('parseKlineArgs 对 ETF 不再抛"无法推断市场码"', () => {
    expect(parseKlineArgs(['512000']).market).toBe('20');
    expect(parseKlineArgs(['159766']).market).toBe('36');
  });
});
