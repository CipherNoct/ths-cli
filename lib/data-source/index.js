// lib/data-source/index.js — 行情数据源统一入口（Bridge 优先，失败自动降级 Node 直连）
//
// 为什么：真实运行数据显示 quote/quotes 占全部操作 67%，其中失败 7 次、悬挂 4 次
// （Bridge 未启动 / 业务错误），核心行情成了单点依赖。本层把"取行情"收敛到一处：
//   策略 auto   → 先 Bridge（浏览器内认证头最稳），失败/不可用 → Node 直连
//   策略 bridge → 只走 Bridge（要求数值口径严格同源的场景）
//   策略 direct → 只走直连（Bridge 不在线时的快速通道）
//
// 统一输出（调用方不感知来源）：
//   quote/quotes → { code, name, market, price, prevClose, open, high, low, volume, amount,
//                    pct, change, pe, pb, totalMv, floatMv, turnoverRate, volumeRatio,
//                    limitUp, limitDown, source, asOf }
//   kline        → bar[]，附带 bars.source / bars.asOf / bars.truncated
//   trend        → { time, price, volume, amount }[]，附带 points.source / points.asOf
//
// 设计约束：
// - 绝不改变数值口径：直连与 Bridge 是同一套字段码（见 direct.js 头注释）；
// - 批量并发 ≤ 4，单个请求一次重试，单只失败不拖垮整批；
// - 降级原因写 stderr（诊断走 stderr，保证 --json 的 stdout 干净）。

const { formatKline, escapeExpression, formatQuote } = require('../commands/helpers');
const DIRECT = require('./direct');

const MAX_CONCURRENCY = 4;

const STRATEGIES = new Set(['auto', 'bridge', 'direct']);

function normalizeStrategy(v) {
  const s = String(v || '').toLowerCase();
  return STRATEGIES.has(s) ? s : 'auto';
}

/** 环境/配置给出的策略：显式参数 > config.dataSource.strategy > 环境变量 > auto */
function resolveStrategy(ctx, override) {
  if (override) return normalizeStrategy(override);
  const cfg = ctx && ctx.config && ctx.config.dataSource && ctx.config.dataSource.strategy;
  if (cfg) return normalizeStrategy(cfg);
  if (process.env.THS_DATA_SOURCE) return normalizeStrategy(process.env.THS_DATA_SOURCE);
  return 'auto';
}

/** 限流并发执行 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function warnOnce(key, msg, state) {
  if (!state || state.warned[key]) return;
  state.warned[key] = true;
  process.stderr.write(`⚠ ${msg}\n`);
}

function bridgeExprQuote(code, market) {
  return `window.__ths.quote('${escapeExpression(code)}', '${escapeExpression(market)}')`;
}

function bridgeExprQuotes(items) {
  return `window.__ths.quotes(${JSON.stringify(items.map(i => ({ code: i.code, market: i.market })))})`;
}

function bridgeExprKline({ code, market, period, count, adjust }) {
  return `window.__ths.kline('${escapeExpression(code)}', '${escapeExpression(market)}', '${escapeExpression(period)}', ${-count}, '${escapeExpression(adjust)}')`;
}

function bridgeExprTrend({ code, market, count }) {
  return `window.__ths.trend('${escapeExpression(code)}', '${escapeExpression(market)}', ${count})`;
}

/** 统一数值化（Bridge 可能给数字，直连给字符串） */
function normalizeQuote(row, extra = {}) {
  if (!row) return null;
  const out = { ...row };
  for (const k of ['price', 'prevClose', 'open', 'high', 'low', 'volume', 'amount', 'pct', 'change',
    'pe', 'pb', 'totalMv', 'floatMv', 'turnoverRate', 'volumeRatio', 'limitUp', 'limitDown']) {
    if (out[k] != null) out[k] = DIRECT.toNum(out[k]);
  }
  if (out.code != null) out.code = String(out.code);
  if (out.market != null) out.market = String(out.market);
  return { ...out, ...extra };
}

