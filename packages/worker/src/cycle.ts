// The live loop, one cycle. Driven by the cron trigger in production; called
// directly with fakes in tests. Boring and explicit on purpose.
//
// Order of operations (each step is a spec safety requirement):
//   1. Reconcile broker (truth) vs D1 (belief). Mismatch -> halt, do not trade.
//   2. Refresh account equity; roll the trading day; halt on daily-loss breach or
//      broker trading-blocked.
//   3. Build the exact MarketState/PortfolioState the strategy sees (shared with
//      the backtester) and run the strategy.
//   4. For each intent: deterministic client order id -> risk gate -> submit
//      (idempotent). Log everything.
//   5. Refresh positions from the broker into D1 so the next cycle reconciles.
//
// The strategy's decision (step 3) is `decide()` below — the SAME function the
// parity test runs against the backtester.

import type { Broker } from '@trading/broker';
import {
  type Bar,
  type Fill,
  type Intent,
  type MarketState,
  type Order,
  type PortfolioState,
  type Position,
  type Strategy,
  type StrategyConfig,
  buildMarketState,
  clientOrderId,
  markToMarketEquity,
  tradingDay,
} from '@trading/core';
import type { ResolvedConfig } from './env.js';
import type { BarReader, Db, RiskGateClient } from './ports.js';
import { reconcile } from './reconcile.js';

export interface CycleDeps {
  broker: Broker;
  bars: BarReader;
  db: Db;
  risk: RiskGateClient;
  strategy: Strategy;
}

export interface CycleOptions {
  config: ResolvedConfig;
  strategyConfig: StrategyConfig;
  /** Decision timestamp (latest completed bar). */
  asOf: number;
  /** Wall-clock now (epoch ms) for record timestamps. */
  now: number;
}

export type CycleOutcome =
  | { status: 'ok'; submitted: number; skipped: number }
  | { status: 'halted'; reason: string }
  | { status: 'error'; reason: string };

/**
 * The decision step, factored out so the parity test can call EXACTLY what the
 * Worker calls. Pure: builds the shared MarketState and runs the strategy.
 */
export function decide(
  strategy: Strategy,
  barsBySymbol: Record<string, Bar[]>,
  portfolio: PortfolioState,
  strategyConfig: StrategyConfig,
  asOf: number,
  lookback: number,
): { market: MarketState; intents: Intent[] } {
  const market = buildMarketState(barsBySymbol, asOf, lookback);
  const intents = strategy(market, portfolio, strategyConfig);
  return { market, intents };
}

