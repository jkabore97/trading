// Pure portfolio math shared by the risk gate, backtester and worker.

import type { Bar, PortfolioState, Position, Side } from './types.js';

/** Signed quantity delta a buy/sell of `qty` would apply to a position. */
export function intentQtyDelta(order: { side: Side; qty: number }): number {
  return order.side === 'buy' ? order.qty : -order.qty;
}

/** Latest known close for a symbol from a bar list (oldest-first). */
export function lastClose(bars: Bar[] | undefined): number | undefined {
  if (!bars || bars.length === 0) return undefined;
  return bars[bars.length - 1]?.close;
}

/**
 * Gross notional exposure: sum of |qty * price| across positions, using the
 * supplied price map (symbol -> mark price). Symbols with no price are skipped
 * and reported by the caller if that matters.
 */
export function grossNotional(
  positions: Record<string, Position>,
  prices: Record<string, number>,
): number {
  let total = 0;
  for (const pos of Object.values(positions)) {
    const price = prices[pos.symbol];
    if (price === undefined) continue;
    total += Math.abs(pos.qty * price);
  }
  return total;
}

/**
 * Apply a fill-like (symbol, signed qty, price) change to a positions map,
 * returning a new map. Used by the fake broker and backtester to keep books.
 * Averages entry price on adds; realises nothing here (P&L is computed
 * separately from cash flows).
 */
export function applyPositionChange(
  positions: Record<string, Position>,
  symbol: string,
  signedQty: number,
  price: number,
): Record<string, Position> {
  const next = { ...positions };
  const existing = next[symbol];
  const prevQty = existing?.qty ?? 0;
  const newQty = prevQty + signedQty;

  if (newQty === 0) {
    delete next[symbol];
    return next;
  }

  // Increasing (or opening) a position in the same direction re-averages entry.
  const sameDirection = prevQty === 0 || Math.sign(prevQty) === Math.sign(newQty);
  const crossedZero = prevQty !== 0 && Math.sign(prevQty) !== Math.sign(newQty);
  let avg: number;
  if (prevQty === 0 || crossedZero) {
    avg = price;
  } else if (sameDirection && Math.abs(newQty) > Math.abs(prevQty)) {
    const prevAvg = existing?.avgEntryPrice ?? price;
    avg = (prevAvg * Math.abs(prevQty) + price * Math.abs(signedQty)) / Math.abs(newQty);
  } else {
    // Reducing without crossing zero: entry price unchanged.
    avg = existing?.avgEntryPrice ?? price;
  }

  next[symbol] = { symbol, qty: newQty, avgEntryPrice: avg };
  return next;
}

/** Mark-to-market equity given cash, positions and a price map. */
export function markToMarketEquity(
  portfolio: Pick<PortfolioState, 'cash' | 'positions'>,
  prices: Record<string, number>,
): number {
  let equity = portfolio.cash;
  for (const pos of Object.values(portfolio.positions)) {
    const price = prices[pos.symbol];
    if (price === undefined) continue;
    equity += pos.qty * price;
  }
  return equity;
}
