// Pure performance metrics. Every return figure here is NET of costs, because the
// equity curve fed in is already net (the engine subtracts costs from cash).

/** One point on the equity curve. */
export interface EquityPoint {
  t: number;
  equity: number;
}

/** A realised (closed or reduced) trade's P&L, in currency. */
export interface RealizedTrade {
  symbol: string;
  t: number;
  qty: number;
  pnl: number;
}

export interface Metrics {
  startEquity: number;
  endEquity: number;
  /** Net total return over the whole period, as a fraction (0.1 = +10%). */
  totalReturn: number;
  /** Net return annualised assuming 252 trading days. */
  annualisedReturn: number;
  /** Max peak-to-trough drawdown as a positive fraction. */
  maxDrawdown: number;
  /** Annualised Sharpe (risk-free = 0), from per-bar returns. */
  sharpe: number;
  /** Winning closed trades / total closed trades. */
  hitRate: number;
  avgWin: number;
  avgLoss: number;
  /** Total traded notional / starting equity. */
  turnover: number;
  /** Sum of all costs paid (implicit + commission). */
  totalCostPaid: number;
  /** Number of fills executed. */
  fillCount: number;
  /** Number of realised (closing/reducing) trades. */
  closedTradeCount: number;
  /** Number of bars in the equity curve. */
  bars: number;
}

const TRADING_DAYS = 252;

export function computeMetrics(
  curve: readonly EquityPoint[],
  trades: readonly RealizedTrade[],
  totalCostPaid: number,
  totalTradedNotional: number,
  fillCount: number,
): Metrics {
  const startEquity = curve[0]?.equity ?? 0;
  const endEquity = curve[curve.length - 1]?.equity ?? startEquity;
  const bars = curve.length;

  const totalReturn = startEquity !== 0 ? endEquity / startEquity - 1 : 0;
  const annualisedReturn =
    startEquity > 0 && bars > 1 ? (endEquity / startEquity) ** (TRADING_DAYS / (bars - 1)) - 1 : 0;

  const maxDrawdown = computeMaxDrawdown(curve);
  const sharpe = computeSharpe(curve);

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const hitRate = trades.length > 0 ? wins.length / trades.length : 0;
  const avgWin = wins.length > 0 ? mean(wins.map((t) => t.pnl)) : 0;
  const avgLoss = losses.length > 0 ? mean(losses.map((t) => t.pnl)) : 0;
  const turnover = startEquity > 0 ? totalTradedNotional / startEquity : 0;

  return {
    startEquity,
    endEquity,
    totalReturn,
    annualisedReturn,
    maxDrawdown,
    sharpe,
    hitRate,
    avgWin,
    avgLoss,
    turnover,
    totalCostPaid,
    fillCount,
    closedTradeCount: trades.length,
    bars,
  };
}

export function computeMaxDrawdown(curve: readonly EquityPoint[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let maxDd = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (peak - p.equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

export function computeSharpe(curve: readonly EquityPoint[]): number {
  const rets: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1]?.equity ?? 0;
    const cur = curve[i]?.equity ?? 0;
    if (prev > 0) rets.push(cur / prev - 1);
  }
  if (rets.length < 2) return 0;
  const m = mean(rets);
  const sd = stddev(rets, m);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(TRADING_DAYS);
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: readonly number[], m: number): number {
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}
