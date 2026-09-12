import { FakeBroker } from '@trading/broker';
import type { Bar, StrategyConfig } from '@trading/core';
import { tradingDay } from '@trading/core';
import { strategy } from '@trading/strategy';
import { describe, expect, it } from 'vitest';
import { runCycle } from './cycle.js';
import type { ResolvedConfig } from './env.js';
import { ArrayBarReader, InMemoryDb, InMemoryRiskGate } from './testing.js';

function ramp(symbol: string, n: number, start = 100, step = 1): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const c = start + i * step;
    bars.push({ symbol, t: (i + 1) * 86_400_000, open: c, high: c, low: c, close: c, volume: 1 });
  }
  return bars;
}

const symbols = ['AAPL'];
const bars = ramp('AAPL', 40);
const asOf = bars[bars.length - 1]?.t as number;
const lastClose = bars[bars.length - 1]?.close as number;

function config(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    mode: 'paper',
    symbols,
    risk: {
      maxPositionQty: 100,
      maxNotionalExposure: 1_000_000,
      maxDailyLoss: 100_000,
      maxOrdersPerDay: 20,
      killSwitchEngaged: false,
    },
    strategy: { fast: 10, slow: 30, qty: 10 },
    lookback: 200,
    liveEnabled: false,
    ...over,
  };
}

const strategyConfig: StrategyConfig = {
  name: 'sma-crossover-placeholder',
  symbols,
  params: { fast: 10, slow: 30, qty: 10 },
};

function deps(broker = new FakeBroker({ startingCash: 100_000 })) {
  broker.setMark('AAPL', lastClose);
  return {
    broker,
    bars: new ArrayBarReader({ AAPL: bars }),
    db: new InMemoryDb(),
    risk: new InMemoryRiskGate(),
    strategy,
  };
}

describe('runCycle happy path', () => {
  it('buys on a rising series, records order + fill, refreshes positions', async () => {
    const d = deps();
    const out = await runCycle(d, { config: config(), strategyConfig, asOf, now: asOf });
    expect(out.status).toBe('ok');
    if (out.status === 'ok') expect(out.submitted).toBe(1);
    expect(d.db.orders).toHaveLength(1);
    expect(d.db.fills).toHaveLength(1);
    expect(d.db.positions.AAPL?.qty).toBe(10);
    expect(d.db.reconciliations[0]?.ok).toBe(true);
    expect(d.db.cycles[0]?.status).toBe('ok');
  });
});

describe('runCycle idempotency', () => {
  it('a second run of the same bar does not create a second position', async () => {
    const broker = new FakeBroker({ startingCash: 100_000 });
    const d = deps(broker);
    await runCycle(d, { config: config(), strategyConfig, asOf, now: asOf });
    // Re-run the same cycle (same asOf) against the same broker.
    const d2 = {
      broker,
      bars: new ArrayBarReader({ AAPL: bars }),
      db: d.db,
      risk: new InMemoryRiskGate(),
      strategy,
    };
    await runCycle(d2, { config: config(), strategyConfig, asOf, now: asOf });
    const positions = await broker.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.qty).toBe(10); // not 20
  });
});

describe('runCycle reconciliation', () => {
  it('halts (and does not trade) when broker positions diverge from D1', async () => {
    const broker = new FakeBroker({ startingCash: 100_000 });
    broker.setMark('AAPL', lastClose);
    broker.seedPosition('TSLA', 5, 100); // broker holds something D1 does not know
    const d = {
      broker,
      bars: new ArrayBarReader({ AAPL: bars }),
      db: new InMemoryDb(),
      risk: new InMemoryRiskGate(),
      strategy,
    };
    const out = await runCycle(d, { config: config(), strategyConfig, asOf, now: asOf });
    expect(out.status).toBe('halted');
    expect(d.db.orders).toHaveLength(0);
    expect(d.db.reconciliations[0]?.ok).toBe(false);
    expect(d.db.riskMirror?.halted).toBe(true);
  });
});

describe('runCycle risk denial', () => {
  it('skips orders when the daily order limit is zero', async () => {
    const d = deps();
    const out = await runCycle(d, {
      config: config({
        risk: { ...config().risk, maxOrdersPerDay: 0 },
      }),
      strategyConfig,
      asOf,
      now: asOf,
    });
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      expect(out.submitted).toBe(0);
      expect(out.skipped).toBe(1);
    }
    expect(d.db.orders).toHaveLength(0);
  });

  it('halts on a daily-loss breach before trading', async () => {
    const d = deps();
    // Pre-set the day baseline (for asOf's trading day) high so current equity
    // looks like a big loss; the cycle's own ensureDay is then a same-day no-op.
    await d.risk.ensureDay(tradingDay(asOf), 1_000_000);
    const out = await runCycle(d, {
      config: config({ risk: { ...config().risk, maxDailyLoss: 1 } }),
      strategyConfig,
      asOf,
      now: asOf,
    });
    expect(out.status).toBe('halted');
    expect(d.db.orders).toHaveLength(0);
  });
});

describe('runCycle error safety', () => {
  it('halts on an unexpected broker error', async () => {
    const broker = new FakeBroker();
    broker.setMark('AAPL', lastClose);
    const d = {
      broker,
      bars: new ArrayBarReader({ AAPL: bars }),
      db: new InMemoryDb(),
      risk: new InMemoryRiskGate(),
      strategy,
    };
    // Make getPositions throw during reconciliation.
    broker.failNext(new (await import('@trading/broker')).BrokerError('boom', 'network', true));
    const out = await runCycle(d, { config: config(), strategyConfig, asOf, now: asOf });
    expect(out.status).toBe('error');
    expect(d.db.riskMirror?.halted).toBe(true);
  });
});
