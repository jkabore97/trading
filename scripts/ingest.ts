// R2 ingestion CLI for daily bars.
//
// Usage:
//   pnpm --filter @trading/scripts run ingest -- AAPL MSFT SPY
//   pnpm --filter @trading/scripts run ingest -- --upload AAPL      (also push to R2)
//
// Fetches free end-of-day data from Stooq, writes NDJSON to ./data/bars/daily/,
// and (with --upload) pushes each file to the R2 bucket via Wrangler. Kept
// deliberately boring: fetch -> parse -> write -> optional wrangler put.
//
// Point-in-time / survivorship note: Stooq daily history is adjusted and only
// includes currently-listed symbols, so a naive symbol list suffers survivorship
// bias (delisted names are absent). This ingestion does NOT correct for that; it
// documents it. See README / DECISIONS.md. For honest research, drive the symbol
// list from a point-in-time index membership file rather than today's tickers.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeBarsNdjson } from '@trading/core';
import { stooqCsvToBars, stooqDailyUrl } from './lib/stooq.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data', 'bars', 'daily');
const R2_BUCKET = process.env.R2_BUCKET ?? 'trading-bars';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const upload = argv.includes('--upload');
  const symbols = argv.filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());

  if (symbols.length === 0) {
    console.error('usage: ingest [--upload] SYMBOL [SYMBOL...]');
    process.exit(2);
  }

  mkdirSync(DATA_DIR, { recursive: true });

  for (const symbol of symbols) {
    const url = stooqDailyUrl(symbol);
    process.stdout.write(`fetching ${symbol} ... `);
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`FAILED (${res.status})`);
      continue;
    }
    const csv = await res.text();
    const bars = stooqCsvToBars(symbol, csv);
    if (bars.length === 0) {
      console.error('no bars parsed (delisted or rate-limited?)');
      continue;
    }
    const ndjson = serializeBarsNdjson(bars);
    const outPath = join(DATA_DIR, `${symbol}.ndjson`);
    writeFileSync(outPath, ndjson);
    console.log(`${bars.length} bars -> ${outPath}`);

    if (upload) {
      const key = `bars/daily/${symbol}.ndjson`;
      process.stdout.write(`  uploading r2://${R2_BUCKET}/${key} ... `);
      execFileSync(
        'pnpm',
        [
          'exec',
          'wrangler',
          'r2',
          'object',
          'put',
          `${R2_BUCKET}/${key}`,
          `--file=${outPath}`,
          '--remote',
        ],
        { cwd: ROOT, stdio: 'inherit' },
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
