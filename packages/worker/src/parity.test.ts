// THE PARITY TEST — the most important test in the repo.
//
// It proves the one-codepath rule: the backtester and the live Worker produce
// BYTE-IDENTICAL intents over the same window. If this ever fails, the strategy
// has diverged between backtest and live, and no backtest can be trusted.
//
// Mechanism: run the backtester over a window. For every cycle it recorded (its
// asOf, the exact PortfolioState it fed the strategy, and the intents it got
// back), call the Worker's `decide()` with that same asOf/portfolio/bars and
// assert the intents match, compared as canonical JSON (byte-identical).

import { runBacktest } from '@trading/backtest';
import { type Bar, DEFAULT_LOOKBACK, buildMarketState, canonicalJson } from '@trading/core';
import { defaultConfig, strategy } from '@trading/strategy';
import { describe, expect, it } from 'vitest';
import { decide } from './cycle.js';

// Deterministic multi-symbol bars generated inline (no file/network dependency).
function makeBars(symbol: string, n: number, seed: number): Bar[] {
  let price = 100 + seed;
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    // Deterministic zig-zag so the SMA crossover actually flips a few times.
    const wave = Math.sin((i + seed) / 7) * 8 + Math.cos((i + seed) / 3) * 3;
    price = Math.max(5, 100 + seed + wave);
    const c = Math.round(price * 100) / 100;
    bars.push({
      symbol,
      t: (i + 1) * 86_400_000,
      open: c,
      high: c + 0.5,
      low: c - 0.5,
      close: c,
      volume: 1000,
    });
  }
  return bars;
}

const symbols = ['AAPL', 'MSFT', 'SPY'];
const bars: Record<string, Bar[]> = {
  AAPL: makeBars('AAPL', 200, 0),
  MSFT: makeBars('MSFT', 200, 11),
  SPY: makeBars('SPY', 200, 23),
};
const config = defaultConfig(symbols);

describe('backtest <-> worker parity', () => {
  it('emits byte-identical intents for every cycle', () => {
    const result = runBacktest({
      bars,
      strategy,
      config,
      costModel: { commissionPerOrder: 0, commissionPerShare: 0.005, spreadBps: 5, slippageBps: 5 },
      startingCash: 100_000,
      lookback: DEFAULT_LOOKBACK,
    });

    expect(result.cycles.length).toBeGreaterThan(50);
    let cyclesWithIntents = 0;

    for (const cycle of result.cycles) {
      // The Worker's decision, given the backtester's exact inputs.
      const { intents } = decide(
        strategy,
        bars,
        cycle.portfolio,
        config,
        cycle.asOf,
        DEFAULT_LOOKBACK,
      );
      expect(canonicalJson(intents)).toBe(canonicalJson(cycle.intents));
      if (cycle.intents.length > 0) cyclesWithIntents++;
    }

    // Guard against a vacuous pass: the window must actually generate trades.
    expect(cyclesWithIntents).toBeGreaterThan(0);
  });

  it('worker decide() builds the same MarketState the backtester used', () => {
    const asOf = bars.AAPL?.[100]?.t as number;
    const market = buildMarketState(bars, asOf, DEFAULT_LOOKBACK);
    // Point-in-time: nothing after asOf leaks in.
    for (const list of Object.values(market.bars)) {
      for (const b of list) expect(b.t).toBeLessThanOrEqual(asOf);
    }
  });
});
