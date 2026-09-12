// Deterministic synthetic daily bars.
//
// Used to generate committed fixtures so the backtest, parity test and worker
// wiring run offline and reproducibly in CI. NOT a market model — just a smooth,
// seeded price path so the plumbing has data to chew on. Same seed => same bars,
// forever, on any machine.

import type { Bar } from '@trading/core';
import { dayToEpochMs } from './stooq.ts';

/** Small seeded PRNG (mulberry32) so runs are reproducible without a dependency. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stringSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface SynthOptions {
  /** Number of daily bars. */
  days: number;
  /** Starting price. Default 100. */
  start?: number;
  /** First bar's calendar day (YYYY-MM-DD). Default 2022-01-03. */
  startDay?: string;
}

/**
 * Generate `days` daily bars for `symbol`. The path is a gentle mean-reverting
 * random walk seeded from the symbol name, so different symbols differ but each
 * is stable across runs. Weekends are skipped so timestamps look like sessions.
 */
export function synthBars(symbol: string, opts: SynthOptions): Bar[] {
  const rand = mulberry32(stringSeed(symbol));
  const start = opts.start ?? 100;
  const startDayMs = dayToEpochMs(opts.startDay ?? '2022-01-03');
  if (startDayMs === undefined) throw new Error('bad startDay');

  const bars: Bar[] = [];
  let price = start;
  let cursor = startDayMs;
  const DAY = 24 * 60 * 60 * 1000;

  while (bars.length < opts.days) {
    const dow = new Date(cursor).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const drift = (start - price) * 0.01; // mild mean reversion toward start
      const shock = (rand() - 0.5) * price * 0.02; // ~2% daily range
      const open = round2(price);
      const close = round2(Math.max(1, price + drift + shock));
      const high = round2(Math.max(open, close) + rand() * price * 0.005);
      const low = round2(Math.min(open, close) - rand() * price * 0.005);
      const volume = 1_000_000 + Math.floor(rand() * 500_000);
      bars.push({ symbol, t: cursor, open, high, low, close, volume });
      price = close;
    }
    cursor += DAY;
  }
  return bars;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
