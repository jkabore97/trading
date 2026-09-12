// In-memory fakes for testing the cycle without a Cloudflare runtime. These
// mirror the real D1/DO behaviour closely enough to exercise the loop's logic.

import type {
  Bar,
  BrokerOrder,
  Fill,
  Intent,
  MarketState,
  PortfolioState,
  Position,
  RiskConfig,
  StrategyConfig,
} from '@trading/core';
import {
  type RiskDecision,
  type RiskState,
  clearKillState,
  engageKillState,
  evaluateOrder,
  haltState,
  initialRiskState,
  reserveOrder,
  rolloverIfNewDay,
  shouldHaltForLoss,
} from '@trading/risk';
import type { BarReader, Db, RiskGateClient } from './ports.js';

/** BarReader backed by an in-memory map. */
export class ArrayBarReader implements BarReader {
  constructor(private readonly bars: Record<string, Bar[]>) {}
  async load(symbol: string): Promise<Bar[]> {
    return this.bars[symbol] ?? [];
  }
}

/** Full in-memory risk gate using the same pure functions as the DO. */
export class InMemoryRiskGate implements RiskGateClient {
  private state: RiskState = initialRiskState();

  async getState(): Promise<RiskState> {
    return this.state;
  }
  async ensureDay(today: string, equity: number): Promise<RiskState> {
    this.state = rolloverIfNewDay(this.state, today, equity);
    return this.state;
  }
  async evaluateAndReserve(args: {
    config: RiskConfig;
    order: Intent;
    refPrice: number | undefined;
    positions: Record<string, Position>;
    currentEquity: number;
    marks: Record<string, number>;
  }): Promise<RiskDecision> {
    const decision = evaluateOrder({ ...args, state: this.state });
    if (decision.allowed) this.state = reserveOrder(this.state);
    return decision;
  }
  async recordEquityAndMaybeHalt(config: RiskConfig, equity: number): Promise<RiskState> {
    if (!this.state.halted && shouldHaltForLoss(config, this.state, equity)) {
      this.state = haltState(this.state, `daily loss limit ${config.maxDailyLoss} breached`);
    }
    return this.state;
  }
  async halt(reason: string): Promise<RiskState> {
    this.state = haltState(this.state, reason);
    return this.state;
  }
  async engageKill(reason: string): Promise<RiskState> {
    this.state = engageKillState(this.state, reason);
    return this.state;
  }
  async clearKill(): Promise<RiskState> {
    this.state = clearKillState(this.state);
    return this.state;
  }
}

/** In-memory Db capturing everything written, for assertions. */
export class InMemoryDb implements Db {
  positions: Record<string, Position> = {};
  openOrderIds: string[] = [];
  cycles: Array<{ id: string; status: string; detail?: string }> = [];
  decisionLogs: Array<{ id: string; intents: Intent[] }> = [];
  orders: BrokerOrder[] = [];
  fills: Fill[] = [];
  reconciliations: Array<{ id: string; ok: boolean }> = [];
  riskMirror: RiskState | null = null;

  async getPositions(): Promise<Record<string, Position>> {
    return this.positions;
  }
  async getOpenOrderIds(): Promise<string[]> {
    return this.openOrderIds;
  }
  async startCycle(rec: {
    id: string;
    mode: string;
    asOf: number;
    startedAt: number;
  }): Promise<void> {
    this.cycles.push({ id: rec.id, status: 'running' });
  }
  async finishCycle(
    id: string,
    status: string,
    _finishedAt: number,
    detail?: string,
  ): Promise<void> {
    const c = this.cycles.find((x) => x.id === id);
    if (c) {
      c.status = status;
      if (detail !== undefined) c.detail = detail;
    }
  }
  async writeDecisionLog(rec: {
    id: string;
    asOf: number;
    market: MarketState;
    portfolio: PortfolioState;
    config: StrategyConfig;
    intents: Intent[];
    createdAt: number;
  }): Promise<void> {
    this.decisionLogs.push({ id: rec.id, intents: rec.intents });
  }
  async upsertOrder(rec: BrokerOrder): Promise<void> {
    this.orders.push(rec);
  }
  async recordFills(fills: Fill[]): Promise<void> {
    this.fills.push(...fills);
  }
  async upsertPositions(positions: Position[], _updatedAt: number): Promise<void> {
    this.positions = {};
    for (const p of positions) this.positions[p.symbol] = { ...p };
  }
  async writeReconciliation(rec: { id: string; asOf: number; ok: boolean }): Promise<void> {
    this.reconciliations.push({ id: rec.id, ok: rec.ok });
  }
  async mirrorRiskState(state: RiskState): Promise<void> {
    this.riskMirror = state;
  }
}
