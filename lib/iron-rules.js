// lib/iron-rules.js — 交易成本/整手/T+1/单票与单笔风险上限（纯函数）
//
// 目的：把"铁律"从口头的纪律变成命令层的检查与提示，
// 避免回测/实盘收益被忽略的成本（佣金/印花税）与违规下单（非整手、当日买当日卖）虚高。

/** 费用估算（2026 年常见档位，可按 config 覆盖） */
const FEE = {
  commissionRate: 0.00025,   // 佣金 万2.5
  commissionMin: 5,          // 单笔最低 5 元
  transferRate: 0.00001,     // 过户费 万0.1（沪深都收）
  stampRate: 0.0005,         // 印花税 万5（仅卖出，2023-08 起减半）
};

const round2 = v => (v == null || !isFinite(v) ? null : Number(v.toFixed(2)));

/**
 * 估算一笔交易成本。
 * @param {object} p { action:'buy'|'sell', qty, price }
 * @returns {{total:number, commission:number, transfer:number, stamp:number}}
 */
function estimateFee(p) {
  const amount = Math.max(0, Number(p.qty) || 0) * Math.max(0, Number(p.price) || 0);
  const commission = amount > 0 ? Math.max(FEE.commissionMin, amount * FEE.commissionRate) : 0;
  const transfer = amount * FEE.transferRate;
  const stamp = p.action === 'sell' ? amount * FEE.stampRate : 0;
  return {
    total: round2(commission + transfer + stamp),
    commission: round2(commission),
    transfer: round2(transfer),
    stamp: round2(stamp),
  };
}

/**
 * 整手检查：A 股买入 100 股整数倍（科创板 688 起 200 股、按 1 股递增）。
 * 只做提示不拦截——卖出允许零股。
 * @returns {{ok:boolean, msg:string|null}}
 */
function checkLot(code, qty, action = 'buy') {
  const n = Number(qty) || 0;
  if (action !== 'buy') return { ok: true, msg: null };
  const isStar = /^688/.test(String(code));
  if (isStar) {
    if (n < 200) return { ok: false, msg: `科创板最低 200 股（当前 ${n}）` };
    return { ok: true, msg: null };
  }
  if (n % 100 !== 0) return { ok: false, msg: `${n} 股不是 100 股整手（买入须为 100 的整数倍）` };
  return { ok: true, msg: null };
}

/** 日期归一（YYYY-MM-DD） */
function dayOf(v) {
  if (!v) return null;
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/**
 * T+1：当日买入的数量当日不能卖出。
 * @param {object} pos 持仓（含 trades）
 * @param {number} sellQty
 * @param {string} date 卖出日期（YYYY-MM-DD）
 * @returns {{ok:boolean, sellable:number, msg:string|null}}
 */
function checkT1(pos, sellQty, date) {
  const d = dayOf(date) || new Date().toISOString().slice(0, 10);
  const todayBuy = (pos && Array.isArray(pos.trades) ? pos.trades : [])
    .filter(t => t.action === 'buy' && dayOf(t.date) === d)
    .reduce((s, t) => s + (Number(t.qty) || 0), 0);
  const sellable = Math.max(0, (Number(pos && pos.qty) || 0) - todayBuy);
  if (Number(sellQty) > sellable) {
    return {
      ok: false,
      sellable,
      msg: `T+1 限制：当日买入 ${todayBuy} 股不可卖，可卖 ${sellable} 股（请求 ${sellQty}）`,
    };
  }
  return { ok: true, sellable, msg: null };
}

/**
 * 单票上限（默认 20%）：marketValue / totalCapital 超限提示。
 * @returns {{ok:boolean, pct:number|null, msg:string|null}}
 */
function checkPositionCap(marketValue, totalCapital, maxPct = 20) {
  if (!(totalCapital > 0)) return { ok: true, pct: null, msg: null };
  const pct = (Number(marketValue) || 0) / totalCapital * 100;
  if (pct > maxPct) {
    return { ok: false, pct: round2(pct), msg: `单票占比 ${pct.toFixed(1)}% 超过上限 ${maxPct}%` };
  }
  return { ok: true, pct: round2(pct), msg: null };
}

/**
 * 单笔风险上限（默认总资金 2%）：(买入价-止损价)×数量。
 * @returns {{ok:boolean, riskPct:number|null, riskAmount:number|null, msg:string|null}}
 */
function checkRiskPerTrade(p) {
  const entry = Number(p.entry), stop = Number(p.stop), qty = Number(p.qty), capital = Number(p.totalCapital);
  if (!(entry > 0) || !(stop > 0) || !(qty > 0) || !(capital > 0)) return { ok: true, riskPct: null, riskAmount: null, msg: null };
  const perShare = entry - stop;
  if (perShare <= 0) return { ok: false, riskPct: null, riskAmount: null, msg: `止损 ${stop} 不低于买入价 ${entry}（无风险空间）` };
  const riskAmount = perShare * qty;
  const riskPct = riskAmount / capital * 100;
  if (riskPct > 2) {
    return {
      ok: false, riskPct: round2(riskPct), riskAmount: round2(riskAmount),
      msg: `单笔风险 ${riskAmount.toFixed(0)} 元 = 总资金 ${riskPct.toFixed(1)}%（>2% 铁律）`,
    };
  }
  return { ok: true, riskPct: round2(riskPct), riskAmount: round2(riskAmount), msg: null };
}

/**
 * 大盘环境 → 仓位系数（M7-3-1）。
 * 逻辑：普跌收紧、分化中性、普涨放开；指数跌破 MA20 再打一档。
 * @param {object} marketEnv { mood, totalUp, totalDown, indices }
 * @returns {{factor:number, maxPositionPct:number, level:string, reason:string}}
 */
function envPositionFactor(marketEnv) {
  const mood = (marketEnv && marketEnv.mood) || '';
  let factor = 0.8;
  let level = '中性';
  if (/普跌|大跌/.test(mood)) { factor = 0.5; level = '防守'; }
  else if (/普涨|强势/.test(mood)) { factor = 1.0; level = '进攻'; }
  else if (/分化|震荡/.test(mood)) { factor = 0.8; level = '谨慎'; }
  const idx = marketEnv && marketEnv.indices;
  const parts = idx ? ['1A0001', '399006'].map(c => idx[c]).filter(Boolean) : [];
  const below = parts.filter(p => p.aboveMA20 === false).length;
  if (parts.length && below === parts.length && factor > 0.5) {
    factor = Math.max(0.5, Math.round((factor - 0.2) * 10) / 10);
    level = '防守';
  }
  return {
    factor,
    maxPositionPct: Math.round(factor * 70),      // 总仓位上限（%）
    singleStockPct: Math.round(factor * 20),       // 单票上限（%），基准记 20%
    level,
    reason: `大盘「${mood || '未知'}」${parts.length ? `，指数${below === parts.length ? '全部跌破MA20' : below ? '部分跌破MA20' : '均在MA20上'}` : ''} → 仓位系数 ${factor}`,
  };
}

module.exports = {
  FEE, estimateFee, checkLot, checkT1, checkPositionCap, checkRiskPerTrade, envPositionFactor, dayOf,
};
