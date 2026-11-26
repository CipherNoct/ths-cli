// lib/commands/brief.js — 单屏晨报/晚报（M7-3-3）
// 把「大盘 → 仓位系数 → 持仓 → 自选异动 → 今日规则」压到一屏，解决"每天不知道从哪下手"。

const { loadMarket, moodLabel } = require('./market');
const { summarizePosition } = require('../portfolio');
const { envPositionFactor } = require('../iron-rules');
const { fromContext } = require('../data-source');
const { DailyStore } = require('../daily-store');
const { getFlag } = require('./helpers');
const { fetchAllIndexBars, summarizeIndexTrend } = require('../index-kline');
const { toBeijingClock } = require('../trading-hours');

const fmtPct = (v, digits = 2) => (v == null || !Number.isFinite(v)) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
const fmtPrice = v => (v == null || !Number.isFinite(v)) ? '—' : String(Math.round(v * 100) / 100);

async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { return fallback; }
}

function sessionLabel(clk) {
  if (clk.minutes < 570) return '晨报';
  if (clk.minutes < 900) return '盘中';
  return '晚报';
}

/** 大盘：loadMarket() 返回原始行数组，这里聚合成 brief 需要的形状 */
function digestMarket(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const pick = code => rows.find(r => r.code === code) || null;
  const sh = pick('1A0001');
  const sz = pick('399001');
  const cyb = pick('399006');
  const up = sh && sz && sh.upCount != null && sz.upCount != null ? Number(sh.upCount) + Number(sz.upCount) : null;
  const down = sh && sz && sh.downCount != null && sz.downCount != null ? Number(sh.downCount) + Number(sz.downCount) : null;
  const amount = sh && sz && sh.amount != null && sz.amount != null ? Number(sh.amount) + Number(sz.amount) : null;
  const pct = r => (r && r.price != null && r.prevClose ? ((Number(r.price) / Number(r.prevClose)) - 1) * 100 : null);
  return {
    mood: moodLabel(up, down),
    up, down, amount,
    sh: sh ? Number(sh.price) : null, shPct: pct(sh),
    cyb: cyb ? Number(cyb.price) : null, cybPct: pct(cyb),
    updateTime: rows[0].updateTime || null,
  };
}

/** 把 summarizePosition + 止损价合成"距止损百分比"（正数=还在止损上方） */
function enrichPosition(p, mkt) {
  const s = summarizePosition(p, mkt);
  const stop = Number(p.stopPrice) > 0 ? Number(p.stopPrice) : null;
  const stopDistancePct = stop && s.price > 0 ? ((s.price - stop) / s.price) * 100 : null;
  return { ...s, stopPrice: stop, stopDistancePct };
}

