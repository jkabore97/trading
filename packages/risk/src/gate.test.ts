import type { Position, RiskConfig } from '@trading/core';
import { describe, expect, it } from 'vitest';
import {
  type EvaluateInput,
  type RiskState,
  clearKillState,
  engageKillState,
  evaluateOrder,
  haltState,
  initialRiskState,
  reserveOrder,
  rolloverIfNewDay,
  shouldHaltForLoss,
} from './gate.js';

const config: RiskConfig = {
  maxPositionQty: 100,
  maxNotionalExposure: 50_000,
  maxDailyLoss: 1_000,
  maxOrdersPerDay: 5,
  killSwitchEngaged: false,
};

function state(over: Partial<RiskState> = {}): RiskState {
  return { ...initialRiskState(), tradingDay: '2024-01-02', dayStartEquity: 100_000, ...over };
}

function input(over: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    config,
    state: state(),
    order: { symbol: 'AAPL', side: 'buy', qty: 10, type: 'market' },
    refPrice: 100,
    positions: {},
    currentEquity: 100_000,
    marks: {},
    ...over,
  };
}

describe('evaluateOrder — allow path', () => {
  it('allows an order within all limits', () => {
    expect(evaluateOrder(input())).toEqual({ allowed: true });
  });
  it('allows exactly at the position limit (inclusive)', () => {
    const d = evaluateOrder(
      input({ order: { symbol: 'AAPL', side: 'buy', qty: 100, type: 'market' } }),
    );
    expect(d.allowed).toBe(true);
  });
});

describe('evaluateOrder — kill switch & halt', () => {
  it('denies when config kill switch is engaged', () => {
    const d = evaluateOrder(input({ config: { ...config, killSwitchEngaged: true } }));
    expect(d).toMatchObject({ allowed: false, code: 'kill_switch' });
  });
  it('denies when state kill switch is engaged', () => {
    const d = evaluateOrder(input({ state: state({ killSwitchEngaged: true }) }));
    expect(d).toMatchObject({ allowed: false, code: 'kill_switch' });
  });
  it('denies when halted', () => {
    const d = evaluateOrder(input({ state: state({ halted: true, haltReason: 'x' }) }));
    expect(d).toMatchObject({ allowed: false, code: 'halted' });
  });
});

describe('evaluateOrder — order sanity', () => {
  it('denies non-positive qty', () => {
    expect(
      evaluateOrder(input({ order: { symbol: 'A', side: 'buy', qty: 0, type: 'market' } })),
    ).toMatchObject({
      code: 'bad_order',
    });
    expect(
      evaluateOrder(input({ order: { symbol: 'A', side: 'buy', qty: -5, type: 'market' } })),
    ).toMatchObject({
      code: 'bad_order',
    });
  });
  it('denies a limit order without a valid limit price', () => {
    expect(
      evaluateOrder(input({ order: { symbol: 'A', side: 'buy', qty: 1, type: 'limit' } })),
    ).toMatchObject({
      code: 'bad_order',
    });
  });
  it('denies when there is no usable reference price', () => {
    expect(evaluateOrder(input({ refPrice: undefined }))).toMatchObject({
      code: 'no_reference_price',
    });
    expect(evaluateOrder(input({ refPrice: 0 }))).toMatchObject({ code: 'no_reference_price' });
    expect(evaluateOrder(input({ refPrice: Number.NaN }))).toMatchObject({
      code: 'no_reference_price',
    });
  });
});

describe('evaluateOrder — orders per day', () => {
  it('denies at the daily order limit', () => {
    const d = evaluateOrder(input({ state: state({ ordersToday: 5 }) }));
    expect(d).toMatchObject({ allowed: false, code: 'max_orders_per_day' });
  });
  it('allows the last order under the limit', () => {
    const d = evaluateOrder(input({ state: state({ ordersToday: 4 }) }));
    expect(d.allowed).toBe(true);
  });
});

describe('evaluateOrder — daily loss', () => {
  it('denies once the loss meets the limit', () => {
    const d = evaluateOrder(input({ currentEquity: 99_000 })); // lost exactly 1000
    expect(d).toMatchObject({ allowed: false, code: 'max_daily_loss' });
  });
  it('allows just under the loss limit', () => {
    const d = evaluateOrder(input({ currentEquity: 99_001 }));
    expect(d.allowed).toBe(true);
  });
  it('ignores loss when no day baseline is set', () => {
    const d = evaluateOrder(input({ state: state({ dayStartEquity: null }), currentEquity: 1 }));
    expect(d.allowed).toBe(true);
  });
});

