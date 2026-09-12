// Generate deterministic synthetic bar fixtures used by the backtester, the
// parity test, and local worker runs. Committed to the repo so CI needs no
// network. Re-run to regenerate; output is byte-stable for a given (symbol, days).
//
//   pnpm --filter @trading/scripts run gen:fixtures

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeBarsNdjson } from '@trading/core';
import { synthBars } from './lib/synth.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data', 'bars', 'daily');

const SYMBOLS = ['AAPL', 'MSFT', 'SPY'];
const DAYS = 600; // ~2.4 years of sessions

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const symbol of SYMBOLS) {
    const bars = synthBars(symbol, { days: DAYS });
    const path = join(OUT_DIR, `${symbol}.ndjson`);
    writeFileSync(path, serializeBarsNdjson(bars));
    console.log(`${symbol}: ${bars.length} bars -> ${path}`);
  }
}

main();
