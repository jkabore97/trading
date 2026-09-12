// Human-readable reporting. Numbers are reported plainly — never characterised as
// good, bad, or promising. Cost paid is always printed next to net return.

import type { Metrics } from './metrics.js';

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}
function money(x: number): string {
  return `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
}

export function formatMetrics(label: string, m: Metrics): string {
  const lines = [
    `=== ${label} ===`,
    `bars:                ${m.bars}`,
    `start equity:        ${money(m.startEquity)}`,
    `end equity:          ${money(m.endEquity)}`,
    `net total return:    ${pct(m.totalReturn)}    (total cost paid: ${money(m.totalCostPaid)})`,
    `net annualised:      ${pct(m.annualisedReturn)}`,
    `max drawdown:        ${pct(m.maxDrawdown)}`,
    `sharpe (ann.):       ${m.sharpe.toFixed(3)}`,
    `hit rate:            ${pct(m.hitRate)}  (${m.closedTradeCount} closed trades)`,
    `avg win / avg loss:  ${money(m.avgWin)} / ${money(m.avgLoss)}`,
    `turnover:            ${m.turnover.toFixed(2)}x`,
    `fills:               ${m.fillCount}`,
  ];
  return lines.join('\n');
}
