import type { Bar, MarketState, PortfolioState } from '@trading/core';
import { describe, expect, it } from 'vitest';
import { defaultConfig, sma, strategy } from './index.js';

function makeBars(closes: number[]): Bar[] {
  return closes.map((c, i) => ({
    symbol: 'X',
    t: i,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
  }));
}

function market(closes: number[]): MarketState {
  const bars = makeBars(closes);
  return { asOf: bars.length - 1, bars: { X: bars } };
}

const flat: PortfolioState = { cash: 100_000, equity: 100_000, positions: {} };
const config = { name: 'test', symbols: ['X'], params: { fast: 2, slow: 4, qty: 10 } };

describe('sma', () => {
  it('averages the last N closes', () => {
    expect(sma(makeBars([1, 2, 3, 4]), 2)).toBe(3.5);
  });
  it('returns undefined with too few bars', () => {
    expect(sma(makeBars([1]), 2)).toBeUndefined();
  });
});

describe('strategy purity & determinism', () => {
  it('returns the same intents for the same inputs', () => {
    const m = market([1, 2, 3, 4, 5, 6]);
    expect(strategy(m, flat, config)).toEqual(strategy(m, flat, config));
  });

  it('does not mutate its inputs', () => {
    const m = market([1, 2, 3, 4, 5, 6]);
    const snapshot = JSON.stringify(m);
    strategy(m, flat, config);
    expect(JSON.stringify(m)).toBe(snapshot);
  });
});

describe('strategy signals', () => {
  it('buys to target when fast SMA is above slow SMA and flat', () => {
    // Rising series -> fast > slow.
    const intents = strategy(market([1, 2, 3, 4, 5, 6]), flat, config);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ symbol: 'X', side: 'buy', qty: 10 });
  });

  it('emits nothing when already at target', () => {
    const held: PortfolioState = {
      cash: 100_000,
      equity: 100_000,
      positions: { X: { symbol: 'X', qty: 10, avgEntryPrice: 5 } },
    };
    const intents = strategy(market([1, 2, 3, 4, 5, 6]), held, config);
    expect(intents).toHaveLength(0);
  });

  it('sells to flat when fast SMA falls below slow SMA', () => {
    const held: PortfolioState = {
      cash: 100_000,
      equity: 100_000,
      positions: { X: { symbol: 'X', qty: 10, avgEntryPrice: 5 } },
    };
    // Falling series -> fast < slow.
    const intents = strategy(market([6, 5, 4, 3, 2, 1]), held, config);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ symbol: 'X', side: 'sell', qty: 10 });
  });

  it('refuses to trade on misconfiguration (fast >= slow)', () => {
    const bad = { ...config, params: { fast: 4, slow: 2, qty: 10 } };
    expect(strategy(market([1, 2, 3, 4, 5, 6]), flat, bad)).toEqual([]);
  });

  it('skips symbols without enough history', () => {
    expect(strategy(market([1, 2]), flat, config)).toEqual([]);
  });
});

describe('defaultConfig', () => {
  it('carries no risk parameters', () => {
    const c = defaultConfig(['AAPL']);
    expect(Object.keys(c.params)).toEqual(['fast', 'slow', 'qty']);
  });
});
