import {
  type BrokerOrder,
  type Fill,
  type Order,
  type Position,
  applyPositionChange,
  markToMarketEquity,
} from '@trading/core';
import { type AccountSnapshot, type Broker, BrokerError } from './types.js';

export interface FakeBrokerOptions {
  /** Starting cash. Default 100_000. */
  startingCash?: number;
  /** One-directional slippage in basis points applied against the order. Default 0. */
  slippageBps?: number;
}

/**
 * An in-memory, fully deterministic broker for tests, the backtest wiring, and
 * the worker's default (fake) mode. It is NOT a market simulator — it fills
 * marketable orders immediately at the current mark (plus configurable slippage)
 * so that the *plumbing* around the broker (idempotency, reconciliation, kill
 * switch) is what gets exercised.
 *
 * Determinism: given the same marks and the same sequence of calls, it produces
 * the same results every time. No clock, no randomness of its own — timestamps
 * are supplied by the caller via `order.submittedAt`.
 */
export class FakeBroker implements Broker {
  readonly name = 'fake';

  private cash: number;
  private readonly slippageBps: number;
  private positions: Record<string, Position> = {};
  private marks: Record<string, number> = {};
  /** clientOrderId -> order (idempotency store). */
  private readonly ordersByClient = new Map<string, BrokerOrder>();
  private readonly ordersByBroker = new Map<string, BrokerOrder>();
  private readonly fills: Fill[] = [];
  private brokerSeq = 0;
  private tradingBlocked = false;

  /** When set, the next broker call throws this error, then clears. */
  private faultNext: BrokerError | null = null;

  constructor(opts: FakeBrokerOptions = {}) {
    this.cash = opts.startingCash ?? 100_000;
    this.slippageBps = opts.slippageBps ?? 0;
  }

  // ---- test / wiring helpers (not part of the Broker interface) --------------

  /** Set the current mark price for a symbol. Marketable orders fill against it. */
  setMark(symbol: string, price: number): void {
    this.marks[symbol] = price;
  }

  /** Force the next call to throw, to exercise retry/reconciliation paths. */
  failNext(error: BrokerError): void {
    this.faultNext = error;
  }

  /**
   * Directly seed a position without going through an order. Used to create a
   * deliberate broker/DB divergence for reconciliation tests.
   */
  seedPosition(symbol: string, qty: number, avgEntryPrice: number): void {
    if (qty === 0) delete this.positions[symbol];
    else this.positions[symbol] = { symbol, qty, avgEntryPrice };
  }

  /** Block trading at the account level, to test the tradingBlocked signal. */
  setTradingBlocked(blocked: boolean): void {
    this.tradingBlocked = blocked;
  }

  getFills(): readonly Fill[] {
    return this.fills;
  }

  // ---- Broker interface ------------------------------------------------------

  async getAccount(): Promise<AccountSnapshot> {
    this.maybeFault();
    return {
      cash: this.cash,
      equity: markToMarketEquity({ cash: this.cash, positions: this.positions }, this.marks),
      tradingBlocked: this.tradingBlocked,
    };
  }

  async getPositions(): Promise<Position[]> {
    this.maybeFault();
    return Object.values(this.positions).map((p) => ({ ...p }));
  }