async function cmdBrief(ctx, args) {
  const json = args.includes('--json');
  const srcFlag = getFlag(args, '--source', null);
  const cache = ctx.cache;
  const clk = toBeijingClock();
  const session = sessionLabel(clk);

  const market = await safe(async () => digestMarket(await loadMarket(ctx)), null);
  const indexBars = await safe(() => fetchAllIndexBars(), null);
  const env = {};
  if (indexBars) {
    for (const [code, bars] of Object.entries(indexBars)) {
      const t = bars ? summarizeIndexTrend(bars) : null;
      if (t) env[code] = { ...t, name: code === '1A0001' ? '上证' : code === '399006' ? '创业板' : '深成' };
    }
  }
  const factor = envPositionFactor(Object.keys(env).length ? { mood: market?.mood, indices: env } : { mood: market?.mood });

  const positions = cache.positionsList().filter(p => (Number(p.qty) || 0) > 0);
  let quotes = new Map();
  if (positions.length) {
    const ds = fromContext(ctx, { strategy: srcFlag });
    const rows = await safe(() => ds.quotes(positions.map(p => ({ code: p.code, market: p.market }))), null);
    if (!rows) throw new Error('行情获取失败：持仓盈亏无法计算（请检查网络或 Bridge）');
    quotes = new Map((rows || []).filter(r => r && Number.isFinite(r.price) && r.price > 0).map(r => [r.code, r]));
  }
  const posSummaries = positions.map(p => enrichPosition(p, quotes.get(p.code) || null));

  const watchCodes = cache.watchlistList().map(w => w.code).filter(c => !positions.some(p => p.code === c));
  let watchRows = [];
  if (watchCodes.length) {
    const ds = fromContext(ctx, { strategy: srcFlag });
    watchRows = (await safe(() => ds.quotes(watchCodes.map(code => ({ code }))), [])) || [];
  }

  // 最近快照的信号（只读文件，不触网）
  const store = new DailyStore();
  const dates = store.listDates();
  const lastDate = dates[dates.length - 1] || null;
  const snapFile = lastDate ? store.loadSnapshotFile(lastDate) : null;
  const snaps = snapFile?.stocks || {};
  const rules = store.listLessons()
    .filter(l => l.category === '规则' && (!l.status || l.status === 'active'))
    .sort((a, b) => (b.hitRate || 0) - (a.hitRate || 0));

  const totalMv = posSummaries.reduce((s, p) => s + (p.marketValue || 0), 0);
  const totalPnl = posSummaries.reduce((s, p) => s + (p.floatPnl || 0), 0);

  const payload = {
    session,
    date: clk.dateStr,
    market,
    env,
    factor,
    snapshotDate: lastDate,
    positions: posSummaries.map(s => ({
      code: s.code, name: s.name, qty: s.qty, price: s.price, pct: s.pct,
      floatPct: s.floatPct, stopPrice: s.stopPrice, stopDistancePct: s.stopDistancePct,
      signal: snaps[s.code]?.signal || null, score: snaps[s.code]?.score ?? null,
    })),
    totals: posSummaries.length ? { marketValue: totalMv, floatPnl: totalPnl } : null,
    watch: (watchRows || []).filter(r => r && Number.isFinite(r.price) && r.price > 0).map(r => ({
      code: r.code, name: r.name, price: r.price, pct: r.pct,
      signal: snaps[r.code]?.signal || null,
    })),
    rules: rules.map(l => ({ title: l.title || l.key, hitRate: l.hitRate ?? null, n: l.n ?? null })),
  };

  if (json) return payload;

  const lines = [];
  lines.push(`📋 ${session}  ${clk.dateStr} ${String(clk.hour).padStart(2, '0')}:${String(clk.min).padStart(2, '0')}`);
  lines.push('');

  if (market) {
    lines.push(`【大盘】${market.mood}  ↑${market.up ?? '—'} ↓${market.down ?? '—'}  上证 ${market.sh != null ? market.sh.toFixed(2) : '—'} ${fmtPct(market.shPct)}  创业板 ${market.cyb != null ? market.cyb.toFixed(2) : '—'} ${fmtPct(market.cybPct)}`);
  } else {
    lines.push('【大盘】行情不可用（Bridge 未连接且直连失败）');
  }
  if (env) {
    const parts = ['1A0001', '399006'].map(c => env[c]).filter(Boolean)
      .map(e => `${e.name}${e.aboveMA20 ? '在MA20上' : '跌破MA20'}`);
    if (parts.length) lines.push(`        ${parts.join(' · ')}`);
  }
  lines.push(`【仓位】系数 ${factor.factor.toFixed(1)}（${factor.level}）→ 总仓 ≤${factor.maxPositionPct}% · 单票 ≤${factor.singleStockPct}%`);

  lines.push('');
  if (posSummaries.length) {
    const avgPct = totalMv > 0 ? (totalPnl / (totalMv - totalPnl || 1)) * 100 : null;
    lines.push(`【持仓 ${posSummaries.length}】市值 ${totalMv.toFixed(0)} 元  浮盈 ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(0)} 元（${fmtPct(avgPct, 1)}）`);
    const broken = posSummaries.filter(s => s.stopDistancePct != null && s.stopDistancePct <= 0);
    for (const s of posSummaries) {
      const near = s.stopDistancePct != null && s.stopDistancePct > 0 && s.stopDistancePct <= 2;
      const flag = s.stopDistancePct == null ? '' : s.stopDistancePct <= 0
        ? `  ⚠ 已破止损 ${fmtPrice(s.stopPrice)}`
        : near ? `  ⚠ 贴近止损 ${fmtPrice(s.stopPrice)}（${s.stopDistancePct.toFixed(1)}%）`
          : `  距止损 ${s.stopDistancePct.toFixed(1)}%`;
      const sig = snaps[s.code]?.signal ? `  [${snaps[s.code].signal}]` : '';
      lines.push(`  ${s.code} ${s.name}  ${fmtPrice(s.price)} ${fmtPct(s.pct)}  浮盈 ${fmtPct(s.floatPct, 1)}${flag}${sig}`);
    }
    if (broken.length) lines.push(`  → 破位 ${broken.length} 只，按纪律先处理止损，别加仓`);
  } else {
    lines.push('【持仓】空仓');
  }

  lines.push('');
  if (payload.watch.length) {
    const notable = payload.watch.filter(w => Math.abs(w.pct || 0) >= 3 || w.signal);
    lines.push(`【自选 ${payload.watch.length}】${notable.length ? '异动' : '无异动'}`);
    for (const w of (notable.length ? notable : payload.watch).slice(0, 6)) {
      lines.push(`  ${w.code} ${w.name}  ${fmtPrice(w.price)} ${fmtPct(w.pct)}${w.signal ? `  [${w.signal}]` : ''}`);
    }
  } else {
    lines.push('【自选】空');
  }

  if (payload.rules.length) {
    lines.push('');
    lines.push('【今日规则】');
    for (const r of payload.rules.slice(0, 5)) {
      const hit = r.hitRate != null ? `  命中 ${Math.round(r.hitRate * 100)}%${r.n ? `（n=${r.n}）` : ''}` : '';
      lines.push(`  · ${r.title}${hit}`);
    }
  }

  if (!lastDate) {
    lines.push('');
    lines.push('⚠ 还没有任何快照——先跑一次 `ths daily run` 才有信号与规则');
  } else if (lastDate < clk.dateStr) {
    lines.push('');
    lines.push(`⚠ 最新快照是 ${lastDate}，今天还没跑 daily run——信号仅供参考`);
  }

  console.log(lines.join('\n'));
  return undefined;
}

module.exports = cmdBrief;
module.exports.digestMarket = digestMarket;
module.exports.enrichPosition = enrichPosition;
module.exports.sessionLabel = sessionLabel;
