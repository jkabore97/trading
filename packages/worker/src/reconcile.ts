// Reconciliation — PURE diff of the broker (source of truth) against our belief
// (D1). Spec requirement #5: before acting, pull actual positions and open orders
// and diff. On mismatch: log, halt, DO NOT auto-correct. This module only
// computes the diff; the loop decides to halt.

import type { BrokerOrder, Position } from '@trading/core';

export interface PositionMismatch {
  symbol: string;
  /** Our belief (D1). Absent -> we thought flat. */
  ours: number;
  /** Broker truth. Absent -> broker flat. */
  theirs: number;
}

export interface OrderMismatch {
  clientOrderId: string;
  /** 'broker_only' = open at broker, unknown to us; 'ours_only' = we think open, broker doesn't. */
  kind: 'broker_only' | 'ours_only';
}

export interface ReconResult {
  ok: boolean;
  positionMismatches: PositionMismatch[];
  orderMismatches: OrderMismatch[];
}

/** Quantities within this absolute tolerance are considered equal (float slack). */
const QTY_EPSILON = 1e-6;

export function reconcile(
  ourPositions: Record<string, Position>,
  brokerPositions: Position[],
  ourOpenOrderIds: string[],
  brokerOpenOrders: BrokerOrder[],
): ReconResult {
  const positionMismatches = diffPositions(ourPositions, brokerPositions);
  const orderMismatches = diffOpenOrders(ourOpenOrderIds, brokerOpenOrders);
  return {
    ok: positionMismatches.length === 0 && orderMismatches.length === 0,
    positionMismatches,
    orderMismatches,
  };
}

export function diffPositions(
  ours: Record<string, Position>,
  brokerPositions: Position[],
): PositionMismatch[] {
  const theirs = new Map<string, number>();
  for (const p of brokerPositions) theirs.set(p.symbol, p.qty);

  const symbols = new Set<string>([...Object.keys(ours), ...theirs.keys()]);
  const mismatches: PositionMismatch[] = [];
  for (const symbol of [...symbols].sort()) {
    const o = ours[symbol]?.qty ?? 0;
    const t = theirs.get(symbol) ?? 0;
    if (Math.abs(o - t) > QTY_EPSILON) {
      mismatches.push({ symbol, ours: o, theirs: t });
    }
  }
  return mismatches;
}

export function diffOpenOrders(
  ourOpenOrderIds: string[],
  brokerOpenOrders: BrokerOrder[],
): OrderMismatch[] {
  const ours = new Set(ourOpenOrderIds);
  const theirs = new Set(brokerOpenOrders.map((o) => o.clientOrderId));

  const mismatches: OrderMismatch[] = [];
  for (const id of [...theirs].sort()) {
    if (!ours.has(id)) mismatches.push({ clientOrderId: id, kind: 'broker_only' });
  }
  for (const id of [...ours].sort()) {
    if (!theirs.has(id)) mismatches.push({ clientOrderId: id, kind: 'ours_only' });
  }
  return mismatches;
}
