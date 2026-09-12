import type { Order } from '@trading/core';
import { describe, expect, it } from 'vitest';
import { FakeBroker } from './fake.js';
import { BrokerError } from './types.js';

const order = (over: Partial<Order> = {}): Order => ({
  clientOrderId: 'coid-1',
  symbol: 'AAPL',
  side: 'buy',
  qty: 10,
  type: 'market',
  timeInForce: 'day',
  submittedAt: 1,
  ...over,
});

describe('FakeBroker fills', () => {
  it('fills a market buy at the mark and updates cash/position', async () => {
    const b = new FakeBroker({ startingCash: 10_000 });
    b.setMark('AAPL', 100);
    const o = await b.submitOrder(order());
    expect(o.status).toBe('filled');
    expect(o.avgFillPrice).toBe(100);
    const acct = await b.getAccount();
    expect(acct.cash).toBe(10_000 - 1000);
    const [pos] = await b.getPositions();
    expect(pos).toMatchObject({ symbol: 'AAPL', qty: 10, avgEntryPrice: 100 });
  });

  it('applies slippage against the order', async () => {
    const b = new FakeBroker({ slippageBps: 10 }); // 0.10%
    b.setMark('AAPL', 100);
    const buy = await b.submitOrder(order());
    expect(buy.avgFillPrice).toBeCloseTo(100.1);
    const sell = await b.submitOrder(order({ clientOrderId: 'coid-2', side: 'sell', qty: 5 }));
    expect(sell.avgFillPrice).toBeCloseTo(99.9);
  });

  it('leaves an order open when there is no mark', async () => {
    const b = new FakeBroker();
    const o = await b.submitOrder(order());
    expect(o.status).toBe('accepted');
    expect(await b.getOpenOrders()).toHaveLength(1);
  });

  it('only fills marketable limit orders', async () => {
    const b = new FakeBroker();
    b.setMark('AAPL', 100);
    const notMarketable = await b.submitOrder(
      order({ clientOrderId: 'lim-1', type: 'limit', limitPrice: 90 }),
    );
    expect(notMarketable.status).toBe('accepted');
    const marketable = await b.submitOrder(
      order({ clientOrderId: 'lim-2', type: 'limit', limitPrice: 110 }),
    );
    expect(marketable.status).toBe('filled');
    expect(marketable.avgFillPrice).toBe(100);
  });
});

describe('FakeBroker idempotency', () => {
  it('returns the same order for a duplicate clientOrderId and does not double-fill', async () => {
    const b = new FakeBroker({ startingCash: 10_000 });
    b.setMark('AAPL', 100);
    const first = await b.submitOrder(order());
    const second = await b.submitOrder(order());
    expect(second.brokerOrderId).toBe(first.brokerOrderId);
    const acct = await b.getAccount();
    expect(acct.cash).toBe(9000); // charged once
    expect((await b.getPositions())[0]?.qty).toBe(10);
  });
});

describe('FakeBroker fault injection', () => {
  it('throws the injected error once, then recovers', async () => {
    const b = new FakeBroker();
    b.setMark('AAPL', 100);
    b.failNext(new BrokerError('boom', 'network', true));
    await expect(b.submitOrder(order())).rejects.toBeInstanceOf(BrokerError);
    // Next call succeeds.
    const o = await b.submitOrder(order());
    expect(o.status).toBe('filled');
  });

  it('rejects submissions when trading is blocked', async () => {
    const b = new FakeBroker();
    b.setMark('AAPL', 100);
    b.setTradingBlocked(true);
    await expect(b.submitOrder(order())).rejects.toMatchObject({ code: 'rejected' });
  });
});

describe('FakeBroker closeAllPositions (kill switch flatten)', () => {
  it('flattens long and short positions to zero', async () => {
    const b = new FakeBroker();
    b.setMark('AAPL', 100);
    b.setMark('TSLA', 200);
    await b.submitOrder(order({ clientOrderId: 'a', symbol: 'AAPL', side: 'buy', qty: 10 }));
    await b.submitOrder(order({ clientOrderId: 'b', symbol: 'TSLA', side: 'sell', qty: 4 }));
    expect(await b.getPositions()).toHaveLength(2);

    const results = await b.closeAllPositions();
    expect(results.every((o) => o.status === 'filled')).toBe(true);
    expect(await b.getPositions()).toHaveLength(0);
  });

  it('refuses to flatten a symbol with no mark (fails loudly, no silent skip)', async () => {
    const b = new FakeBroker();
    b.setMark('AAPL', 100);
    await b.submitOrder(order({ symbol: 'AAPL', qty: 10 }));
    b.seedPosition('ZZZ', 5, 10); // no mark for ZZZ
    await expect(b.closeAllPositions()).rejects.toBeInstanceOf(BrokerError);
  });
});
