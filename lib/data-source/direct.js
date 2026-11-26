// lib/data-source/direct.js — Node 直连行情（无需浏览器/油猴）
//
// 数据源（实测，2026-11-26）：
//   实时快照  https://d.10jqka.com.cn/v2/realhead/hs_<code>/last.js
//             → items 字段码与 quota multi_last_snapshot 同一套
//             （6昨收/7开/8高/9低/10最新价/13量/19额/69涨停/70跌停/199112涨跌幅/
//               264648涨跌额/3153PE/592920PB/3475914总市值/3541450流通市值/
//               1968584换手率/1771976量比 + name/marketid/updateTime）
//   日/周/月/60分 K  https://d.10jqka.com.cn/v6/line/hs_<code>/<周期>/last.js
//             周期 01 前复权 / 00 不复权 / 02 后复权，日=01、周=11、月=21、60分=60
//             返回最近约 140 根（周/月可更早），行末字段：date,open,high,low,close,vol,amount,…
//   分时      https://d.10jqka.com.cn/v6/time/hs_<code>/last.js
//             data = "0930,9.10,55690772,9.100,6119865;…"
//
// 覆盖范围：沪深主板/创业板/科创板个股与 ETF（512000/159766 实测可用）。
// 板块指数（88xxxx）与 120min/quarter 周期不在该体系内，仍只能走 Bridge。

const { httpGet } = require('../net');
const { QUOTE_FIELDS } = require('../commands/helpers');
const { parseRealheadJsonp } = require('../parsers/market');

const BASE = 'https://d.10jqka.com.cn';

