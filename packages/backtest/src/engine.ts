// The backtest engine. Deterministic, no clock, no randomness, no I/O.
//
// It replays a timeline of bars through the SAME strategy function the live
// Worker runs, via the SAME buildMarketState construction. Decisions are made on
// a bar's close (asOf = close time) and filled at the NEXT bar's open — never the
// same bar's close — so there is no look-ahead. Costs are applied on every fill
// and subtracted from cash, so the equity curve (and every metric) is net.

import {
  type Bar,
  type Intent,
  type PortfolioState,
  type Position,
  type Strategy,
  type StrategyConfig,
  buildMarketState,
} from '@trading/core';
import { type CostModel, applyCosts } from './costs.js';
import { type EquityPoint, type Metrics, type RealizedTrade, computeMetrics } from './metrics.js';

export interface EngineParams {
  /** Full symbol histories, oldest-first. Sliced point-in-time internally. */
  bars: Record<string, Bar[]>;
  strategy: Strategy;
  config: StrategyConfig;
  costModel: CostModel;
  startingCash: number;
  /** Point-in-time lookback per symbol; MUST match the worker for parity. */
  lookback: number;
  /**
   * Optional explicit decision timeline (subset of bar timestamps). When given,
   * decisions/marks happen only on these timestamps while `bars` still provides
   * earlier history for warmup — this is how walk-forward test windows are run.
   * Defaults to every distinct bar timestamp.
   */
  timeline?: number[];
}

/** What the strategy emitted on one cycle — the unit the parity test compares. */
export interface CycleRecord {
  asOf: number;
  /** The exact PortfolioState fed to the strategy this cycle (for parity checks). */
  portfolio: PortfolioState;
  intents: Intent[];
}

export interface EngineResult {
  metrics: Metrics;
  curve: EquityPoint[];
  trades: RealizedTrade[];
  cycles: CycleRecord[];
}

export function runBacktest(params: EngineParams): EngineResult {
  const { bars, strategy, config, costModel, startingCash, lookback } = params;

  const timeline = params.timeline ?? buildTimeline(bars);
  const barAt = indexBars(bars);

  let cash = startingCash;
  let positions: Record<string, Position> = {};
  const curve: EquityPoint[] = [];
  const trades: RealizedTrade[] = [];
  const cycles: CycleRecord[] = [];
  let totalCostPaid = 0;
  let totalTradedNotional = 0;
  let fillCount = 0;

  for (let i = 0; i < timeline.length; i++) {
    const asOf = timeline[i] as number;

    // Mark-to-market equity at this bar's close.
    const marks = marksAt(bars, barAt, asOf);
    curve.push({ t: asOf, equity: markEquity(cash, positions, marks) });

    // Decide using the shared construction — identical to the Worker.
    const market = buildMarketState(bars, asOf, lookback);
    const portfolio: PortfolioState = {
      cash,
      equity: markEquity(cash, positions, marks),
      positions: clonePositions(positions),
    };
    const intents = strategy(market, portfolio, config);
    cycles.push({ asOf, portfolio, intents });

    // Execute at the next bar's open (no look-ahead). Last bar: no execution.
    const nextT = timeline[i + 1];
    if (nextT === undefined) continue;

    for (const intent of intents) {
      const next = barAt.get(intent.symbol)?.get(nextT);
      if (!next) continue; // no bar to fill against
      const ref = next.open;
      const { fillPrice, commission, totalCost } = applyCosts(
        costModel,
        intent.side,
        intent.qty,
        ref,
      );
      const signed = intent.side === 'buy' ? intent.qty : -intent.qty;

      const realized = realizedPnl(positions[intent.symbol], signed, fillPrice);
      if (realized !== undefined) {
        trades.push({ symbol: intent.symbol, t: nextT, qty: intent.qty, pnl: realized });
      }

      positions = applyFill(positions, intent.symbol, signed, fillPrice);
      cash -= signed * fillPrice + commission;
      totalCostPaid += totalCost;
      totalTradedNotional += intent.qty * ref;
      fillCount++;
    }
  }

  const metrics = computeMetrics(curve, trades, totalCostPaid, totalTradedNotional, fillCount);
  return { metrics, curve, trades, cycles };
}

