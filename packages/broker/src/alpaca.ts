import type { BrokerOrder, Order, OrderStatus, Position, Side } from '@trading/core';
import { type AccountSnapshot, type Broker, BrokerError } from './types.js';

/**
 * Alpaca adapter — PAPER endpoint only by construction. There is no code path in
 * this file that talks to the live trading host; going live is a deliberate,
 * documented change (see GOING_LIVE.md), not a config typo.
 *
 * REST over `fetch`. `fetch` is injectable so the adapter is fully unit-testable
 * without network access.
 */

const PAPER_BASE = 'https://paper-api.alpaca.markets';

export interface AlpacaConfig {
  keyId: string;
  secretKey: string;
  /**
   * Base URL. Defaults to the paper host. Provided so tests can point at a stub;
   * NOT a knob for switching to live — see the guard in the constructor.
   */
  baseUrl?: string;
  /** Injected fetch, defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

type FetchLike = typeof fetch;

interface AlpacaOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  side: Side;
  qty: string;
  filled_qty: string;
  status: string;
  limit_price: string | null;
  filled_avg_price: string | null;
}

interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
}

export class AlpacaBroker implements Broker {
  readonly name = 'alpaca-paper';

  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(config: AlpacaConfig) {
    const base = config.baseUrl ?? PAPER_BASE;
    // Hard refuse the live host. Live trading is a documented manual step, never
    // reachable by pointing this adapter at the live URL.
    if (base.includes('api.alpaca.markets') && !base.includes('paper-api')) {
      throw new BrokerError(
        'AlpacaBroker refuses the live trading host; this adapter is paper-only',
        'auth',
      );
    }
    this.baseUrl = base.replace(/\/$/, '');
    // Bind the global fetch to its realm. Calling an unbound global `fetch` as a
    // method (`this.fetchImpl(...)`) throws "Illegal invocation" in Cloudflare
    // Workers because it loses its `this`. An injected fetch (tests) is used as-is.
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
    this.headers = {
      'APCA-API-KEY-ID': config.keyId,
      'APCA-API-SECRET-KEY': config.secretKey,
      'Content-Type': 'application/json',
    };
  }

  async getAccount(): Promise<AccountSnapshot> {
    const a = await this.request<{ cash: string; equity: string; trading_blocked: boolean }>(
      'GET',
      '/v2/account',
    );
    return {
      cash: Number(a.cash),
      equity: Number(a.equity),
      tradingBlocked: Boolean(a.trading_blocked),
    };
  }

  async getPositions(): Promise<Position[]> {
    const positions = await this.request<AlpacaPosition[]>('GET', '/v2/positions');
    return positions.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      avgEntryPrice: Number(p.avg_entry_price),
    }));
  }

  async getOpenOrders(): Promise<BrokerOrder[]> {
    const orders = await this.request<AlpacaOrder[]>('GET', '/v2/orders?status=open&limit=500');
    return orders.map(mapOrder);
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null> {
    try {
      const o = await this.request<AlpacaOrder>(
        'GET',
        `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
      );
      return mapOrder(o);
    } catch (err) {
      if (err instanceof BrokerError && err.code === 'not_found') return null;
      throw err;
    }
  }

  async submitOrder(order: Order): Promise<BrokerOrder> {
    const body = {
      symbol: order.symbol,
      qty: String(order.qty),
      side: order.side,
      type: order.type,
      time_in_force: order.timeInForce,
      client_order_id: order.clientOrderId,
      ...(order.limitPrice !== undefined ? { limit_price: String(order.limitPrice) } : {}),
    };
    try {
      const o = await this.request<AlpacaOrder>('POST', '/v2/orders', body);
      return mapOrder(o);
    } catch (err) {
      // Idempotency: a duplicate client_order_id is success. Alpaca returns 422
      // with a "client_order_id ... already exists"/"must be unique" message.
      if (err instanceof BrokerError && err.code === 'rejected' && isDuplicateId(err.message)) {
        const existing = await this.getOrderByClientId(order.clientOrderId);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await this.request('DELETE', `/v2/orders/${encodeURIComponent(brokerOrderId)}`);
  }

  async cancelAllOrders(): Promise<void> {
    await this.request('DELETE', '/v2/orders');
  }

  async closeAllPositions(): Promise<BrokerOrder[]> {
    // cancel_orders=true also cancels open orders as part of the liquidation.
    const result = await this.request<Array<{ status: number; body: AlpacaOrder }>>(
      'DELETE',
      '/v2/positions?cancel_orders=true',
    );
    return result.filter((r) => r.status >= 200 && r.status < 300).map((r) => mapOrder(r.body));
  }

  // ---- HTTP ------------------------------------------------------------------

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new BrokerError(
        `network error calling Alpaca: ${err instanceof Error ? err.message : String(err)}`,
        'network',
        true,
      );
    }

    if (res.status === 404) {
      throw new BrokerError(`not found: ${method} ${path}`, 'not_found');
    }
    if (res.status === 401 || res.status === 403) {
      throw new BrokerError('Alpaca auth failed', 'auth');
    }
    if (res.status === 429) {
      throw new BrokerError('Alpaca rate limited', 'rate_limit', true);
    }
    if (!res.ok) {
      const text = await safeText(res);
      const retryable = res.status >= 500;
      throw new BrokerError(
        `Alpaca ${res.status}: ${text}`,
        retryable ? 'network' : 'rejected',
        retryable,
      );
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

function isDuplicateId(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('client_order_id') && (m.includes('exist') || m.includes('unique'));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}

function mapStatus(s: string): OrderStatus {
  switch (s) {
    case 'new':
    case 'pending_new':
    case 'accepted_for_bidding':
      return 'new';
    case 'accepted':
    case 'pending_replace':
    case 'pending_cancel':
    case 'replaced':
    case 'held':
      return 'accepted';
    case 'partially_filled':
      return 'partially_filled';
    case 'filled':
      return 'filled';
    case 'canceled':
    case 'done_for_day':
    case 'stopped':
    case 'suspended':
      return 'canceled';
    case 'expired':
      return 'expired';
    case 'rejected':
      return 'rejected';
    default:
      return 'unknown';
  }
}

function mapOrder(o: AlpacaOrder): BrokerOrder {
  return {
    clientOrderId: o.client_order_id,
    brokerOrderId: o.id,
    symbol: o.symbol,
    side: o.side,
    qty: Number(o.qty),
    filledQty: Number(o.filled_qty),
    status: mapStatus(o.status),
    ...(o.limit_price !== null ? { limitPrice: Number(o.limit_price) } : {}),
    ...(o.filled_avg_price !== null ? { avgFillPrice: Number(o.filled_avg_price) } : {}),
  };
}
