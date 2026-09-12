import { describe, expect, it } from 'vitest';
import { barsAsOf, parseBarsNdjson, serializeBarsNdjson } from './bars.js';
import type { Bar } from './types.js';

const bars: Bar[] = [
  { symbol: 'AAPL', t: 1, open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
  { symbol: 'AAPL', t: 2, open: 10.5, high: 12, low: 10, close: 11, volume: 120 },
];

describe('bars NDJSON round-trip', () => {
  it('serializes and parses back to equal bars', () => {
    const text = serializeBarsNdjson(bars);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseBarsNdjson(text)).toEqual(bars);
  });

  it('serializes empty as empty string', () => {
    expect(serializeBarsNdjson([])).toBe('');
    expect(parseBarsNdjson('')).toEqual([]);
  });

  it('skips blank lines', () => {
    const text = `${JSON.stringify(bars[0])}\n\n${JSON.stringify(bars[1])}\n`;
    expect(parseBarsNdjson(text)).toEqual(bars);
  });

  it('throws on malformed JSON with a line number', () => {
    expect(() => parseBarsNdjson('{not json}')).toThrow(/line 1/);
  });

  it('throws when a numeric field is missing', () => {
    const bad = JSON.stringify({ symbol: 'X', t: 1, open: 1, high: 1, low: 1, close: 1 });
    expect(() => parseBarsNdjson(bad)).toThrow(/volume/);
  });
});

describe('barsAsOf', () => {
  it('returns only bars at or before asOf', () => {
    expect(barsAsOf(bars, 1)).toEqual([bars[0]]);
    expect(barsAsOf(bars, 2)).toEqual(bars);
    expect(barsAsOf(bars, 0)).toEqual([]);
  });
});
