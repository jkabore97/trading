// Pure (de)serialization for the on-disk / in-R2 bar format.
//
// Format: newline-delimited JSON (NDJSON), one Bar object per line, ordered
// oldest-first. Chosen over Parquet because it is dependency-free, diff-friendly,
// streamable, and trivial to produce from any free data source. See DECISIONS.md.
//
// The R2 key convention is `bars/<interval>/<SYMBOL>.ndjson`, e.g.
// `bars/daily/AAPL.ndjson`. The backtester (LocalBarStore) and the worker
// (R2BarStore) both parse with the same function below, so a bar is a bar
// regardless of where it is read from.

import type { Bar } from './types.js';

/** Parse NDJSON text into Bars, skipping blank lines. Throws on a malformed line. */
export function parseBarsNdjson(text: string): Bar[] {
  const bars: Bar[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new Error(`bad NDJSON on line ${i + 1}: ${err instanceof Error ? err.message : err}`);
    }
    bars.push(assertBar(obj, i + 1));
  }
  return bars;
}

/** Serialize Bars to NDJSON (oldest-first, one per line, trailing newline). */
export function serializeBarsNdjson(bars: readonly Bar[]): string {
  return bars.length === 0
    ? ''
    : `${bars
        .map((b) =>
          JSON.stringify({
            symbol: b.symbol,
            t: b.t,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
          }),
        )
        .join('\n')}\n`;
}

function assertBar(obj: unknown, line: number): Bar {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error(`line ${line}: not an object`);
  }
  const b = obj as Record<string, unknown>;
  for (const key of ['t', 'open', 'high', 'low', 'close', 'volume'] as const) {
    if (typeof b[key] !== 'number' || !Number.isFinite(b[key])) {
      throw new Error(`line ${line}: field '${key}' is not a finite number`);
    }
  }
  if (typeof b.symbol !== 'string' || b.symbol.length === 0) {
    throw new Error(`line ${line}: field 'symbol' missing`);
  }
  return {
    symbol: b.symbol,
    t: b.t as number,
    open: b.open as number,
    high: b.high as number,
    low: b.low as number,
    close: b.close as number,
    volume: b.volume as number,
  };
}

/** Bars at or before `asOf`, oldest-first — the point-in-time slice for a decision. */
export function barsAsOf(bars: readonly Bar[], asOf: number): Bar[] {
  return bars.filter((b) => b.t <= asOf);
}
