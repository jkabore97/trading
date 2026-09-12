// Local bar source: reads the NDJSON files produced by ingestion/fixtures from
// disk. The worker's R2BarStore reads the same format from R2. Both go through
// core's parseBarsNdjson, so a bar is a bar regardless of origin.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Bar, parseBarsNdjson } from '@trading/core';

export interface LocalBarStoreOptions {
  /** Directory containing `<SYMBOL>.ndjson` files. */
  dir: string;
}

export class LocalBarStore {
  constructor(private readonly opts: LocalBarStoreOptions) {}

  /** Load and parse bars for one symbol. Throws if the file is missing/invalid. */
  load(symbol: string): Bar[] {
    const path = join(this.opts.dir, `${symbol}.ndjson`);
    const text = readFileSync(path, 'utf8');
    return parseBarsNdjson(text);
  }

  /** Load bars for several symbols into a { symbol: Bar[] } map. */
  loadAll(symbols: readonly string[]): Record<string, Bar[]> {
    const out: Record<string, Bar[]> = {};
    for (const s of symbols) out[s] = this.load(s);
    return out;
  }
}
