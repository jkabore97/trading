import { describe, expect, it } from 'vitest';
import { canonicalJson, clientOrderId, cyrb53, hashIntent } from './ids.js';
import type { Intent } from './types.js';

const intent: Intent = {
  symbol: 'AAPL',
  side: 'buy',
  qty: 10,
  type: 'market',
  timeInForce: 'day',
  reason: 'placeholder',
};

describe('canonicalJson', () => {
  it('is stable regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
});

describe('cyrb53', () => {
  it('is deterministic', () => {
    expect(cyrb53('hello')).toBe(cyrb53('hello'));
  });
  it('differs for different input', () => {
    expect(cyrb53('hello')).not.toBe(cyrb53('world'));
  });
});

describe('hashIntent', () => {
  it('ignores the human-readable reason', () => {
    const a = hashIntent(intent);
    const b = hashIntent({ ...intent, reason: 'a totally different reason' });
    expect(a).toBe(b);
  });
  it('changes when economics change', () => {
    expect(hashIntent(intent)).not.toBe(hashIntent({ ...intent, qty: 11 }));
  });
});

describe('clientOrderId', () => {
  it('is deterministic for the same decision (idempotency key)', () => {
    const a = clientOrderId('placeholder', 'AAPL', 1_700_000_000_000, intent);
    const b = clientOrderId('placeholder', 'AAPL', 1_700_000_000_000, intent);
    expect(a).toBe(b);
  });
  it('differs across bars', () => {
    const a = clientOrderId('placeholder', 'AAPL', 1_700_000_000_000, intent);
    const b = clientOrderId('placeholder', 'AAPL', 1_700_000_086_400, intent);
    expect(a).not.toBe(b);
  });
  it('only uses broker-safe characters', () => {
    const id = clientOrderId('my strat', 'BRK/B', 1_700_000_000_000, {
      ...intent,
      symbol: 'BRK/B',
    });
    expect(id).toMatch(/^[A-Za-z0-9_.-]+$/);
  });
});
