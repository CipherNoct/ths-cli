// lib/trading-hours.js — A 股交易时段判定（纯函数，可单测）
//
// 设计要点：
// - 北京时区 = UTC+8 固定偏移（中国无夏令时），不依赖进程本地 TZ。
// - toBeijingClock 是本模块唯一的 "北京现在" 来源；marketPhase 与 cache.js 的
//   forming-bar 判定都从它派生，避免多处各写一套偏移导致 "今天" 错位。
// - 不内置交易日历：节假日由"冻结/无成交"规则兜底（见 watch-engine），这里只分周中/周末。

const BJ_OFFSET_MS = 8 * 3600 * 1000;

const pad = n => String(n).padStart(2, '0');

/**
 * 北京时间钟面（基于 UTC+8，与进程本地时区无关）。
 * @param {number} [nowMs] 毫秒时间戳（默认 Date.now()，测试注入）
 * @returns {{dateStr:string, minutes:number, wd:number, year:number, month:number, day:number, hour:number, min:number}}
 *   dateStr='YYYY-MM-DD'（北京日期）；minutes=当日 0..1439 累计分钟；wd=0(周日)..6(周六)
 */
function toBeijingClock(nowMs) {
  const t = typeof nowMs === 'number' ? nowMs : Date.now();
  const d = new Date(t + BJ_OFFSET_MS);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    dateStr: `${year}-${pad(month)}-${pad(day)}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    wd: d.getUTCDay(),
    year, month, day,
    hour: d.getUTCHours(),
    min: d.getUTCMinutes(),
    sec: d.getUTCSeconds(),
  };
}

// 时段边界（分钟）
const T_AUCTION_START = 9 * 60 + 15; // 09:15 集合竞价
const T_AM_START = 9 * 60 + 30;      // 09:30 连续竞价
const T_AM_END = 11 * 60 + 30;       // 11:30 上午收盘
const T_PM_START = 13 * 60;          // 13:00 下午开盘
const T_PM_END = 15 * 60;            // 15:00 收盘
const T_BAR_SETTLE = 15 * 60 + 5;    // 15:05 K 线定型缓冲

const PHASE_LABEL = {
  pre: '盘前',
  auction: '集合竞价',
  am: '上午盘中',
  lunch: '午间休市',
  pm: '下午盘中',
  post: '已收盘',
  weekend: '周末休市',
};

/**
 * 判断北京时间钟面落在哪个交易时段。
 * @param {number} [nowMs]
 * @returns {{phase:string, inSession:boolean, label:string, clock:object}}
 *   phase ∈ pre/auction/am/lunch/pm/post/weekend
 *   inSession=true 仅 am/pm（只有连续竞价才算"盘中可告警"；auction 只记状态不告警）
 *   label 中文标签（显示用）
 */
function marketPhase(nowMs) {
  const clock = toBeijingClock(nowMs);
  const H = clock.minutes;
  let phase;
  if (clock.wd === 0 || clock.wd === 6) {
    phase = 'weekend';
  } else if (H < T_AUCTION_START) {
    phase = 'pre';
  } else if (H < T_AM_START) {
    phase = 'auction';
  } else if (H < T_AM_END) {
    phase = 'am';
  } else if (H < T_PM_START) {
    phase = 'lunch';
  } else if (H < T_PM_END) {
    phase = 'pm';
  } else {
    phase = 'post';
  }
  return { phase, inSession: phase === 'am' || phase === 'pm', label: PHASE_LABEL[phase], clock };
}

/**
 * 是否处于可轮询时段（auction 也要轮询——记录集合竞价状态，供开盘穿越判定）。
 */
function shouldPoll(phase) {
  return phase === 'auction' || phase === 'am' || phase === 'pm';
}

/**
 * 最近一个“已收盘”交易日（北京日期 YYYY-MM-DD，不含节假日日历）。
 * 用途：判断行情末根是否陈旧——收盘后（>=15:05）应是今天，
 * 盘中/盘前应至少是上一交易日；周末回溯到周五。
 * @param {number} [nowMs]
 * @returns {string}
 */
function latestExpectedTradingDate(nowMs) {
  const c = toBeijingClock(nowMs);
  const step = (dateStr, delta) => {
    const t = Date.parse(`${dateStr}T00:00:00Z`) + delta * 86400000;
    const d = new Date(t);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  let date = c.dateStr;
  let wd = c.wd;
  if (c.minutes < T_BAR_SETTLE) { date = step(date, -1); wd = (wd + 6) % 7; }
  while (wd === 0 || wd === 6) { date = step(date, -1); wd = (wd + 6) % 7; }
  return date;
}

module.exports = {
  toBeijingClock, marketPhase, shouldPoll, latestExpectedTradingDate,
  PHASE_LABEL, T_AUCTION_START, T_AM_START, T_AM_END, T_PM_START, T_PM_END, T_BAR_SETTLE,
};
