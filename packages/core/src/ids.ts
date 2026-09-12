// Deterministic identifiers and hashing.
//
// The idempotency guarantee for orders depends entirely on clientOrderId being a
// pure function of (strategy, symbol, bar timestamp, intent). No randomness, no
// clock. A retry of the same decision therefore produces the same id, and the
// broker will reject the duplicate — which we treat as success.
//
// The hash used here (cyrb53) is a fast, well-distributed NON-cryptographic
// hash. It is not used for any security purpose — only to fold an intent into a
// stable key. See DECISIONS.md.

import type { Intent } from './types.js';

/**
 * Stable JSON: object keys sorted recursively so logically-equal values always
 * serialise to the same string. Used as the input to intent hashing.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * cyrb53 — a 53-bit non-cryptographic hash by bryc (public domain). Returns a
 * fixed-width lowercase hex string so ids are stable across runtimes.
 */
export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

/** Hash of an intent's economically-meaningful fields (not `reason`). */
export function hashIntent(intent: Intent): string {
  const material = {
    symbol: intent.symbol,
    side: intent.side,
    qty: intent.qty,
    type: intent.type,
    limitPrice: intent.limitPrice ?? null,
    timeInForce: intent.timeInForce,
  };
  return cyrb53(canonicalJson(material));
}

/**
 * Deterministic client order id from (strategy, symbol, bar timestamp, intent
 * hash). Two identical decisions on the same bar produce the same id, so a retry
 * can never create a second order.
 *
 * Format: `<strategy>-<symbol>-<barTs>-<intentHash>`, sanitised to the character
 * set brokers accept for client order ids.
 */
export function clientOrderId(
  strategyName: string,
  symbol: string,
  barTs: number,
  intent: Intent,
): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${safe(strategyName)}-${safe(symbol)}-${barTs}-${hashIntent(intent)}`;
}
