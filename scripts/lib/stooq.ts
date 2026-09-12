// Pure parser for Stooq daily CSV -> Bar[].
//
// Stooq (https://stooq.com) offers free end-of-day CSV with no API key, which is
// why it is the default ingestion source. The CSV header is:
//   Date,Open,High,Low,Close,Volume
// Dates are calendar days; we timestamp each bar at the US market close
// (20:00 UTC ≈ 16:00 ET, ignoring DST — see the note in scripts/README / DECISIONS).

import type { Bar } from '@trading/core';

/** Milliseconds from UTC midnight to a nominal 20:00 UTC daily-bar timestamp. */
const CLOSE_OFFSET_MS = 20 * 60 * 60 * 1000;

export function stooqCsvToBars(symbol: string, csv: string): Bar[] {
  const lines = csv.trim().split('\n');
  if (lines.length === 0) return [];
  const header = lines[0]?.toLowerCase() ?? '';
  if (!header.startsWith('date,open,high,low,close')) {
    throw new Error(`unexpected Stooq CSV header for ${symbol}: ${lines[0]}`);
  }
  const bars: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]?.trim();
    if (!raw) continue;
    const cols = raw.split(',');
    if (cols.length < 5) continue;
    const [date, open, high, low, close, volume] = cols;
    const t = dayToEpochMs(date ?? '');
    if (t === undefined) continue; // skip 'N/D' or malformed rows
    const bar: Bar = {
      symbol,
      t,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: volume === undefined || volume === '' ? 0 : Number(volume),
    };
    if (![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) continue;
    bars.push(bar);
  }
  // Stooq returns oldest-first already, but sort defensively.
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

/** `YYYY-MM-DD` -> epoch ms at 20:00 UTC, or undefined if unparseable. */
export function dayToEpochMs(day: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const midnight = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(midnight)) return undefined;
  return midnight + CLOSE_OFFSET_MS;
}

/** Stooq download URL for a US symbol's full daily history. */
export function stooqDailyUrl(symbol: string): string {
  return `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol.toLowerCase())}.us&i=d`;
}
