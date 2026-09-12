import type { Bar, Strategy, StrategyConfig } from '@trading/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COST_MODEL, applyCosts } from './costs.js';
import { runBacktest } from './engine.js';
import { computeMaxDrawdown, computeMetrics, computeSharpe } from './metrics.js';
import { planWalkForward, timelineForRange } from './windows.js';

describe('applyCosts', () => {
  it('moves price against a buy and adds commission', () => {
    const c = applyCosts(DEFAULT_COST_MODEL, 'buy', 100, 100);
    expect(c.fillPrice).toBeGreaterThan(100);
    expect(c.commission).toBeCloseTo(0.005 * 100);
    expect(c.totalCost).toBeGreaterThan(0);
  });
  it('moves price against a sell', () => {
    const c = applyCosts(DEFAULT_COST_MODEL, 'sell', 100, 100);
    expect(c.fillPrice).toBeLessThan(100);
  });
  it('is symmetric in impact magnitude', () => {
    const buy = applyCosts(DEFAULT_COST_MODEL, 'buy', 10, 50);
    const sell = applyCosts(DEFAULT_COST_MODEL, 'sell', 10, 50);
    expect(buy.fillPrice - 50).toBeCloseTo(50 - sell.fillPrice);
  });
});

describe('metrics', () => {
  it('max drawdown of a peak then trough', () => {
    const dd = computeMaxDrawdown([
      { t: 0, equity: 100 },
      { t: 1, equity: 120 },
      { t: 2, equity: 90 },
      { t: 3, equity: 110 },
    ]);
    expect(dd).toBeCloseTo((120 - 90) / 120);
  });
  it('sharpe is zero for a flat curve', () => {
    expect(
      computeSharpe([
        { t: 0, equity: 100 },
        { t: 1, equity: 100 },
      ]),
    ).toBe(0);
  });
  it('computes net return and hit rate', () => {
    const m = computeMetrics(
      [
        { t: 0, equity: 100 },
        { t: 1, equity: 110 },
      ],
      [
        { symbol: 'X', t: 1, qty: 1, pnl: 5 },
        { symbol: 'X', t: 1, qty: 1, pnl: -2 },
      ],
      3,
      500,
      4,
    );
    expect(m.totalReturn).toBeCloseTo(0.1);
    expect(m.hitRate).toBeCloseTo(0.5);
    expect(m.avgWin).toBe(5);
    expect(m.avgLoss).toBe(-2);
    expect(m.totalCostPaid).toBe(3);
  });
});

describe('planWalkForward', () => {
  it('reserves the held-out tail and tiles non-overlapping test windows', () => {
    const split = planWalkForward(300, { trainBars: 100, testBars: 50, heldOutBars: 50 });
    expect(split.heldOut).toEqual({ start: 250, end: 300 });
    expect(split.development).toEqual({ start: 0, end: 250 });
    // Test segments must not overlap and must lie within development.
    for (let i = 1; i < split.windows.length; i++) {
      expect(split.windows[i]?.test.start).toBe(split.windows[i - 1]?.test.end);
    }
    for (const w of split.windows) {
      expect(w.test.end).toBeLessThanOrEqual(250);
      expect(w.train.end).toBe(w.test.start);
    }
  });
  it('rejects nonsense config', () => {
    expect(() => planWalkForward(100, { trainBars: 0, testBars: 10, heldOutBars: 0 })).toThrow();
  });
});

// A tiny deterministic strategy for engine tests: buy 1 share of X on the first
// eligible bar, then hold (no further intents once positioned).
const buyAndHold: Strategy = (market, portfolio) => {
  const held = portfolio.positions.X?.qty ?? 0;
  if (held > 0) return [];
  if ((market.bars.X?.length ?? 0) === 0) return [];
  return [
    { symbol: 'X', side: 'buy', qty: 1, type: 'market', timeInForce: 'day', reason: 'buy&hold' },
  ];
};

function ramp(prices: number[]): Bar[] {
  return prices.map((p, i) => ({
    symbol: 'X',
    t: i + 1,
    open: p,
    high: p,
    low: p,
    close: p,
    volume: 1,
  }));
}

const cfg: StrategyConfig = { name: 'test', symbols: ['X'], params: {} };

describe('engine', () => {
  it('fills at the NEXT bar open, not the same bar (no look-ahead)', () => {
    const bars = { X: ramp([10, 20, 30]) };
    const res = runBacktest({
      bars,
      strategy: buyAndHold,
      config: cfg,
      costModel: { commissionPerOrder: 0, commissionPerShare: 0, spreadBps: 0, slippageBps: 0 },
      startingCash: 1000,
      lookback: 50,
    });
    // Decision on bar t=1 (open 10) fills at bar t=2 open = 20, not 10.
    const fill = res.trades; // no realized trades (never sold)
    expect(fill).toHaveLength(0);
    // Cash reduced by 20 (bought 1 @ next open), one fill.
    expect(res.metrics.fillCount).toBe(1);
    // End equity = cash(1000-20) + 1*close(30) = 1010.
    expect(res.metrics.endEquity).toBeCloseTo(1010);
  });

  it('is deterministic (same inputs => identical cycles and metrics)', () => {
    const bars = { X: ramp([10, 11, 12, 13, 14]) };
    const params = {
      bars,
      strategy: buyAndHold,
      config: cfg,
      costModel: DEFAULT_COST_MODEL,
      startingCash: 1000,
      lookback: 50,
    };
    const a = runBacktest(params);
    const b = runBacktest(params);
    expect(JSON.stringify(a.cycles)).toBe(JSON.stringify(b.cycles));
    expect(a.metrics).toEqual(b.metrics);
  });

  it('applies costs so returns are net (costly run <= free run)', () => {
    const bars = { X: ramp([10, 11, 12, 13, 14]) };
    const free = runBacktest({
      bars,
      strategy: buyAndHold,
      config: cfg,
      costModel: { commissionPerOrder: 0, commissionPerShare: 0, spreadBps: 0, slippageBps: 0 },
      startingCash: 1000,
      lookback: 50,
    });
    const costly = runBacktest({
      bars,
      strategy: buyAndHold,
      config: cfg,
      costModel: DEFAULT_COST_MODEL,
      startingCash: 1000,
      lookback: 50,
    });
    expect(costly.metrics.endEquity).toBeLessThanOrEqual(free.metrics.endEquity);
    expect(costly.metrics.totalCostPaid).toBeGreaterThan(0);
  });

  it('restricted timeline evaluates only the window but still warms up on history', () => {
    const bars = { X: ramp([10, 11, 12, 13, 14, 15]) };
    const timeline = timelineForRange([1, 2, 3, 4, 5, 6], { start: 3, end: 6 });
    const res = runBacktest({
      bars,
      strategy: buyAndHold,
      config: cfg,
      costModel: DEFAULT_COST_MODEL,
      startingCash: 1000,
      lookback: 50,
      timeline,
    });
    // Curve covers only the 3 windowed bars.
    expect(res.curve.map((p) => p.t)).toEqual([4, 5, 6]);
  });
});