// ---- helpers ---------------------------------------------------------------

function buildTimeline(bars: Record<string, Bar[]>): number[] {
  const set = new Set<number>();
  for (const list of Object.values(bars)) {
    for (const b of list) set.add(b.t);
  }
  return [...set].sort((a, b) => a - b);
}

function indexBars(bars: Record<string, Bar[]>): Map<string, Map<number, Bar>> {
  const idx = new Map<string, Map<number, Bar>>();
  for (const [symbol, list] of Object.entries(bars)) {
    const m = new Map<number, Bar>();
    for (const b of list) m.set(b.t, b);
    idx.set(symbol, m);
  }
  return idx;
}

/** Close of the bar at or before `asOf` for each symbol (for marking equity). */
function marksAt(
  bars: Record<string, Bar[]>,
  barAt: Map<string, Map<number, Bar>>,
  asOf: number,
): Record<string, number> {
  const marks: Record<string, number> = {};
  for (const symbol of Object.keys(bars)) {
    const exact = barAt.get(symbol)?.get(asOf);
    if (exact) {
      marks[symbol] = exact.close;
      continue;
    }
    // Fall back to the most recent close at or before asOf.
    const list = bars[symbol] ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i] as Bar;
      if (b.t <= asOf) {
        marks[symbol] = b.close;
        break;
      }
    }
  }
  return marks;
}

function markEquity(
  cash: number,
  positions: Record<string, Position>,
  marks: Record<string, number>,
): number {
  let equity = cash;
  for (const pos of Object.values(positions)) {
    const price = marks[pos.symbol];
    if (price !== undefined) equity += pos.qty * price;
  }
  return equity;
}

function clonePositions(positions: Record<string, Position>): Record<string, Position> {
  const out: Record<string, Position> = {};
  for (const [k, v] of Object.entries(positions)) out[k] = { ...v };
  return out;
}

/** Realised P&L on the portion of a fill that reduces an existing position. */
function realizedPnl(
  prev: Position | undefined,
  signedQty: number,
  fillPrice: number,
): number | undefined {
  if (!prev || prev.qty === 0) return undefined;
  const reducing = Math.sign(prev.qty) !== Math.sign(signedQty);
  if (!reducing) return undefined;
  const closedQty = Math.min(Math.abs(prev.qty), Math.abs(signedQty));
  // Long: (exit - entry) * qty. Short: (entry - exit) * qty = (exit-entry)*qty*sign.
  return (fillPrice - prev.avgEntryPrice) * closedQty * Math.sign(prev.qty);
}

/** Apply a fill to the positions map (avg-cost method). */
function applyFill(
  positions: Record<string, Position>,
  symbol: string,
  signedQty: number,
  price: number,
): Record<string, Position> {
  const next = { ...positions };
  const prev = next[symbol];
  const prevQty = prev?.qty ?? 0;
  const newQty = prevQty + signedQty;

  if (newQty === 0) {
    delete next[symbol];
    return next;
  }
  const crossedZero = prevQty !== 0 && Math.sign(prevQty) !== Math.sign(newQty);
  const adding = prevQty === 0 || Math.sign(prevQty) === Math.sign(signedQty);
  let avg: number;
  if (prevQty === 0 || crossedZero) {
    avg = price;
  } else if (adding) {
    const prevAvg = prev?.avgEntryPrice ?? price;
    avg = (prevAvg * Math.abs(prevQty) + price * Math.abs(signedQty)) / Math.abs(newQty);
  } else {
    avg = prev?.avgEntryPrice ?? price;
  }
  next[symbol] = { symbol, qty: newQty, avgEntryPrice: avg };
  return next;
}
