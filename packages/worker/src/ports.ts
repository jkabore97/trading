// Ports: the interfaces the live cycle depends on. Real implementations (R2, D1,
// the Durable Object stub) are wired in index.ts; tests wire in-memory fakes.
// Keeping the cycle logic behind these ports is what makes it unit-testable
// without a live Cloudflare runtime.

import type {
  Bar,
  BrokerOrder,
  Fill,
  Intent,
  MarketState,
  Order,
  PortfolioState,
  Position,
  RiskConfig,
  StrategyConfig,
} from '@trading/core';
import type { RiskDecision, RiskState } from '@trading/risk';

/** Reads historical bars (R2BarStore in the Worker; a fake in tests). */
export interface BarReader {
  /** All bars for a symbol, oldest-first, or [] if none. */
  load(symbol: string): Promise<Bar[]>;
}

/** Client for the risk gate (satisfied by the RiskGate DO stub). */
export interface RiskGateClient {
  getState(): Promise<RiskState>;
  ensureDay(today: string, currentEquity: number): Promise<RiskState>;
  evaluateAndReserve(args: {
    config: RiskConfig;
    order: Pick<Order, 'symbol' | 'side' | 'qty' | 'type' | 'limitPrice'>;
    refPrice: number | undefined;
    positions: Record<string, Position>;
    currentEquity: number;
    marks: Record<string, number>;
  }): Promise<RiskDecision>;
  recordEquityAndMaybeHalt(config: RiskConfig, currentEquity: number): Promise<RiskState>;
  halt(reason: string): Promise<RiskState>;
}

/** Persistence port (D1 in production). */
export interface Db {
  getPositions(): Promise<Record<string, Position>>;
  getOpenOrderIds(): Promise<string[]>;
  startCycle(rec: { id: string; mode: string; asOf: number; startedAt: number }): Promise<void>;
  finishCycle(id: string, status: string, finishedAt: number, detail?: string): Promise<void>;
  writeDecisionLog(rec: {
    id: string;
    asOf: number;
    market: MarketState;
    portfolio: PortfolioState;
    config: StrategyConfig;
    intents: Intent[];
    createdAt: number;
  }): Promise<void>;
  upsertOrder(
    rec: BrokerOrder & {
      cycleId: string;
      submittedAt: number;
      updatedAt: number;
      timeInForce: string;
      type: string;
    },
  ): Promise<void>;
  recordFills(fills: Fill[]): Promise<void>;
  upsertPositions(positions: Position[], updatedAt: number): Promise<void>;
  writeReconciliation(rec: {
    id: string;
    asOf: number;
    ok: boolean;
    detail: string;
    createdAt: number;
  }): Promise<void>;
  mirrorRiskState(state: RiskState, updatedAt: number): Promise<void>;
}