/**
 * 直连日 K 补当日 bar：v6 的 01（前复权）收盘后常比 00/实时慢一根。
 * 仅在日线、且末根落后于"最近已收盘交易日"、快照能给出当日 OHLC 时补。
 * 若末根已是当日，则用快照校准 close（盘中即最新价，收盘后即收盘价）。
 * @returns {Promise<boolean>} 是否补/更新
 */
async function appendFreshDailyBar(bars, p, opts, directImpl) {
  const isDay = p.period === 'day' || p.period === 'day_1';
  if (!isDay || !bars.length) return false;
  let expected;
  try { expected = require('../trading-hours').latestExpectedTradingDate(); } catch (e) { return false; }
  const last = bars[bars.length - 1];
  if (String(last.date) >= expected) return false;
  let q;
  try {
    q = await (directImpl || DIRECT).fetchQuoteDirect({ code: p.code, market: p.market }, { timeoutMs: opts.timeoutMs });
  } catch (e) { return false; }
  const qDate = q && q.asOf ? String(q.asOf).slice(0, 10) : null;
  if (!qDate) return false;
  const o = { open: q.open, high: q.high, low: q.low, close: q.price };
  if (![o.open, o.high, o.low, o.close].every(v => v != null && Number(v) > 0)) return false;
  if (qDate > String(last.date)) {
    bars.push({
      date: qDate, open: o.open, high: o.high, low: o.low, close: o.close,
      volume: q.volume || 0, amount: q.amount || 0,
    });
    return true;
  }
  if (qDate === String(last.date) && Number(o.close) > 0) {
    // 末根已是当日但在途：更新 close/high/low 为最新（volume/amount 由 K 线源保留）
    last.close = o.close;
    last.high = Math.max(last.high, o.high);
    last.low = Math.min(last.low, o.low);
    return true;
  }
  return false;
}

/**
 * 创建数据源实例。
 * @param {object} opts
 * @param {'auto'|'bridge'|'direct'} [opts.strategy]
 * @param {function} [opts.bridgeCall] (expression) => Promise<any>
 * @param {object} [opts.direct] 直连实现（测试可注入 stub）
 * @param {object} [opts.state] 诊断状态（warned 去重）
 * @param {function} [opts.onApi] (endpoint, params, ms, status, summary) => void
 */