describe('evaluateOrder — position size', () => {
  it('denies when the resulting position exceeds the limit', () => {
    const positions: Record<string, Position> = {
      AAPL: { symbol: 'AAPL', qty: 95, avgEntryPrice: 100 },
    };
    const d = evaluateOrder(
      input({ positions, order: { symbol: 'AAPL', side: 'buy', qty: 10, type: 'market' } }),
    );
    expect(d).toMatchObject({ allowed: false, code: 'max_position_qty' });
  });
  it('accounts for direction (a sell reduces exposure)', () => {
    const positions: Record<string, Position> = {
      AAPL: { symbol: 'AAPL', qty: 100, avgEntryPrice: 100 },
    };
    const d = evaluateOrder(
      input({ positions, order: { symbol: 'AAPL', side: 'sell', qty: 10, type: 'market' } }),
    );
    expect(d.allowed).toBe(true);
  });
  it('denies an oversized short', () => {
    const d = evaluateOrder(
      input({ order: { symbol: 'AAPL', side: 'sell', qty: 101, type: 'market' } }),
    );
    expect(d).toMatchObject({ allowed: false, code: 'max_position_qty' });
  });
});

describe('evaluateOrder — gross notional', () => {
  it('denies when resulting gross notional exceeds the limit', () => {
    // Existing 400 shares of MSFT @ 100 = 40k; adding 100 AAPL @ 100 = 10k -> 50k ok,
    // but 200 AAPL @ 100 = 20k -> 60k > 50k.
    const positions: Record<string, Position> = {
      MSFT: { symbol: 'MSFT', qty: 400, avgEntryPrice: 100 },
    };
    const marks = { MSFT: 100 };
    const d = evaluateOrder(
      input({
        positions,
        marks,
        order: { symbol: 'AAPL', side: 'buy', qty: 200, type: 'market' },
        config: { ...config, maxPositionQty: 1000 },
      }),
    );
    expect(d).toMatchObject({ allowed: false, code: 'max_notional' });
  });
});

describe('state transforms', () => {
  it('reserveOrder increments the counter', () => {
    expect(reserveOrder(state({ ordersToday: 2 })).ordersToday).toBe(3);
  });
  it('rolloverIfNewDay resets counters and sets baseline, keeps kill switch', () => {
    const s = state({ ordersToday: 4, killSwitchEngaged: true, halted: true });
    const rolled = rolloverIfNewDay(s, '2024-01-03', 105_000);
    expect(rolled.ordersToday).toBe(0);
    expect(rolled.dayStartEquity).toBe(105_000);
    expect(rolled.tradingDay).toBe('2024-01-03');
    expect(rolled.killSwitchEngaged).toBe(true); // manual latch survives
    expect(rolled.halted).toBe(false); // fresh day may trade
  });
  it('rolloverIfNewDay is a no-op on the same day', () => {
    const s = state({ ordersToday: 4 });
    expect(rolloverIfNewDay(s, '2024-01-02', 1)).toBe(s);
  });
  it('engage/clear kill switch', () => {
    const engaged = engageKillState(state(), 'manual');
    expect(engaged).toMatchObject({ killSwitchEngaged: true, halted: true });
    const cleared = clearKillState(engaged);
    expect(cleared).toMatchObject({ killSwitchEngaged: false, halted: false, haltReason: null });
  });
  it('haltState sets halted with a reason', () => {
    expect(haltState(state(), 'recon mismatch')).toMatchObject({
      halted: true,
      haltReason: 'recon mismatch',
    });
  });
  it('shouldHaltForLoss triggers at the limit', () => {
    expect(shouldHaltForLoss(config, state(), 99_000)).toBe(true);
    expect(shouldHaltForLoss(config, state(), 99_500)).toBe(false);
    expect(shouldHaltForLoss(config, state({ dayStartEquity: null }), 0)).toBe(false);
  });
});

describe('full sequence (simulating the DO ordering)', () => {
  it('reserves up to the daily limit then denies', () => {
    let s = rolloverIfNewDay(initialRiskState(), '2024-01-02', 100_000);
    let allowed = 0;
    for (let i = 0; i < 8; i++) {
      const d = evaluateOrder({
        config,
        state: s,
        order: { symbol: 'AAPL', side: 'buy', qty: 1, type: 'market' },
        refPrice: 100,
        positions: {},
        currentEquity: 100_000,
        marks: {},
      });
      if (d.allowed) {
        s = reserveOrder(s);
        allowed++;
      }
    }
    expect(allowed).toBe(config.maxOrdersPerDay);
  });
});
