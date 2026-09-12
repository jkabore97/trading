// Pessimistic cost model. Costs are ALWAYS applied against the trader. Defaults
// are deliberately conservative so a backtest never flatters itself: if a
// strategy only works with optimistic costs, that shows up here as a worse net
// number. All results downstream are reported net of these costs.

import type { Side } from '@trading/core';

export interface CostModel {
  /** Fixed commission charged per order, in currency. Default 0 (many US brokers). */
  commissionPerOrder: number;
  /** Commission per share, in currency. Default 0.005. */
  commissionPerShare: number;
  /** Full bid/ask spread in basis points; half is paid on each fill. Default 5 bps. */
  spreadBps: number;
  /** Extra slippage in basis points, always against the order. Default 5 bps. */
  slippageBps: number;
}

/** Conservative defaults. Change only with a reason. */
export const DEFAULT_COST_MODEL: CostModel = {
  commissionPerOrder: 0,
  commissionPerShare: 0.005,
  spreadBps: 5,
  slippageBps: 5,
};

export interface FillCost {
  /** Effective execution price after spread + slippage. */
  fillPrice: number;
  /** Explicit commission for the order. */
  commission: number;
  /**
   * Total cost paid versus the reference (mid) price: implicit
   * (spread+slippage) price impact plus explicit commission. Always >= 0.
   */
  totalCost: number;
}

/**
 * Compute the effective fill price and cost for executing `qty` shares of `side`
 * against a reference (mid) price. Spread and slippage move the price against the
 * order; commission is added on top.
 */
export function applyCosts(
  model: CostModel,
  side: Side,
  qty: number,
  referencePrice: number,
): FillCost {
  const impactBps = model.spreadBps / 2 + model.slippageBps;
  const impact = (impactBps / 10_000) * referencePrice;
  // Buys pay up, sells receive less.
  const fillPrice = side === 'buy' ? referencePrice + impact : referencePrice - impact;
  const commission = model.commissionPerOrder + model.commissionPerShare * qty;
  const implicitCost = Math.abs(fillPrice - referencePrice) * qty;
  return { fillPrice, commission, totalCost: implicitCost + commission };
}
