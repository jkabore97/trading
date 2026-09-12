// Durable Object wrapper around the pure risk gate.
//
// Why a Durable Object: the risk counters (orders/day, daily loss) and the
// kill-switch latch must have single-instance, serialized semantics. Two
// concurrent cron ticks must not both see "0 orders today" and each fire the
// limit-th order. The DO gives us exactly one instance with serialized method
// calls and durable storage — no races on position and loss limits.
//
// All the decision logic lives in gate.ts (pure, exhaustively tested). This class
// only loads state, applies a pure transform, and persists. Keep it that way.

import { DurableObject } from 'cloudflare:workers';
import type { Position, RiskConfig } from '@trading/core';
import {
  type EvaluateInput,
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
} from './gate.js';

const STATE_KEY = 'risk_state';

export type RiskGateEnv = Record<string, never>;

/** Arguments for an evaluate-and-reserve call, minus the state (the DO owns it). */
export interface EvaluateOrderArgs {
  config: RiskConfig;
  order: EvaluateInput['order'];
  refPrice: number | undefined;
  positions: Record<string, Position>;
  currentEquity: number;
  marks: Record<string, number>;
}

export class RiskGate extends DurableObject<RiskGateEnv> {
  private async load(): Promise<RiskState> {
    return (await this.ctx.storage.get<RiskState>(STATE_KEY)) ?? initialRiskState();
  }

  private async save(state: RiskState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  /** Current risk state (for the dashboard / cold-start mirror). */
  async getState(): Promise<RiskState> {
    return this.load();
  }

  /** Roll the trading day if needed, setting the day's equity baseline. */
  async ensureDay(today: string, currentEquity: number): Promise<RiskState> {
    const rolled = rolloverIfNewDay(await this.load(), today, currentEquity);
    await this.save(rolled);
    return rolled;
  }

  /**
   * Evaluate one order against the limits and, if allowed, reserve its slot
   * atomically. This is the single method the order path calls; the reserve is
   * part of the same serialized DO call so counts cannot race.
   */
  async evaluateAndReserve(args: EvaluateOrderArgs): Promise<RiskDecision> {
    const state = await this.load();
    const decision = evaluateOrder({
      config: args.config,
      state,
      order: args.order,
      refPrice: args.refPrice,
      positions: args.positions,
      currentEquity: args.currentEquity,
      marks: args.marks,
    });
    if (decision.allowed) {
      await this.save(reserveOrder(state));
    }
    return decision;
  }

  /** Record current equity; halt if the daily-loss limit is breached. */
  async recordEquityAndMaybeHalt(config: RiskConfig, currentEquity: number): Promise<RiskState> {
    const state = await this.load();
    if (!state.halted && shouldHaltForLoss(config, state, currentEquity)) {
      const halted = haltState(
        state,
        `daily loss limit ${config.maxDailyLoss} breached (equity ${currentEquity.toFixed(2)})`,
      );
      await this.save(halted);
      return halted;
    }
    return state;
  }

  /** Halt trading (e.g. reconciliation mismatch). Does not engage the kill switch. */
  async halt(reason: string): Promise<RiskState> {
    const halted = haltState(await this.load(), reason);
    await this.save(halted);
    return halted;
  }

  /** Engage the kill switch: block all orders until manually cleared. */
  async engageKill(reason: string): Promise<RiskState> {
    const engaged = engageKillState(await this.load(), reason);
    await this.save(engaged);
    return engaged;
  }

  /** Clear the kill switch and any halt — manual "resume". */
  async clearKill(): Promise<RiskState> {
    const cleared = clearKillState(await this.load());
    await this.save(cleared);
    return cleared;
  }
}
