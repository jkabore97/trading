// D1 implementation of the Db port. Plain parameterised SQL, no ORM.

import type {
  BrokerOrder,
  Fill,
  Intent,
  MarketState,
  PortfolioState,
  Position,
  StrategyConfig,
} from '@trading/core';
import type { RiskState } from '@trading/risk';
import type { Db } from './ports.js';

/** Open (non-terminal) order statuses, mirrored from the broker normalisation. */
const OPEN_STATUSES = ['new', 'accepted', 'partially_filled'];

export class D1Db implements Db {
  constructor(private readonly db: D1Database) {}

  async getPositions(): Promise<Record<string, Position>> {
    const { results } = await this.db
      .prepare('SELECT symbol, qty, avg_entry_price FROM positions')
      .all<{ symbol: string; qty: number; avg_entry_price: number }>();
    const out: Record<string, Position> = {};
    for (const r of results ?? []) {
      out[r.symbol] = { symbol: r.symbol, qty: r.qty, avgEntryPrice: r.avg_entry_price };
    }
    return out;
  }

  async getOpenOrderIds(): Promise<string[]> {
    const placeholders = OPEN_STATUSES.map(() => '?').join(',');
    const { results } = await this.db
      .prepare(`SELECT client_order_id FROM orders WHERE status IN (${placeholders})`)
      .bind(...OPEN_STATUSES)
      .all<{ client_order_id: string }>();
    return (results ?? []).map((r) => r.client_order_id);
  }

  async startCycle(rec: {
    id: string;
    mode: string;
    asOf: number;
    startedAt: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO cycles (id, mode, as_of, started_at, status)
         VALUES (?, ?, ?, ?, 'running')
         ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, status = 'running'`,
      )
      .bind(rec.id, rec.mode, rec.asOf, rec.startedAt)
      .run();
  }

  async finishCycle(
    id: string,
    status: string,
    finishedAt: number,
    detail?: string,
  ): Promise<void> {
    await this.db
      .prepare('UPDATE cycles SET status = ?, finished_at = ?, detail = ? WHERE id = ?')
      .bind(status, finishedAt, detail ?? null, id)
      .run();
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
    await this.db
      .prepare(
        `INSERT INTO decision_logs (id, as_of, market_snapshot, portfolio_snapshot, config_snapshot, intents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           market_snapshot = excluded.market_snapshot,
           portfolio_snapshot = excluded.portfolio_snapshot,
           config_snapshot = excluded.config_snapshot,
           intents = excluded.intents,
           created_at = excluded.created_at`,
      )
      .bind(
        rec.id,
        rec.asOf,
        JSON.stringify(rec.market),
        JSON.stringify(rec.portfolio),
        JSON.stringify(rec.config),
        JSON.stringify(rec.intents),
        rec.createdAt,
      )
      .run();
  }

  async upsertOrder(
    rec: BrokerOrder & {
      cycleId: string;
      submittedAt: number;
      updatedAt: number;
      timeInForce: string;
      type: string;
    },
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO orders (client_order_id, broker_order_id, cycle_id, symbol, side, qty, type,
           limit_price, time_in_force, status, filled_qty, avg_fill_price, submitted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_order_id) DO UPDATE SET
           broker_order_id = excluded.broker_order_id,
           status = excluded.status,
           filled_qty = excluded.filled_qty,
           avg_fill_price = excluded.avg_fill_price,
           updated_at = excluded.updated_at`,
      )
      .bind(
        rec.clientOrderId,
        rec.brokerOrderId,
        rec.cycleId,
        rec.symbol,
        rec.side,
        rec.qty,
        rec.type,
        rec.limitPrice ?? null,
        rec.timeInForce,
        rec.status,
        rec.filledQty,
        rec.avgFillPrice ?? null,
        rec.submittedAt,
        rec.updatedAt,
      )
      .run();
  }

  async recordFills(fills: Fill[]): Promise<void> {
    for (const f of fills) {
      await this.db
        .prepare(
          `INSERT INTO fills (id, client_order_id, broker_order_id, symbol, side, qty, price, filled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          `${f.brokerOrderId}:${f.filledAt}`,
          f.clientOrderId,
          f.brokerOrderId,
          f.symbol,
          f.side,
          f.qty,
          f.price,
          f.filledAt,
        )
        .run();
    }
  }

  async upsertPositions(positions: Position[], updatedAt: number): Promise<void> {
    // Replace the whole positions table with the broker's truth.
    await this.db.prepare('DELETE FROM positions').run();
    for (const p of positions) {
      await this.db
        .prepare(
          'INSERT INTO positions (symbol, qty, avg_entry_price, updated_at) VALUES (?, ?, ?, ?)',
        )
        .bind(p.symbol, p.qty, p.avgEntryPrice, updatedAt)
        .run();
    }
  }

  async writeReconciliation(rec: {
    id: string;
    asOf: number;
    ok: boolean;
    detail: string;
    createdAt: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO reconciliations (id, as_of, ok, detail, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ok = excluded.ok, detail = excluded.detail, created_at = excluded.created_at`,
      )
      .bind(rec.id, rec.asOf, rec.ok ? 1 : 0, rec.detail, rec.createdAt)
      .run();
  }

  async mirrorRiskState(state: RiskState, updatedAt: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE risk_state SET
           trading_day = ?, orders_today = ?, day_start_equity = ?,
           kill_switch_engaged = ?, halted = ?, halt_reason = ?, updated_at = ?
         WHERE id = 1`,
      )
      .bind(
        state.tradingDay,
        state.ordersToday,
        state.dayStartEquity,
        state.killSwitchEngaged ? 1 : 0,
        state.halted ? 1 : 0,
        state.haltReason,
        updatedAt,
      )
      .run();
  }
}
