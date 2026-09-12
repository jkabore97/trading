// The strategy module.
//
// THIS IS DELIBERATELY TRIVIAL. Its only job is to give the infrastructure
// something to run so that the machinery — risk gate, idempotency,
// reconciliation, backtest parity — is what gets tested, not a trading edge. Do
// not tune it. Do not add features hoping it makes money. If you want a real
// strategy, write a new module with this same signature and swap it in; the whole
// system is built so that is the only thing that changes.
//
// It is a PURE function: no I/O, no clock, no randomness, no network. Its only
// notion of "now" is `market.asOf`, and it only sees bars at or before that.
// Because of that, the backtester and the live Worker call it identically and it
// cannot tell which one it is running in.

import type {
  Bar,
  Intent,
  MarketState,
  PortfolioState,
  Strategy,
  StrategyConfig,
} from '@trading/core';

export const STRATEGY_NAME = 'sma-crossover-placeholder';

/** Simple moving average of the last `period` closes; undefined if too few bars. */
export function sma(bars: readonly Bar[], period: number): number | undefined {
  if (period <= 0 || bars.length < period) return undefined;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    sum += bars[i]?.close ?? 0;
  }
  return sum / period;
}

/**
 * Placeholder SMA-crossover: for each configured symbol, go long a fixed share
 * quantity when the fast SMA is above the slow SMA, and flat otherwise. Emits the
 * minimal intent to move from the current position to the target, so a held
 * position produces no order.
 *
 * Params:
 *   fast (default 10), slow (default 30), qty (default 10)
 */
export const strategy: Strategy = (
  market: MarketState,
  portfolio: PortfolioState,
  config: StrategyConfig,
): Intent[] => {
  const fast = intParam(config, 'fast', 10);
  const slow = intParam(config, 'slow', 30);
  const qty = intParam(config, 'qty', 10);
  if (fast >= slow) {
    // Misconfiguration: refuse to trade rather than emit nonsense.
    return [];
  }

  const intents: Intent[] = [];
  // Deterministic order: iterate symbols as configured (already stable).
  for (const symbol of config.symbols) {
    const bars = market.bars[symbol];
    if (!bars || bars.length < slow) continue;

    const fastMa = sma(bars, fast);
    const slowMa = sma(bars, slow);
    if (fastMa === undefined || slowMa === undefined) continue;

    const targetQty = fastMa > slowMa ? qty : 0;
    const currentQty = portfolio.positions[symbol]?.qty ?? 0;
    const delta = targetQty - currentQty;
    if (delta === 0) continue;

    intents.push({
      symbol,
      side: delta > 0 ? 'buy' : 'sell',
      qty: Math.abs(delta),
      type: 'market',
      timeInForce: 'day',
      reason:
        `fast(${fast})=${round(fastMa)} ${fastMa > slowMa ? '>' : '<='} slow(${slow})=${round(slowMa)}` +
        ` -> target ${targetQty}, have ${currentQty}`,
    });
  }
  return intents;
};

function intParam(config: StrategyConfig, key: string, fallback: number): number {
  const v = config.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Default config for the placeholder, used by the backtester and worker. */
export function defaultConfig(symbols: string[]): StrategyConfig {
  return { name: STRATEGY_NAME, symbols, params: { fast: 10, slow: 30, qty: 10 } };
}
