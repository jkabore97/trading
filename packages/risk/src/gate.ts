// The risk gate — PURE logic. No storage, no clock, no network. The Durable
// Object (do.ts) is a thin stateful wrapper around these functions; testing the
// logic here exhaustively is what makes the gate trustworthy.
//
// Design principles:
//  * The strategy cannot reach any of this. Limits live in RiskConfig, passed in
//    by the operator's config, never by the strategy.
//  * Deny by default on anything ambiguous. A missing reference price is a denial,
//    not a guess.
//  * Limits are inclusive: reaching a limit exactly is allowed; exceeding it is not.

import {
  type Order,
  type Position,
  type RiskConfig,
  grossNotional,
  intentQtyDelta,
} from '@trading/core';

/** Mutable, persisted risk/loop state. Mirrored in D1; authoritative in the DO. */
export interface RiskState {
  /** Trading day (America/New_York YYYY-MM-DD) the counters below belong to. */
  tradingDay: string | null;
  /** Orders submitted so far today. */
  ordersToday: number;
  /** Account equity at the start of the trading day (baseline for daily loss). */
  dayStartEquity: number | null;
  /** Kill switch: when true, no orders are allowed until explicitly cleared. */
  killSwitchEngaged: boolean;
  /** Halted: set when a limit is breached (e.g. daily loss). Blocks new orders. */
  halted: boolean;
  /** Why we halted, for the operator. */
  haltReason: string | null;
}

export function initialRiskState(): RiskState {
  return {
    tradingDay: null,
    ordersToday: 0,
    dayStartEquity: null,
    killSwitchEngaged: false,
    halted: false,
    haltReason: null,
  };
}

export type DenyCode =
  | 'kill_switch'
  | 'halted'
  | 'max_orders_per_day'
  | 'max_daily_loss'
  | 'max_position_qty'
  | 'max_notional'
  | 'no_reference_price'
  | 'bad_order';

export type RiskDecision = { allowed: true } | { allowed: false; code: DenyCode; reason: string };

export interface EvaluateInput {
  config: RiskConfig;
  state: RiskState;
  order: Pick<Order, 'symbol' | 'side' | 'qty' | 'type' | 'limitPrice'>;
  /** Price used to value the order and resulting exposure. */
  refPrice: number | undefined;
  /** Current positions (our belief, already reconciled). */
  positions: Record<string, Position>;
  /** Current mark-to-market equity. */
  currentEquity: number;
  /** Mark prices for every held symbol, for gross-notional evaluation. */
  marks: Record<string, number>;
}

const ALLOW: RiskDecision = { allowed: true };
const deny = (code: DenyCode, reason: string): RiskDecision => ({ allowed: false, code, reason });

/**
 * Evaluate whether a single order may be submitted. Pure: does not mutate state
 * or count the order — the caller reserves the slot on an allow (see reserveOrder).
 */
export function evaluateOrder(input: EvaluateInput): RiskDecision {
  const { config, state, order, refPrice, positions, currentEquity, marks } = input;

  // Kill switch and halt come first: nothing gets through.
  if (config.killSwitchEngaged || state.killSwitchEngaged) {
    return deny('kill_switch', 'kill switch engaged');
  }
  if (state.halted) {
    return deny('halted', state.haltReason ?? 'trading halted');
  }

  // Order sanity.
  if (!Number.isFinite(order.qty) || order.qty <= 0) {
    return deny('bad_order', `non-positive qty ${order.qty}`);
  }
  if (order.type === 'limit' && (order.limitPrice === undefined || order.limitPrice <= 0)) {
    return deny('bad_order', 'limit order without a valid limit price');
  }
  if (refPrice === undefined || !Number.isFinite(refPrice) || refPrice <= 0) {
    return deny('no_reference_price', `no usable reference price for ${order.symbol}`);
  }

  // Orders-per-day.
  if (state.ordersToday >= config.maxOrdersPerDay) {
    return deny(
      'max_orders_per_day',
      `orders today ${state.ordersToday} >= limit ${config.maxOrdersPerDay}`,
    );
  }

  // Daily loss.
  if (state.dayStartEquity !== null) {
    const loss = state.dayStartEquity - currentEquity;
    if (loss >= config.maxDailyLoss) {
      return deny(
        'max_daily_loss',
        `daily loss ${loss.toFixed(2)} >= limit ${config.maxDailyLoss}`,
      );
    }
  }

  // Resulting per-symbol position size.
  const currentQty = positions[order.symbol]?.qty ?? 0;
  const resultingQty = currentQty + intentQtyDelta(order);
  if (Math.abs(resultingQty) > config.maxPositionQty) {
    return deny(
      'max_position_qty',
      `resulting |qty| ${Math.abs(resultingQty)} > limit ${config.maxPositionQty} for ${order.symbol}`,
    );
  }

  // Resulting gross notional exposure.
  const projected: Record<string, Position> = {
    ...positions,
    [order.symbol]: {
      symbol: order.symbol,
      qty: resultingQty,
      avgEntryPrice: positions[order.symbol]?.avgEntryPrice ?? refPrice,
    },
  };
  const projectedMarks = { ...marks, [order.symbol]: refPrice };
  const projectedNotional = grossNotional(projected, projectedMarks);
  if (projectedNotional > config.maxNotionalExposure) {
    return deny(
      'max_notional',
      `resulting gross notional ${projectedNotional.toFixed(2)} > limit ${config.maxNotionalExposure}`,
    );
  }

  return ALLOW;
}

/** Reserve one order slot after an allow. Pure: returns new state. */
export function reserveOrder(state: RiskState): RiskState {
  return { ...state, ordersToday: state.ordersToday + 1 };
}

/**
 * Roll the day over if `today` differs from the state's trading day: reset the
 * per-day counters and set the day's starting equity baseline. Kill switch
 * persists across days (it is a manual latch); halt is cleared on a new day only
 * if it was a same-day loss halt — but to be conservative we clear halt on
 * rollover so a fresh day can trade, EXCEPT the kill switch which never
 * auto-clears. Pure.
 */
export function rolloverIfNewDay(
  state: RiskState,
  today: string,
  currentEquity: number,
): RiskState {
  if (state.tradingDay === today) return state;
  return {
    tradingDay: today,
    ordersToday: 0,
    dayStartEquity: currentEquity,
    killSwitchEngaged: state.killSwitchEngaged, // manual latch, survives rollover
    halted: false,
    haltReason: null,
  };
}

/** Engage the kill switch: latch it on AND halt. Pure. Survives day rollover. */
export function engageKillState(state: RiskState, reason: string): RiskState {
  return {
    ...state,
    killSwitchEngaged: true,
    halted: true,
    haltReason: `kill switch: ${reason}`,
  };
}

/** Clear the kill switch and any halt — the manual "resume trading" latch. Pure. */
export function clearKillState(state: RiskState): RiskState {
  return { ...state, killSwitchEngaged: false, halted: false, haltReason: null };
}

/** Halt trading with a reason (e.g. reconciliation mismatch, daily loss). Pure. */
export function haltState(state: RiskState, reason: string): RiskState {
  return { ...state, halted: true, haltReason: reason };
}

/** Should trading halt right now because the daily loss limit is breached? Pure. */
export function shouldHaltForLoss(
  config: RiskConfig,
  state: RiskState,
  currentEquity: number,
): boolean {
  if (state.dayStartEquity === null) return false;
  return state.dayStartEquity - currentEquity >= config.maxDailyLoss;
}
