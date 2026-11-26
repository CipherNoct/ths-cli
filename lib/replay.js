// lib/replay.js — 历史回放：用已有日 K"演戏"生成学习样本（冷启动）
//
// 为什么：daily 学习回路要 minN=5 个方向样本才有意义，靠每天盯盘攒样本，
// 新池/新特征要等几周。回放让"过去 250 根 K 线"变成几十条带 outcome 的样本：
//   bars[0..i] → buildSummary（不含未来数据，无前视偏差）→ 快照(date=bars[i].date)
//   再用 bars[i+3]/bars[i+5] 的收盘算 outcome（与 M7-2-1 同口径）
//
// 隔离：演习样本单独落盘 data/replay/<code>.json，绝不写进 data/daily/snapshots，
// 且每条带 source='replay'，报告里必须显式标注，避免和实盘混看。

const fs = require('fs');
const path = require('path');
const { atomicWriteJson, readJson } = require('./store/atomic');
const { buildSummary } = require('./summary');
const { computeOutcomes } = require('./daily-review');

const DEFAULT_DIR = process.env.THS_REPLAY_DIR || path.join(__dirname, '..', 'data', 'replay');

/**
 * 生成回放样本。
 * @param {object} p
 * @param {string} p.code
 * @param {string} [p.name]
 * @param {Array<{date,open,high,low,close,volume,amount}>} p.bars 升序日 K（前复权）
 * @param {number} [p.lookback=60] 起演位置（前 60 根用于算指标）
 * @param {number} [p.step=3] 每 N 根演一次（越小样本越多、越慢）
 * @param {object} [p.marketEnv] 可注入统一大盘环境（历史回放没有当日 marketEnv，标 null 更诚实）
 * @returns {Array<object>} 带 outcome 的样本
 */
function buildReplaySnapshots(p) {
  const bars = Array.isArray(p.bars) ? p.bars : [];
  const lookback = Math.max(30, Number(p.lookback) || 60);
  const step = Math.max(1, Number(p.step) || 3);
  if (bars.length <= lookback + 2) return [];
  const snaps = [];
  for (let i = lookback; i < bars.length; i += step) {
    const slice = bars.slice(0, i + 1);
    let s;
    try {
      s = buildSummary(p.code, slice, {});
    } catch (e) {
      continue;
    }
    const bar = bars[i];
    snaps.push({
      code: p.code,
      name: p.name || p.code,
      date: bar.date,
      close: bar.close,
      score: s.score,
      signal: s.signal,
      signalGrade: s.signalGrade,
      signalLabel: s.signalLabel,
      conflicts: s.conflicts,
      factors: s.factors,
      maAlignment: s.maAlignment,
      macdStatus: s.macdStatus,
      kdj: s.kdj,
      rsi6: s.rsi6,
      adx: s.adx,
      dmi: s.dmi,
      atrPct: s.atrPct,
      support: s.support,
      resistance: s.resistance,
      patterns: (s.patterns || []).map(label => ({ label, direction: null })),
      dayLow: bar.low,
      dayHigh: bar.high,
      marketEnv: p.marketEnv || null,
      source: 'replay',
      synthetic: true,
    });
  }
  // 用完整 bars 做交易日窗口 outcome（与实盘同一套函数）
  return computeOutcomes(snaps, { bars });
}

/** 写入单只股票的回放样本 */
function saveReplay(code, payload, dir = DEFAULT_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${code}.json`);
  atomicWriteJson(file, {
    version: 1,
    code,
    name: payload.name || null,
    generatedAt: new Date().toISOString(),
    barsFrom: payload.barsFrom || null,
    barsTo: payload.barsTo || null,
    samples: payload.samples || [],
  });
  return file;
}

/** 读取回放样本（codes 为空 → 全部） */
function loadReplay(codes, dir = DEFAULT_DIR) {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch (e) {
    return out;
  }
  const want = codes && codes.length ? new Set(codes.map(String)) : null;
  for (const f of files) {
    const code = f.replace(/\.json$/, '');
    if (want && !want.has(code)) continue;
    const r = readJson(path.join(dir, f));
    if (!r.ok || !r.data || !Array.isArray(r.data.samples)) continue;
    for (const s of r.data.samples) out.push({ ...s, source: 'replay' });
  }
  return out;
}

module.exports = { buildReplaySnapshots, saveReplay, loadReplay, DEFAULT_DIR };