function createDataSource(opts = {}) {
  const strategy = normalizeStrategy(opts.strategy);
  const bridgeCall = opts.bridgeCall || null;
  const direct = opts.direct || DIRECT;
  const state = opts.state || { warned: {} };
  const onApi = opts.onApi || (() => {});

  const hasBridge = typeof bridgeCall === 'function' && strategy !== 'direct';

  async function timeApi(endpoint, params, fn) {
    const t0 = Date.now();
    try {
      const r = await fn();
      onApi(endpoint, params, Date.now() - t0, 'success', {});
      return r;
    } catch (e) {
      onApi(endpoint, params, Date.now() - t0, 'error', { error: e.message });
      throw e;
    }
  }

  // ── 实时行情 ──

  async function quoteOne(item) {
    const code = String(item.code);
    const market = item.market != null ? String(item.market) : '';
    const errors = [];

    if (hasBridge) {
      try {
        const raw = await timeApi('quote', { code, market, source: 'bridge' }, async () => {
          // 优先批量接口（一次一只），旧脚本无 quotes 时回退单只
          try {
            return { batch: await bridgeCall(`window.__ths.quotes(${JSON.stringify([{ code, market }])})`) };
          } catch (e) {
            return { single: await bridgeCall(bridgeExprQuote(code, market)) };
          }
        });
        const qd = raw && raw.batch ? (Array.isArray(raw.batch) ? raw.batch[0] : null) : raw && raw.single;
        const row = normalizeQuote(formatQuote(qd), { source: 'bridge', asOf: null });
        if (row && row.price != null) return row;
        errors.push(new Error('Bridge 未返回有效行情'));
      } catch (e) {
        errors.push(e);
      }
    }

    if (strategy !== 'bridge') {
      try {
        const row = normalizeQuote(await direct.fetchQuoteDirect({ code, market }, { timeoutMs: opts.timeoutMs }), { source: 'direct' });
        if (row && row.price != null) return row;
        errors.push(new Error('直连未返回有效行情'));
      } catch (e) {
        errors.push(e);
      }
    }

    const msg = errors.map(e => e.message).join('；');
    throw new Error(`行情获取失败 ${code}${msg ? `：${msg}` : ''}`);
  }

  /**
   * 批量行情：整批先走 Bridge（一次请求多只），失败再逐只直连。
   * 单只失败返回 null 占位，不拖垮整批。
   */
  async function quotes(items) {
    if (!Array.isArray(items) || !items.length) return [];
    const valid = items.filter(it => it && it.code).map(it => ({
      code: String(it.code),
      market: it.market != null ? String(it.market) : '',
    }));

    if (hasBridge) {
      try {
        const raw = await timeApi('quotes', { count: valid.length, source: 'bridge' }, () => bridgeCall(bridgeExprQuotes(valid)));
        const rows = (Array.isArray(raw) ? raw : []).map(qd => normalizeQuote(formatQuote(qd), { source: 'bridge' }))
          .filter(q => q && q.code && q.price != null);
        if (rows.length || !valid.length) return rows;
        warnOnce('quotes-bridge-empty', 'Bridge 批量行情返回空，降级直连', state);
      } catch (e) {
        warnOnce('quotes-bridge', `Bridge 批量行情不可用（${e.message}），降级直连`, state);
      }
    }

    if (strategy === 'bridge') {
      throw new Error('Bridge 批量行情不可用（--source bridge 禁止降级）');
    }

    const rows = await mapLimit(valid, MAX_CONCURRENCY, async it => {
      try {
        return normalizeQuote(await direct.fetchQuoteDirect(it, { timeoutMs: opts.timeoutMs }), { source: 'direct' });
      } catch (e) {
        warnOnce(`quote-${it.code}`, `直连行情失败 ${it.code}: ${e.message}`, state);
        return null;
      }
    });
    return rows.filter(Boolean);
  }

  async function quote(item) {
    if (!item || !item.code) throw new Error('缺少股票代码');
    return quoteOne(item);
  }

  // ── K 线 ──

  async function kline(params) {
    const p = {
      code: String(params.code),
      market: params.market != null ? String(params.market) : '',
      period: params.period || 'day_1',
      count: Number(params.count) || 250,
      adjust: params.adjust || 'forward',
    };
    const errors = [];

    if (hasBridge) {
      try {
        const qd = await timeApi('kline', { ...p, source: 'bridge' }, () => bridgeCall(bridgeExprKline(p)));
        if (qd && Array.isArray(qd.value) && qd.value.length) {
          const bars = qd.value.map(formatKline);
          bars.source = 'bridge';
          bars.asOf = bars.length ? bars[bars.length - 1].date : null;
          return bars;
        }
        errors.push(new Error('Bridge 未返回 K 线'));
      } catch (e) {
        errors.push(e);
      }
    }

    if (strategy !== 'bridge') {
      try {
        const res = await timeApi('kline-direct', { ...p, source: 'direct' }, () => direct.fetchKlineDirect(p, { timeoutMs: opts.timeoutMs }));
        if (res.bars.length) {
          const bars = res.bars;
          // v6 的 01（前复权）收盘后常比 00 慢一根：用实时快照补当日 K 线。
          // 前复权以最新价为基准，当日 bar 天然同尺度，补上不会污染复权链。
          await appendFreshDailyBar(bars, p, opts, direct);
          bars.source = 'direct';
          bars.asOf = bars.length ? bars[bars.length - 1].date : null;
          bars.available = res.available;
          bars.truncated = p.count > bars.length;
          if (bars.truncated) {
            warnOnce(`kline-${p.code}-${p.period}`, `直连只有 ${res.available} 根（请求 ${p.count}），已按可用条数返回；更多历史请用 Bridge`, state);
          }
          return bars;
        }
        errors.push(new Error('直连未返回 K 线'));
      } catch (e) {
        errors.push(e);
      }
    }

    const msg = errors.map(e => e.message).join('；');
    if (/120|quarter|不支持直连/.test(p.period) && !hasBridge) {
      throw new Error(`周期 ${p.period} 需要 Bridge（直连仅支持 day/week/month/60min）`);
    }
    throw new Error(`K 线获取失败 ${p.code}${msg ? `：${msg}` : ''}`);
  }

  // ── 分时 ──

  async function trend(params) {
    const p = {
      code: String(params.code),
      market: params.market != null ? String(params.market) : '',
      count: Math.max(0, Number(params.count) || 0),
    };
    const errors = [];

    if (hasBridge) {
      try {
        const qd = await timeApi('trend', { ...p, source: 'bridge' }, () => bridgeCall(bridgeExprTrend(p)));
        const idx = {};
        (qd && qd.data_fields || []).forEach((f, i) => { idx[f] = i; });
        const rows = (qd && Array.isArray(qd.value) ? qd.value : []).map(row => {
          const ts = idx['1'] != null ? row[idx['1']] : null;
          const d = ts != null ? new Date(ts) : null;
          const pad = n => String(n).padStart(2, '0');
          return {
            time: d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '-',
            price: DIRECT.toNum(idx['10'] != null ? row[idx['10']] : null),
            volume: DIRECT.toNum(idx['13'] != null ? row[idx['13']] : null),
            amount: DIRECT.toNum(idx['19'] != null ? row[idx['19']] : null),
          };
        });
        if (rows.length) {
          rows.source = 'bridge';
          rows.asOf = null;
          return rows;
        }
        errors.push(new Error('Bridge 未返回分时'));
      } catch (e) {
        errors.push(e);
      }
    }

    if (strategy !== 'bridge') {
      try {
        const res = await timeApi('trend-direct', { ...p, source: 'direct' }, () => direct.fetchTrendDirect(p, { timeoutMs: opts.timeoutMs }));
        if (res.points.length) {
          const rows = res.points;
          rows.source = 'direct';
          rows.asOf = res.asOf;
          return rows;
        }
        errors.push(new Error('直连未返回分时'));
      } catch (e) {
        errors.push(e);
      }
    }

    const msg = errors.map(e => e.message).join('；');
    throw new Error(`分时获取失败 ${p.code}${msg ? `：${msg}` : ''}`);
  }

  return { strategy, quote, quotes, kline, trend, state };
}

