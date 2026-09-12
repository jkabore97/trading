import type { BrokerOrder, Position } from '@trading/core';
import { describe, expect, it } from 'vitest';
import { diffOpenOrders, diffPositions, reconcile } from './reconcile.js';

const pos = (symbol: string, qty: number): Position => ({ symbol, qty, avgEntryPrice: 100 });
const bo = (clientOrderId: string): BrokerOrder => ({
  clientOrderId,
  brokerOrderId: `b-${clientOrderId}`,
  symbol: 'AAPL',
  side: 'buy',
  qty: 1,
  filledQty: 0,
  status: 'accepted',
});

describe('diffPositions', () => {
  it('reports no mismatch when equal', () => {
    expect(diffPositions({ AAPL: pos('AAPL', 10) }, [pos('AAPL', 10)])).toEqual([]);
  });
  it('flags a symbol the broker holds but we do not', () => {
    const d = diffPositions({}, [pos('TSLA', 5)]);
    expect(d).toEqual([{ symbol: 'TSLA', ours: 0, theirs: 5 }]);
  });
  it('flags a symbol we think we hold but the broker does not', () => {
    const d = diffPositions({ AAPL: pos('AAPL', 3) }, []);
    expect(d).toEqual([{ symbol: 'AAPL', ours: 3, theirs: 0 }]);
  });
  it('flags a quantity difference', () => {
    const d = diffPositions({ AAPL: pos('AAPL', 3) }, [pos('AAPL', 4)]);
    expect(d).toEqual([{ symbol: 'AAPL', ours: 3, theirs: 4 }]);
  });
});

describe('diffOpenOrders', () => {
  it('flags broker-only and ours-only open orders', () => {
    const d = diffOpenOrders(['a', 'b'], [bo('b'), bo('c')]);
    expect(d).toContainEqual({ clientOrderId: 'c', kind: 'broker_only' });
    expect(d).toContainEqual({ clientOrderId: 'a', kind: 'ours_only' });
    expect(d).toHaveLength(2);
  });
});

describe('reconcile', () => {
  it('ok when both sides agree', () => {
    const r = reconcile({ AAPL: pos('AAPL', 10) }, [pos('AAPL', 10)], ['x'], [bo('x')]);
    expect(r.ok).toBe(true);
  });
  it('not ok on any mismatch', () => {
    const r = reconcile({ AAPL: pos('AAPL', 10) }, [pos('AAPL', 9)], [], []);
    expect(r.ok).toBe(false);
  });
});