export async function runCycle(deps: CycleDeps, opts: CycleOptions): Promise<CycleOutcome> {
  const { broker, bars, db, risk, strategy } = deps;
  const { config, strategyConfig, asOf, now } = opts;
  const cycleId = `${config.mode}:${asOf}`;

  await db.startCycle({ id: cycleId, mode: config.mode, asOf, startedAt: now });

  try {
    // Load bars + marks.
    const barsBySymbol: Record<string, Bar[]> = {};
    const marks: Record<string, number> = {};
    for (const symbol of config.symbols) {
      const list = await bars.load(symbol);
      barsBySymbol[symbol] = list;
      const mark = lastCloseAsOf(list, asOf);
      if (mark !== undefined) marks[symbol] = mark;
    }

    // 1. Reconcile.
    const [brokerPositions, brokerOpenOrders, ourPositions, ourOpenOrderIds] = await Promise.all([
      broker.getPositions(),
      broker.getOpenOrders(),
      db.getPositions(),
      db.getOpenOrderIds(),
    ]);
    const recon = reconcile(ourPositions, brokerPositions, ourOpenOrderIds, brokerOpenOrders);
    await db.writeReconciliation({
      id: cycleId,
      asOf,
      ok: recon.ok,
      detail: JSON.stringify(recon),
      createdAt: now,
    });
    if (!recon.ok) {
      const reason = `reconciliation mismatch: ${JSON.stringify(recon)}`;
      const state = await risk.halt(reason);
      await db.mirrorRiskState(state, now);
      await db.finishCycle(cycleId, 'halted', now, reason);
      return { status: 'halted', reason };
    }

    // 2. Account, day rollover, loss/blocked halts.
    const account = await broker.getAccount();
    await risk.ensureDay(tradingDay(asOf), account.equity);
    if (account.tradingBlocked) {
      const reason = 'broker reports trading blocked';
      const state = await risk.halt(reason);
      await db.mirrorRiskState(state, now);
      await db.finishCycle(cycleId, 'halted', now, reason);
      return { status: 'halted', reason };
    }
    const afterLoss = await risk.recordEquityAndMaybeHalt(config.risk, account.equity);
    await db.mirrorRiskState(afterLoss, now);
    if (afterLoss.halted) {
      await db.finishCycle(cycleId, 'halted', now, afterLoss.haltReason ?? 'halted');
      return { status: 'halted', reason: afterLoss.haltReason ?? 'halted' };
    }

    // 3. Decide (shared with the backtester).
    const positions = toPositionMap(brokerPositions);
    const portfolio: PortfolioState = {
      cash: account.cash,
      equity: account.equity,
      positions,
    };
    const { market, intents } = decide(
      strategy,
      barsBySymbol,
      portfolio,
      strategyConfig,
      asOf,
      config.lookback,
    );
    await db.writeDecisionLog({
      id: cycleId,
      asOf,
      market,
      portfolio,
      config: strategyConfig,
      intents,
      createdAt: now,
    });

    // 4. Risk-gate and submit each intent.
    let submitted = 0;
    let skipped = 0;
    const fills: Fill[] = [];
    for (const intent of intents) {
      const refPrice = marks[intent.symbol];
      const decision = await risk.evaluateAndReserve({
        config: config.risk,
        order: intent,
        refPrice,
        positions,
        currentEquity: account.equity,
        marks,
      });
      if (!decision.allowed) {
        skipped++;
        continue;
      }
      const order: Order = {
        clientOrderId: clientOrderId(strategyConfig.name, intent.symbol, asOf, intent),
        symbol: intent.symbol,
        side: intent.side,
        qty: intent.qty,
        type: intent.type,
        ...(intent.limitPrice !== undefined ? { limitPrice: intent.limitPrice } : {}),
        timeInForce: intent.timeInForce,
        submittedAt: now,
      };
      const result = await broker.submitOrder(order); // idempotent
      await db.upsertOrder({
        ...result,
        cycleId,
        submittedAt: now,
        updatedAt: now,
        timeInForce: order.timeInForce,
        type: order.type,
      });
      if (result.status === 'filled' && result.avgFillPrice !== undefined) {
        fills.push({
          clientOrderId: result.clientOrderId,
          brokerOrderId: result.brokerOrderId,
          symbol: result.symbol,
          side: result.side,
          qty: result.filledQty,
          price: result.avgFillPrice,
          filledAt: now,
        });
      }
      submitted++;
    }
    if (fills.length > 0) await db.recordFills(fills);

    // 5. Refresh positions from the broker into D1 (keeps next reconcile clean).
    const refreshed = await broker.getPositions();
    await db.upsertPositions(refreshed, now);

    await db.finishCycle(cycleId, 'ok', now);
    return { status: 'ok', submitted, skipped };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // On any unexpected error we halt-safe: never keep trading through an error.
    try {
      const state = await risk.halt(`cycle error: ${reason}`);
      await db.mirrorRiskState(state, now);
    } catch {
      // best effort
    }
    await db.finishCycle(cycleId, 'error', now, reason);
    return { status: 'error', reason };
  }
}

// ---- helpers ---------------------------------------------------------------

function lastCloseAsOf(bars: readonly Bar[], asOf: number): number | undefined {
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i] as Bar;
    if (b.t <= asOf) return b.close;
  }
  return undefined;
}

function toPositionMap(positions: Position[]): Record<string, Position> {
  const map: Record<string, Position> = {};
  for (const p of positions) map[p.symbol] = { ...p };
  return map;
}

/** Convenience: mark-to-market equity from positions + marks (used by callers/tests). */
export function equityFrom(
  cash: number,
  positions: Record<string, Position>,
  marks: Record<string, number>,
): number {
  return markToMarketEquity({ cash, positions }, marks);
}
