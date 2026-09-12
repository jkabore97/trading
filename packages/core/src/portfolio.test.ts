import { describe, expect, it } from 'vitest';
import {
  applyPositionChange,
  grossNotional,
  intentQtyDelta,
  lastClose,
  markToMarketEquity,
} from './portfolio.js';
import type { Bar, Intent, Position } from './types.js';

const bar = (close: number): Bar => ({
  symbol: 'X',
  t: 0,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
});

describe('intentQtyDelta', () => {
  it('signs by side', () => {
    const base: Intent = {
      symbol: 'X',
      side: 'buy',
      qty: 5,
      type: 'market',
      timeInForce: 'day',
      reason: '',
    };
    expect(intentQtyDelta(base)).toBe(5);
    expect(intentQtyDelta({ ...base, side: 'sell' })).toBe(-5);
  });
});

describe('lastClose', () => {
  it('returns undefined for empty', () => {
    expect(lastClose([])).toBeUndefined();
    expect(lastClose(undefined)).toBeUndefined();
  });
  it('returns the newest close', () => {
    expect(lastClose([bar(1), bar(2), bar(3)])).toBe(3);
  });
});

describe('applyPositionChange', () => {
  it('opens a position', () => {
    const p = applyPositionChange({}, 'X', 10, 100);
    expect(p.X).toEqual({ symbol: 'X', qty: 10, avgEntryPrice: 100 });
  });
  it('averages on add in same direction', () => {
    let p = applyPositionChange({}, 'X', 10, 100);
    p = applyPositionChange(p, 'X', 10, 120);
    expect(p.X?.qty).toBe(20);
    expect(p.X?.avgEntryPrice).toBe(110);
  });
  it('keeps entry price when reducing', () => {
    let p = applyPositionChange({}, 'X', 10, 100);
    p = applyPositionChange(p, 'X', -4, 130);
    expect(p.X?.qty).toBe(6);
    expect(p.X?.avgEntryPrice).toBe(100);
  });
  it('closes to flat', () => {
    let p = applyPositionChange({}, 'X', 10, 100);
    p = applyPositionChange(p, 'X', -10, 130);
    expect(p.X).toBeUndefined();
  });
  it('re-bases entry when crossing zero', () => {
    let p = applyPositionChange({}, 'X', 10, 100);
    p = applyPositionChange(p, 'X', -15, 130);
    expect(p.X?.qty).toBe(-5);
    expect(p.X?.avgEntryPrice).toBe(130);
  });
});

describe('grossNotional & markToMarketEquity', () => {
  const positions: Record<string, Position> = {
    X: { symbol: 'X', qty: 10, avgEntryPrice: 100 },
    Y: { symbol: 'Y', qty: -5, avgEntryPrice: 50 },
  };
  it('sums absolute notional', () => {
    expect(grossNotional(positions, { X: 100, Y: 50 })).toBe(10 * 100 + 5 * 50);
  });
  it('skips symbols without a price', () => {
    expect(grossNotional(positions, { X: 100 })).toBe(1000);
  });
  it('marks equity to market', () => {
    expect(markToMarketEquity({ cash: 1000, positions }, { X: 100, Y: 50 })).toBe(
      1000 + 10 * 100 + -5 * 50,
    );
  });
});
