import type { BrokerOrder, Order, Position } from '@trading/core';

/** Account-level snapshot used for reconciliation and equity marks. */
export interface AccountSnapshot {
  /** Free cash. */
  cash: number;
  /** Total equity (cash + positions). */
  equity: number;
  /** True if the broker has blocked trading on the account. */
  tradingBlocked: boolean;
}

/**
 * The broker abstraction. Implemented by the fake broker (tests, backtest wiring)
 * and the Alpaca paper adapter. The worker only ever talks to a `Broker`; it does
 * not know which implementation it holds.
 *
 * Every method is async and may throw `BrokerError`. `submitOrder` MUST be
 * idempotent on `order.clientOrderId`: submitting the same id twice returns the
 * existing order rather than creating a second one.
 */
export interface Broker {
  /** Human-readable name of the concrete implementation, for logs. */
  readonly name: string;

  getAccount(): Promise<AccountSnapshot>;
  getPositions(): Promise<Position[]>;
  /** Orders that are not in a terminal state. */
  getOpenOrders(): Promise<BrokerOrder[]>;
  /** Look up an order by our client id; null if the broker has never seen it. */
  getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null>;

  /**
   * Submit an order. Idempotent on `clientOrderId`: a duplicate submission
   * returns the already-existing order and never creates a second one.
   */
  submitOrder(order: Order): Promise<BrokerOrder>;

  cancelOrder(brokerOrderId: string): Promise<void>;
  cancelAllOrders(): Promise<void>;

  /**
   * Flatten every open position with market orders and return the resulting
   * orders. Used by the kill switch. Also cancels open orders first.
   */
  closeAllPositions(): Promise<BrokerOrder[]>;
}

/** Error class carrying a normalised code so callers can branch without string-matching. */
export class BrokerError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'network'
      | 'auth'
      | 'rate_limit'
      | 'rejected'
      | 'not_found'
      | 'unknown' = 'unknown',
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}