/** 数值化：''/'-'/非数字 → null（'0' 保留为 0） */
function toNum(v) {
  if (v == null || v === '' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 同花顺 hs_ 体系代码（个股/ETF/指数通用） */
function hsCode(code) {
  return `hs_${String(code).trim()}`;
}

// ── 实时快照 ─────────────────────────────────────────────

/**
 * realhead items → 统一行情行（与 formatQuote 输出同形）。
 * @param {string} code
 * @param {object} items
 * @param {string} [fallbackMarket]
 * @returns {object|null}
 */
function parseRealheadQuote(code, items, fallbackMarket) {
  if (!items || items['10'] == null) return null;
  const out = {
    code: String(code),
    market: items.marketid != null ? String(items.marketid) : (fallbackMarket != null ? String(fallbackMarket) : null),
    name: items.name || null,
    raw: items,
  };
  for (const [f, name] of Object.entries(QUOTE_FIELDS)) {
    if (items[f] == null) continue;
    out[name] = toNum(items[f]);
  }
  out.asOf = items.updateTime || null;
  out.source = 'direct';
  return out;
}

async function fetchQuoteDirect({ code, market }, opts = {}) {
  const url = `${BASE}/v2/realhead/${hsCode(code)}/last.js`;
  let lastErr;
  const retries = opts.retries != null ? opts.retries : 1;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const text = (await httpGet(url, { timeoutMs: opts.timeoutMs || 10000 })).toString('utf8');
      const items = parseRealheadJsonp(text);
      const row = parseRealheadQuote(code, items, market);
      if (row) return row;
      lastErr = new Error('realhead 未返回最新价');
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`直连行情失败 ${code}: ${lastErr && lastErr.message ? lastErr.message : '未知错误'}`);
}

// ── K 线 ────────────────────────────────────────────────

/** CLI/API 周期 → v6/line 周期码；不支持返回 null */
const DIRECT_PERIOD = {
  day: '01', day_1: '01',
  week: '11', week_1: '11',
  month: '21', month_1: '21',
  '60min': '60', min_60: '60',
};

const ADJUST_CODE = { forward: '01', backward: '02', none: '00' };

/**
 * 周期 + 复权 → v6 路径周期码。
 * 注意：v6 的周期码本身已表示复权（01/00/02），周/月用 11/21 时无法同时切复权，
 * 实测周/月默认返回前复权；因此只在日线/60 分上按 adjust 切换。
 */
function directPeriodCode(period, adjust) {
  const base = DIRECT_PERIOD[period];
  if (!base) return null;
  if (base === '01') {
    const a = ADJUST_CODE[adjust];
    if (a) return a;
  }
  return base;
}

function fmtBarDate(raw) {
  const s = String(raw);
  if (s.length >= 12) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * v6/line JSONP 文本 → bars（升序，形状与格式与 Bridge 的 formatKline 一致）。
 * @param {string} text
 * @returns {Array<{date,open,high,low,close,volume,amount}>}
 */
function parseLineText(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return [];
  let obj;
  try { obj = JSON.parse(m[0]); } catch (e) { return []; }
  const raw = obj && obj.data;
  if (typeof raw !== 'string' || !raw) return [];
  const bars = [];
  for (const row of raw.split(';')) {
    if (!row) continue;
    const f = row.split(',');
    if (f.length < 6) continue;
    // 盘中占位 bar（OHLC 为空）不是真实成交数据，剔除
    if (f[1] === '' || f[2] === '' || f[3] === '' || f[4] === '') continue;
    const o = Number(f[1]), h = Number(f[2]), l = Number(f[3]), c = Number(f[4]);
    if (![o, h, l, c].every(Number.isFinite) || c === 0) continue;
    bars.push({
      date: fmtBarDate(f[0]),
      open: o, high: h, low: l, close: c,
      volume: Number(f[5]) || 0,
      amount: f[6] != null ? Number(f[6]) || 0 : 0,
    });
  }
  return bars;
}

/** 直连 K 线上限（v6/line last.js 只给最近约 140 根） */
const DIRECT_KLINE_MAX = 140;

/**
 * 直连拉取 K 线。
 * @param {object} p { code, market, period, count, adjust }
 * @returns {Promise<{bars:Array, source:string, asOf:string|null, truncated:boolean}>}
 */
async function fetchKlineDirect(p, opts = {}) {
  const periodCode = directPeriodCode(p.period, p.adjust);
  if (!periodCode) {
    throw new Error(`周期 ${p.period} 不支持直连（仅 day/week/month/60min），需要 Bridge`);
  }
  const url = `${BASE}/v6/line/${hsCode(p.code)}/${periodCode}/last.js`;
  let lastErr;
  const retries = opts.retries != null ? opts.retries : 1;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const text = (await httpGet(url, { timeoutMs: opts.timeoutMs || 12000 })).toString('utf8');
      const all = parseLineText(text);
      if (!all.length) { lastErr = new Error('v6/line 空返回'); continue; }
      // 在途末根由调用方按交易时段剔除（cache.closedBars）；这里只做条数截取
      const want = Math.max(1, Number(p.count) || DIRECT_KLINE_MAX);
      const bars = all.length > want ? all.slice(-want) : all;
      return {
        bars,
        source: 'direct',
        asOf: bars.length ? bars[bars.length - 1].date : null,
        truncated: want > all.length ? all.length : false,
        available: all.length,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`直连 K 线失败 ${p.code}: ${lastErr && lastErr.message ? lastErr.message : '未知错误'}`);
}

// ── 分时 ────────────────────────────────────────────────

/**
 * v6/time JSONP → 分时点（与 formatTrend 同形）。
 * @param {string} text
 * @returns {{points:Array<{time,price,volume,amount}>, asOf:string|null, prevClose:number|null, name:string|null}}
 */
function parseTimeText(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return { points: [], asOf: null, prevClose: null, name: null };
  let obj;
  try { obj = JSON.parse(m[0]); } catch (e) { return { points: [], asOf: null, prevClose: null, name: null }; }
  const key = Object.keys(obj || {})[0];
  const d = key ? obj[key] : null;
  if (!d || typeof d.data !== 'string') return { points: [], asOf: null, prevClose: null, name: null };
  const points = [];
  for (const row of d.data.split(';')) {
    if (!row) continue;
    const f = row.split(',');
    if (f.length < 3 || !f[0]) continue;
    const hh = String(f[0]).slice(0, 2), mm = String(f[0]).slice(2, 4);
    // v6/time 字段实测：HHMM, price, amount(元), avgPrice, volume(股)
    points.push({
      time: `${hh}:${mm}`,
      price: toNum(f[1]),
      volume: f.length > 4 ? toNum(f[4]) : null,
      amount: f.length > 2 ? toNum(f[2]) : null,
    });
  }
  const dateRaw = String(d.date || '');
  const asOf = dateRaw.length >= 8
    ? `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}${points.length ? ' ' + points[points.length - 1].time : ''}`
    : null;
  return {
    points,
    asOf,
    prevClose: toNum(d.pre),
    name: d.name || null,
  };
}

async function fetchTrendDirect({ code, count }, opts = {}) {
  const url = `${BASE}/v6/time/${hsCode(code)}/last.js`;
  let lastErr;
  const retries = opts.retries != null ? opts.retries : 1;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const text = (await httpGet(url, { timeoutMs: opts.timeoutMs || 12000 })).toString('utf8');
      const parsed = parseTimeText(text);
      if (!parsed.points.length) { lastErr = new Error('v6/time 空返回'); continue; }
      const want = Number(count) > 0 ? parsed.points.slice(-Number(count)) : parsed.points;
      return { points: want, source: 'direct', asOf: parsed.asOf, prevClose: parsed.prevClose, name: parsed.name };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`直连分时失败 ${code}: ${lastErr && lastErr.message ? lastErr.message : '未知错误'}`);
}

module.exports = {
  toNum, hsCode, parseRealheadQuote, fetchQuoteDirect,
  DIRECT_PERIOD, ADJUST_CODE, directPeriodCode, parseLineText, fetchKlineDirect,
  DIRECT_KLINE_MAX, parseTimeText, fetchTrendDirect,
};
