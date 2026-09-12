// Shared domain types for the whole trading system.
//
// These types are imported unchanged by the strategy, backtester, risk gate,
// broker adapters, worker and dashboard. Keeping them in one place is what makes
// the "one codepath" rule enforceable: the same MarketState / PortfolioState the
// backtester replays is the same shape the live Worker builds from fetched data.
//
// Money and prices are plain `number` (dollars). See DECISIONS.md for why, and
// for the precision caveats that follow from that choice.

/** Direction of an order or trade. */
export type Side = 'buy' | 'sell';

/** Order types we support. Deliberately minimal. */
export type OrderType = 'market' | 'limit';

/** Time-in-force. `day` orders expire at the close; `gtc` persist. */
export type TimeInForce = 'day' | 'gtc';

/** Where orders are actually routed. Never defaults to `live`. */
export type TradingMode = 'paper' | 'live';

/**
 * A single OHLCV bar. `t` is the bar's close timestamp in epoch milliseconds.
 * Bars are point-in-time: a bar with timestamp `t` is only known after `t`.
 */
export interface Bar {
  symbol: string;
  /** Bar close time, epoch milliseconds (UTC). */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Everything about the market the strategy is allowed to see, injected by the
 * caller. `asOf` is the ONLY clock the strategy has — it must never read the
 * wall clock. `bars[symbol]` holds history up to and including `asOf`, oldest
 * first. Nothing after `asOf` is present: this is the point-in-time guarantee.
 */
export interface MarketState {
  /** The "now" for this decision, epoch milliseconds. */
  asOf: number;
  /** Symbol -> bars up to and including `asOf`, ordered oldest first. */
  bars: Record<string, Bar[]>;
}

/** A held position. `qty` is signed: positive long, negative short. */
export interface Position {
  symbol: string;
  qty: number;
  /** Average entry price of the current position. */
  avgEntryPrice: number;
}

/** The account state injected into the strategy. */
export interface PortfolioState {
  /** Free cash in account currency. */
  cash: number;
  /** Total account equity (cash + mark-to-market positions). */
  equity: number;
  /** Symbol -> position. Symbols with no position may be absent. */
  positions: Record<string, Position>;
}

/**
 * A desired action emitted by the strategy. Intents are NOT orders: they carry
 * no client order id and have not passed the risk gate. `qty` is always a
 * positive share count; direction lives in `side`.
 */
export interface Intent {
  symbol: string;
  side: Side;
  qty: number;
  type: OrderType;
  /** Required when `type === 'limit'`. */
  limitPrice?: number;
  timeInForce: TimeInForce;
  /** Human-readable rationale, logged for offline replay. */
  reason: string;
}

/** An order as submitted to a broker. Carries the idempotency key. */
export interface Order {
  /** Deterministic idempotency key. See clientOrderId(). */
  clientOrderId: string;
  symbol: string;
  side: Side;
  qty: number;
  type: OrderType;
  limitPrice?: number;
  timeInForce: TimeInForce;
  /** When we submitted it, epoch milliseconds. */
  submittedAt: number;
}

/** Broker-side order lifecycle status, normalised across adapters. */
export type OrderStatus =
  | 'new'
  | 'accepted'
  | 'partially_filled'
  | 'filled'
  | 'canceled'
  | 'rejected'
  | 'expired'
  | 'unknown';

/** A broker's view of an order, used for reconciliation. */
export interface BrokerOrder {
  clientOrderId: string;
  brokerOrderId: string;
  symbol: string;
  side: Side;
  qty: number;
  filledQty: number;
  status: OrderStatus;
  limitPrice?: number;
  /** Average fill price so far, if any. */
  avgFillPrice?: number;
}

/** A fill (execution) reported by the broker. */
export interface Fill {
  clientOrderId: string;
  brokerOrderId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  /** Execution time, epoch milliseconds. */
  filledAt: number;
}

/**
 * Risk limits. This lives OUTSIDE the strategy and the strategy cannot read or
 * modify it — it is enforced by the risk gate (a Durable Object in production).
 */
export interface RiskConfig {
  /** Max absolute share count allowed per symbol. */
  maxPositionQty: number;
  /** Max gross notional (sum of |qty*price|) across all positions. */
  maxNotionalExposure: number;
  /** Max daily realised+unrealised loss (a positive number) before halting. */
  maxDailyLoss: number;
  /** Max number of orders that may be submitted in a single trading day. */
  maxOrdersPerDay: number;
  /** When true, the gate rejects every order until manually cleared. */
  killSwitchEngaged: boolean;
}

/** Parameters handed to the strategy. Contains NO risk limits by construction. */
export interface StrategyConfig {
  /** Stable identifier, part of the client order id. */
  name: string;
  /** Symbols the strategy is allowed to act on. */
  symbols: string[];
  /** Free-form numeric parameters for the strategy. */
  params: Record<string, number>;
}

/** The pure strategy function signature. Imported by backtest and worker alike. */
export type Strategy = (
  market: MarketState,
  portfolio: PortfolioState,
  config: StrategyConfig,
) => Intent[];
