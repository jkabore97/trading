// Walk-forward window construction and the held-out guard.
//
// The strategy here does no parameter fitting, but the harness still enforces the
// discipline: an explicit train/test split per window, and a held-out tail that
// the CLI refuses to evaluate unless `--final` is passed (and logs loudly when it
// is). This keeps the machinery honest for the day a real, fitted strategy is
// dropped in.

export interface WalkForwardConfig {
  /** Bars of history per window used for training/fitting. */
  trainBars: number;
  /** Bars evaluated (out-of-sample) per window. */
  testBars: number;
  /** Bars reserved at the very end as the untouchable held-out set. */
  heldOutBars: number;
}

/** Half-open index range [start, end). */
export type Range = { start: number; end: number };

export interface Window {
  index: number;
  train: Range;
  test: Range;
}

export interface Split {
  totalBars: number;
  development: Range;
  heldOut: Range;
  windows: Window[];
}

/**
 * Build the walk-forward split over `totalBars` bars. The last `heldOutBars` are
 * the held-out set. The development region is tiled with rolling windows: each
 * window trains on `trainBars` then tests on the next `testBars`, advancing by
 * `testBars` so test segments never overlap.
 */
export function planWalkForward(totalBars: number, cfg: WalkForwardConfig): Split {
  if (cfg.trainBars <= 0 || cfg.testBars <= 0 || cfg.heldOutBars < 0) {
    throw new Error('walk-forward bars must be positive (heldOut may be 0)');
  }
  const devEnd = Math.max(0, totalBars - cfg.heldOutBars);
  const development: Range = { start: 0, end: devEnd };
  const heldOut: Range = { start: devEnd, end: totalBars };

  const windows: Window[] = [];
  let trainStart = 0;
  let index = 0;
  while (true) {
    const trainEnd = trainStart + cfg.trainBars;
    const testStart = trainEnd;
    const testEnd = Math.min(testStart + cfg.testBars, devEnd);
    if (testStart >= devEnd || testEnd <= testStart) break;
    windows.push({
      index: index++,
      train: { start: trainStart, end: trainEnd },
      test: { start: testStart, end: testEnd },
    });
    trainStart += cfg.testBars;
  }

  return { totalBars, development, heldOut, windows };
}

/** Slice a timeline to a range's timestamps. */
export function timelineForRange(timeline: readonly number[], range: Range): number[] {
  return timeline.slice(range.start, range.end);
}
