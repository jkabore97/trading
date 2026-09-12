// R2-backed bar reader. Reads the same NDJSON format the backtester reads from
// disk, via core's parseBarsNdjson — so bars are identical regardless of origin.

import { type Bar, parseBarsNdjson } from '@trading/core';
import type { BarReader } from './ports.js';

export class R2BarStore implements BarReader {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly interval = 'daily',
  ) {}

  async load(symbol: string): Promise<Bar[]> {
    const key = `bars/${this.interval}/${symbol}.ndjson`;
    const obj = await this.bucket.get(key);
    if (!obj) return [];
    return parseBarsNdjson(await obj.text());
  }
}