/**
 * 从命令上下文创建数据源（把 audit 的 apiCalls 串起来，便于失败归因）。
 * @param {object} ctx CLI 上下文（含 bridgeCall / audit / config）
 * @param {object} [opts] { strategy }
 */
function fromContext(ctx, opts = {}) {
  // Bridge 调用优先用 ctx.bridgeCall；测试/旧上下文只注入了 loggedCall 时复用后者，
  // 保持既有"审计 + 表达式"语义不变。
  let bridgeCall = null;
  if (ctx && typeof ctx.bridgeCall === 'function') bridgeCall = ctx.bridgeCall;
  else if (ctx && typeof ctx.loggedCall === 'function') {
    bridgeCall = expr => ctx.loggedCall('data-source', {}, expr);
  }
  return createDataSource({
    strategy: resolveStrategy(ctx, opts.strategy),
    bridgeCall,
    timeoutMs: (ctx && ctx.config && ctx.config.dataSource && ctx.config.dataSource.timeoutMs) || undefined,
    direct: opts.direct,
    onApi: (endpoint, params, ms, status, summary) => {
      if (ctx && ctx.audit && typeof ctx.audit.logApiCall === 'function') {
        try { ctx.audit.logApiCall(endpoint, params, ms, status, summary); } catch (e) { /* 审计失败不阻塞 */ }
      }
    },
  });
}

module.exports = {
  createDataSource, fromContext, resolveStrategy, normalizeStrategy, normalizeQuote, mapLimit, MAX_CONCURRENCY,
};
