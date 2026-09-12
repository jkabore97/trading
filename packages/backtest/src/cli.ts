// Backtest CLI.
//
//   pnpm --filter @trading/backtest run backtest -- --symbols AAPL,MSFT,SPY
//   pnpm --filter @trading/backtest run backtest -- --final     (evaluate held-out set)
//
// Prints per-window out-of-sample metrics and a continuous development-region
// run. The held-out tail is refused unless --final is passed, and its use is
// logged loudly. Numbers are reported plainly.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LOOKBACK } from '@trading/core';
import { defaultConfig, strategy } from '@trading/strategy';
import { LocalBarStore } from './barsource.js';
import { DEFAULT_COST_MODEL } from './costs.js';
import { runBacktest } from './engine.js';
import { formatMetrics } from './report.js';
import { planWalkForward, timelineForRange } from './windows.js';

// packages/backtest/src -> repo root is three levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Args {
  symbols: string[];
  dir: string;
  cash: number;
  trainBars: number;
  testBars: number;
  heldOutBars: number;
  final: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    symbols: (get('symbols') ?? 'AAPL,MSFT,SPY').split(',').map((s) => s.trim().toUpperCase()),
    dir: get('dir') ?? join(REPO_ROOT, 'data', 'bars', 'daily'),
    cash: Number(get('cash') ?? 100_000),
    trainBars: Number(get('train') ?? 120),
    testBars: Number(get('test') ?? 60),
    heldOutBars: Number(get('heldout') ?? 120),
    final: argv.includes('--final'),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const store = new LocalBarStore({ dir: args.dir });
  const bars = store.loadAll(args.symbols);
  const config = defaultConfig(args.symbols);

  // Common timeline: union of all bar timestamps, sorted.
  const timeline = [...new Set(Object.values(bars).flatMap((list) => list.map((b) => b.t)))].sort(
    (a, b) => a - b,
  );

  console.log(`symbols: ${args.symbols.join(', ')}   bars: ${timeline.length}`);
  console.log(`cost model: ${JSON.stringify(DEFAULT_COST_MODEL)}`);
  console.log('reporting net of costs only.\n');

  const split = planWalkForward(timeline.length, {
    trainBars: args.trainBars,
    testBars: args.testBars,
    heldOutBars: args.heldOutBars,
  });

  // Per-window out-of-sample runs.
  for (const w of split.windows) {
    const testTimeline = timelineForRange(timeline, w.test);
    const res = runBacktest({
      bars,
      strategy,
      config,
      costModel: DEFAULT_COST_MODEL,
      startingCash: args.cash,
      lookback: DEFAULT_LOOKBACK,
      timeline: testTimeline,
    });
    console.log(
      formatMetrics(`window ${w.index} test [${w.test.start},${w.test.end})`, res.metrics),
    );
    console.log('');
  }

  // Continuous development-region run (the headline out-of-sample summary).
  const devTimeline = timelineForRange(timeline, split.development);
  const dev = runBacktest({
    bars,
    strategy,
    config,
    costModel: DEFAULT_COST_MODEL,
    startingCash: args.cash,
    lookback: DEFAULT_LOOKBACK,
    timeline: devTimeline,
  });
  console.log(formatMetrics('development region (continuous)', dev.metrics));
  console.log('');

  // Held-out set: refused without --final.
  if (!args.final) {
    console.log(
      `held-out set [${split.heldOut.start},${split.heldOut.end}) NOT evaluated. Pass --final to evaluate it (do this rarely and deliberately).`,
    );
    return;
  }

  console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.log('!! EVALUATING THE HELD-OUT SET. This should happen ONCE, at   !!');
  console.log('!! the very end of research. Every peek burns its value.      !!');
  console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  const heldTimeline = timelineForRange(timeline, split.heldOut);
  const held = runBacktest({
    bars,
    strategy,
    config,
    costModel: DEFAULT_COST_MODEL,
    startingCash: args.cash,
    lookback: DEFAULT_LOOKBACK,
    timeline: heldTimeline,
  });
  console.log(formatMetrics('HELD-OUT (final)', held.metrics));
}

main();
