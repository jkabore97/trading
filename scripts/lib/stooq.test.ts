import { describe, expect, it } from 'vitest';
import { dayToEpochMs, stooqCsvToBars, stooqDailyUrl } from './stooq.ts';

const csv = `Date,Open,High,Low,Close,Volume
2024-01-02,10.0,10.5,9.8,10.2,1000
2024-01-03,10.2,10.7,10.1,10.6,1200
`;

describe('stooqCsvToBars', () => {
  it('parses rows into bars with UTC close timestamps', () => {
    const bars = stooqCsvToBars('AAPL', csv);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({
      symbol: 'AAPL',
      open: 10,
      high: 10.5,
      low: 9.8,
      close: 10.2,
      volume: 1000,
    });
    expect(bars[0]?.t).toBe(dayToEpochMs('2024-01-02'));
    expect(bars[1]?.t).toBeGreaterThan(bars[0]?.t ?? 0);
  });

  it('throws on an unexpected header', () => {
    expect(() => stooqCsvToBars('X', 'foo,bar\n1,2')).toThrow(/header/);
  });

  it('skips N/D and malformed rows', () => {
    const bad = `Date,Open,High,Low,Close,Volume
N/D,N/D,N/D,N/D,N/D,N/D
2024-01-02,10,11,9,10.5,5
`;
    const bars = stooqCsvToBars('X', bad);
    expect(bars).toHaveLength(1);
  });
});

describe('dayToEpochMs', () => {
  it('returns undefined for junk', () => {
    expect(dayToEpochMs('N/D')).toBeUndefined();
    expect(dayToEpochMs('2024/01/02')).toBeUndefined();
  });
});

describe('stooqDailyUrl', () => {
  it('builds a lowercase .us url', () => {
    expect(stooqDailyUrl('AAPL')).toBe('https://stooq.com/q/d/l/?s=aapl.us&i=d');
  });
});
