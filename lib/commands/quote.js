// lib/commands/quote.js — 实时行情快照（含换手/量比/PE/市值/涨跌停）
//
// 数据源：lib/data-source（Bridge 优先，失败自动降级 Node 直连 realhead）。
// 输出携带 来源/行情时间，收盘后还会校验"实时价 vs 最新 K 线 close"是否对不齐。

const { getFlag, inferMarket, fmtNum, renderKV, leadingPositional } = require('./helpers');
const { resolveName } = require('../cache');
const { fromContext } = require('../data-source');

/**
 * 实时行情快照
 * @param {object} ctx
 * @param {string[]} args - [code, --market N, --json, --source auto|bridge|direct]
 */
async function cmdQuote(ctx, args) {
  const code = leadingPositional(args);
  if (!code) throw new Error('用法: ths quote <code> [--market N] [--source auto|bridge|direct] [--json]');
  const market = getFlag(args, '--market', null) || inferMarket(code);
  if (!market) throw new Error('无法推断市场码，请用 --market 指定');
  const source = getFlag(args, '--source', null);

  ctx.audit.startOperation('quote', { code, market, source: source || 'auto' });

  const ds = fromContext(ctx, { strategy: source });
  let row;
  try {
    row = await ds.quote({ code, market });
  } catch (e) {
    ctx.audit.endOperation('error', {}, null, e);
    throw e;
  }
  if (!row) {
    ctx.audit.endOperation('error', {}, null, new Error('未返回行情数据'));
    const { codeExists } = require('../cache');
    const exists = await codeExists(ctx, code);
    if (exists === false) throw new Error(`代码 ${code} 不存在或已退市（可用 search 确认代码）`);
    if (exists === true) throw new Error(`代码 ${code} 可能停牌/暂无行情数据`);
    throw new Error(`未返回行情数据（代码 ${code} 不正确/停牌/已退市）`);
  }
  const name = row.name || (await resolveName(ctx, ctx.cache, code)) || null;
  ctx.audit.endOperation('success', { code: row.code, name, source: row.source }, { code, market });

  const out = { name, ...row };
  if (args.includes('--json')) return out;

  const sign = n => (n > 0 ? '+' : '') + n;
  const line = [
    { label: '名称', value: name || '-' },
    { label: '最新价', value: row.price },
    { label: '涨跌额', value: row.change != null ? sign(row.change) : '-' },
    { label: '涨跌幅', value: row.pct != null ? sign(row.pct) + '%' : '-' },
  ];
  const line2 = [
    { label: '开盘', value: row.open },
    { label: '最高', value: row.high },
    { label: '最低', value: row.low },
    { label: '昨收', value: row.prevClose },
  ];
  const line3 = [
    { label: '成交量', value: row.volume != null ? fmtNum(row.volume) + '股' : '-' },
    { label: '成交额', value: row.amount != null ? fmtNum(row.amount) : '-' },
    { label: '换手率', value: row.turnoverRate != null ? row.turnoverRate + '%' : '-' },
    { label: '量比', value: row.volumeRatio != null ? row.volumeRatio : '-' },
  ];
  const line4 = [
    { label: '市盈率', value: row.pe != null ? row.pe : '-' },
    { label: '市净率', value: row.pb != null ? row.pb : '-' },
    { label: '总市值', value: row.totalMv != null ? fmtNum(row.totalMv) : '-' },
    { label: '涨停/跌停', value: row.limitUp != null && row.limitDown != null ? `${row.limitUp} / ${row.limitDown}` : '-' },
    { label: '数据来源', value: `${row.source || '-'}${row.asOf ? ' · ' + row.asOf : ''}` },
  ];
  console.log(`${row.code}${name ? ' ' + name : ''} 实时行情 (market ${row.market})`);
  console.log(renderKV([...line, ...line2, ...line3, ...line4]));

  const stale = await consistencyWarn(ctx, code, market, row);
  if (stale) console.log(stale);
  return undefined;
}

/**
 * 数据信任护栏（M7-1-4）：收盘后实时价与"本地最新已收盘日 K"的 close 差异 > 0.5% 时提示。
 * 只看本地缓存（不额外打网络），盘中/K 线在途时跳过。
 * @returns {Promise<string|null>}
 */
async function consistencyWarn(ctx, code, market, row) {
  try {
    const { toBeijingClock, T_BAR_SETTLE } = require('../trading-hours');
    const clock = toBeijingClock();
    if (clock.wd === 0 || clock.wd === 6 || clock.minutes < T_BAR_SETTLE) return null;
    const entry = ctx.cache.getKline(`${code}_day_forward`);
    if (!entry || !Array.isArray(entry.bars) || !entry.bars.length) return null;
    const last = entry.bars[entry.bars.length - 1];
    if (!last || last.close == null || row.price == null || !(row.price > 0)) return null;
    if (String(last.date) !== clock.dateStr) return null; // 缓存不是今天的 → 交由陈旧提示处理
    const diff = Math.abs(row.price - last.close) / last.close;
    if (diff <= 0.005) return null;
    return `⚠ 数据校验: 实时价 ${row.price} 与最新 K 线 ${last.date} 收盘 ${last.close} 相差 ${(diff * 100).toFixed(2)}%——可能缓存陈旧/停牌/除权，判断前请先确认`;
  } catch (e) {
    return null;
  }
}

module.exports = cmdQuote;
