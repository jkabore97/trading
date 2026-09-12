import type { Order } from '@trading/core';
import { describe, expect, it, vi } from 'vitest';
import { AlpacaBroker } from './alpaca.js';
import { BrokerError } from './types.js';

const KEY = { keyId: 'PKTEST0000000000000', secretKey: 'x'.repeat(40) };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const order: Order = {
  clientOrderId: 'coid-1',
  symbol: 'AAPL',
  side: 'buy',
  qty: 10,
  type: 'market',
  timeInForce: 'day',
  submittedAt: 1,
};

const alpacaOrder = {
  id: 'brk-1',
  client_order_id: 'coid-1',
  symbol: 'AAPL',
  side: 'buy',
  qty: '10',
  filled_qty: '10',
  status: 'filled',
  limit_price: null,
  filled_avg_price: '100.5',
};

describe('AlpacaBroker construction', () => {
  it('refuses the live trading host', () => {
    expect(() => new AlpacaBroker({ ...KEY, baseUrl: 'https://api.alpaca.markets' })).toThrow(
      BrokerError,
    );
  });
  it('accepts the paper host', () => {
    expect(() => new AlpacaBroker(KEY)).not.toThrow();
  });
});

describe('AlpacaBroker submitOrder', () => {
  it('maps a filled order', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, alpacaOrder));
    const b = new AlpacaBroker({ ...KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    const o = await b.submitOrder(order);
    expect(o).toMatchObject({
      clientOrderId: 'coid-1',
      brokerOrderId: 'brk-1',
      status: 'filled',
      filledQty: 10,
      avgFillPrice: 100.5,
    });
    // Correct auth headers were sent.
    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall).toBeDefined();
    const init = firstCall?.[1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers['APCA-API-KEY-ID']).toBe(KEY.keyId);
  });

  it('treats a duplicate client_order_id as success by fetching the existing order', async () => {
    const fetchImpl = vi
      .fn()
      // POST -> 422 duplicate
      .mockResolvedValueOnce(jsonResponse(422, { message: 'client_order_id must be unique' }))
      // GET by client id -> existing order
      .mockResolvedValueOnce(jsonResponse(200, alpacaOrder));
    const b = new AlpacaBroker({ ...KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    const o = await b.submitOrder(order);
    expect(o.brokerOrderId).toBe('brk-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces auth errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { message: 'forbidden' }));
    const b = new AlpacaBroker({ ...KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(b.submitOrder(order)).rejects.toMatchObject({ code: 'auth' });
  });

  it('marks 5xx as retryable network errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { message: 'unavailable' }));
    const b = new AlpacaBroker({ ...KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(b.submitOrder(order)).rejects.toMatchObject({ retryable: true });
  });
});

describe('AlpacaBroker reads', () => {
  it('maps account fields', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { cash: '5000', equity: '6000', trading_blocked: false }),
      );
    const b = new AlpacaBroker({ ...KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await b.getAccount()).toEqual({ cash: 5000, equity: 6000, tradingBlocked: false });
  });

  it('returns null for an unknown client order id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { message: 'not found' }));
    const b = new AlpacaBroker({ ...KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await b.getOrderByClientId('nope')).toBeNull();
  });
});