  async getOpenOrders(): Promise<BrokerOrder[]> {
    this.maybeFault();
    return [...this.ordersByBroker.values()]
      .filter(
        (o) => o.status === 'new' || o.status === 'accepted' || o.status === 'partially_filled',
      )
      .map((o) => ({ ...o }));
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null> {
    this.maybeFault();
    const o = this.ordersByClient.get(clientOrderId);
    return o ? { ...o } : null;
  }

  async submitOrder(order: Order): Promise<BrokerOrder> {
    this.maybeFault();

    // Idempotency: a duplicate clientOrderId returns the existing order.
    const existing = this.ordersByClient.get(order.clientOrderId);
    if (existing) {
      return { ...existing };
    }

    if (this.tradingBlocked) {
      throw new BrokerError('trading blocked on account', 'rejected', false);
    }

    const brokerOrderId = `fake-${++this.brokerSeq}`;
    const mark = this.marks[order.symbol];

    let brokerOrder: BrokerOrder = {
      clientOrderId: order.clientOrderId,
      brokerOrderId,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      filledQty: 0,
      status: 'accepted',
      ...(order.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}),
    };

    if (mark === undefined) {
      // No price to fill against: leave it open and accepted.
      this.store(brokerOrder);
      return { ...brokerOrder };
    }

    const marketable = this.isMarketable(order, mark);
    if (marketable) {
      const fillPrice = this.fillPrice(order, mark);
      this.applyFill(order, brokerOrderId, fillPrice);
      brokerOrder = {
        ...brokerOrder,
        status: 'filled',
        filledQty: order.qty,
        avgFillPrice: fillPrice,
      };
    }

    this.store(brokerOrder);
    return { ...brokerOrder };
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    this.maybeFault();
    const o = this.ordersByBroker.get(brokerOrderId);
    if (!o) throw new BrokerError(`no such order ${brokerOrderId}`, 'not_found');
    if (o.status === 'new' || o.status === 'accepted' || o.status === 'partially_filled') {
      const canceled: BrokerOrder = { ...o, status: 'canceled' };
      this.ordersByBroker.set(brokerOrderId, canceled);
      this.ordersByClient.set(o.clientOrderId, canceled);
    }
  }

  async cancelAllOrders(): Promise<void> {
    this.maybeFault();
    for (const o of [...this.ordersByBroker.values()]) {
      if (o.status === 'new' || o.status === 'accepted' || o.status === 'partially_filled') {
        await this.cancelOrder(o.brokerOrderId);
      }
    }
  }

  async closeAllPositions(): Promise<BrokerOrder[]> {
    this.maybeFault();
    await this.cancelAllOrders();
    const results: BrokerOrder[] = [];
    for (const pos of Object.values(this.positions)) {
      const mark = this.marks[pos.symbol];
      if (mark === undefined) {
        throw new BrokerError(`cannot flatten ${pos.symbol}: no mark price`, 'rejected');
      }
      const side = pos.qty > 0 ? 'sell' : 'buy';
      const order: Order = {
        clientOrderId: `flatten-${pos.symbol}-${this.brokerSeq + 1}`,
        symbol: pos.symbol,
        side,
        qty: Math.abs(pos.qty),
        type: 'market',
        timeInForce: 'day',
        submittedAt: 0,
      };
      results.push(await this.submitOrder(order));
    }
    return results;
  }

  // ---- internals -------------------------------------------------------------

  private maybeFault(): void {
    if (this.faultNext) {
      const err = this.faultNext;
      this.faultNext = null;
      throw err;
    }
  }

  private store(o: BrokerOrder): void {
    this.ordersByBroker.set(o.brokerOrderId, o);
    this.ordersByClient.set(o.clientOrderId, o);
  }

  private isMarketable(order: Order, mark: number): boolean {
    if (order.type === 'market') return true;
    if (order.limitPrice === undefined) return false;
    return order.side === 'buy' ? mark <= order.limitPrice : mark >= order.limitPrice;
  }

  private fillPrice(order: Order, mark: number): number {
    // Slippage always works against the order.
    const slip = (this.slippageBps / 10_000) * mark;
    return order.side === 'buy' ? mark + slip : mark - slip;
  }

  private applyFill(order: Order, brokerOrderId: string, price: number): void {
    const signed = order.side === 'buy' ? order.qty : -order.qty;
    this.positions = applyPositionChange(this.positions, order.symbol, signed, price);
    this.cash -= signed * price;
    this.fills.push({
      clientOrderId: order.clientOrderId,
      brokerOrderId,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      price,
      filledAt: order.submittedAt,
    });
  }
}
