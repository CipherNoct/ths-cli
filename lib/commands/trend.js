// lib/commands/trend.js — 分时数据
//
// 数据源：lib/data-source（Bridge single_trend 优先；失败降级直连 v6/time）。

const { getFlag, inferMarket, fmtNum, renderTable, toCsv, leadingPositional } = require('./helpers');
const { fromContext } = require('../data-source');

/**
 * 分时
 * @param {object} ctx
 * @param {string[]} args - [code, --count N, --market N, --source ...] [--json|--csv]
 */
async function cmdTrend(ctx, args) {
  const code = leadingPositional(args);
  if (!code) throw new Error('用法: ths trend <code> [--count N] [--market N] [--source ...] [--json|--csv]');
  const market = getFlag(args, '--market', null) || inferMarket(code);
  if (!market) throw new Error('无法推断市场码，请用 --market 指定');
  const count = Math.max(0, parseInt(getFlag(args, '--count', 0), 10) || 0);
  const source = getFlag(args, '--source', null);

  ctx.audit.startOperation('trend', { code, market, count, source: source || 'auto' });

  const ds = fromContext(ctx, { strategy: source });
  let rows;
  try {
    rows = await ds.trend({ code, market, count });
  } catch (e) {
    ctx.audit.endOperation('error', {}, null, e);
    throw e;
  }
  ctx.audit.endOperation('success', { points: rows.length, source: rows.source }, { code, market });
  if (!rows.length) throw new Error('未返回分时数据');

  if (args.includes('--json')) {
    return { source: rows.source || null, asOf: rows.asOf || null, points: rows };
  }

  const cols = [
    { header: '时间', key: 'time' },
    { header: '价格', key: 'price', align: 'r', fmt: v => (v == null ? '-' : fmtNum(v)) },
    { header: '成交量', key: 'volume', align: 'r', fmt: v => (v == null ? '-' : fmtNum(v)) },
    { header: '成交额', key: 'amount', align: 'r', fmt: v => (v == null ? '-' : fmtNum(v)) },
  ];

  if (args.includes('--csv')) {
    console.log(toCsv(rows, cols));
    return undefined;
  }

  const srcTag = rows.source ? ` · 来源: ${rows.source}${rows.asOf ? ' · ' + rows.asOf : ''}` : '';
  console.log(`分时 ${code} 共 ${rows.length} 个点${srcTag}`);
  console.log(renderTable(rows, cols));
  return undefined;
}

module.exports = cmdTrend;
