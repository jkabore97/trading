-- D1 schema for the trading system.
--
-- Design notes:
--  * Times are epoch milliseconds (INTEGER) unless named *_day (a YYYY-MM-DD
--    string in America/New_York) or *_at ISO — we use epoch ms consistently.
--  * JSON snapshots are stored as TEXT; D1 is SQLite so json1 functions work.
--  * This schema stores OUR belief of the world. The broker is the source of
--    truth; reconciliation compares the two and halts on divergence.

-- Every live-loop invocation, whether it traded or not.
CREATE TABLE IF NOT EXISTS cycles (
  id            TEXT PRIMARY KEY,          -- deterministic: mode + asOf
  mode          TEXT NOT NULL,             -- 'paper' | 'live'
  as_of         INTEGER NOT NULL,          -- decision timestamp, epoch ms
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL,             -- 'running' | 'ok' | 'halted' | 'error'
  detail        TEXT                       -- human/JSON note (e.g. error, halt reason)
);
CREATE INDEX IF NOT EXISTS idx_cycles_as_of ON cycles(as_of);

-- Full input snapshot + output intents for each cycle: enough to replay offline.
CREATE TABLE IF NOT EXISTS decision_logs (
  id                  TEXT PRIMARY KEY,    -- = cycle id
  as_of               INTEGER NOT NULL,
  market_snapshot     TEXT NOT NULL,       -- JSON MarketState
  portfolio_snapshot  TEXT NOT NULL,       -- JSON PortfolioState
  config_snapshot     TEXT NOT NULL,       -- JSON StrategyConfig
  intents             TEXT NOT NULL,       -- JSON Intent[]
  created_at          INTEGER NOT NULL
);

-- Orders we have submitted (idempotency: client_order_id is the primary key).
CREATE TABLE IF NOT EXISTS orders (
  client_order_id  TEXT PRIMARY KEY,
  broker_order_id  TEXT,
  cycle_id         TEXT,
  symbol           TEXT NOT NULL,
  side             TEXT NOT NULL,          -- 'buy' | 'sell'
  qty              REAL NOT NULL,
  type             TEXT NOT NULL,          -- 'market' | 'limit'
  limit_price      REAL,
  time_in_force    TEXT NOT NULL,
  status           TEXT NOT NULL,          -- normalised OrderStatus
  filled_qty       REAL NOT NULL DEFAULT 0,
  avg_fill_price   REAL,
  submitted_at     INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders(symbol);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- Fills reported by the broker.
CREATE TABLE IF NOT EXISTS fills (
  id               TEXT PRIMARY KEY,       -- broker_order_id + ':' + seq
  client_order_id  TEXT NOT NULL,
  broker_order_id  TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  side             TEXT NOT NULL,
  qty              REAL NOT NULL,
  price            REAL NOT NULL,
  filled_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fills_symbol ON fills(symbol);

-- Our belief of current positions (reconciled against the broker each cycle).
CREATE TABLE IF NOT EXISTS positions (
  symbol           TEXT PRIMARY KEY,
  qty              REAL NOT NULL,
  avg_entry_price  REAL NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- Reconciliation results, one row per cycle that reconciled.
CREATE TABLE IF NOT EXISTS reconciliations (
  id          TEXT PRIMARY KEY,            -- = cycle id
  as_of       INTEGER NOT NULL,
  ok          INTEGER NOT NULL,            -- 1 ok, 0 mismatch
  detail      TEXT NOT NULL,               -- JSON diff
  created_at  INTEGER NOT NULL
);

-- Singleton risk/loop state. Row id is always 1. The authoritative copy of the
-- daily counters and halt/kill state lives in the Durable Object; this table is
-- a durable mirror for the dashboard and for cold-start recovery.
CREATE TABLE IF NOT EXISTS risk_state (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  trading_day          TEXT,
  orders_today         INTEGER NOT NULL DEFAULT 0,
  day_start_equity     REAL,
  realized_pnl_today   REAL NOT NULL DEFAULT 0,
  kill_switch_engaged  INTEGER NOT NULL DEFAULT 0,
  halted               INTEGER NOT NULL DEFAULT 0,
  halt_reason          TEXT,
  updated_at           INTEGER NOT NULL
);
INSERT OR IGNORE INTO risk_state (id, orders_today, realized_pnl_today, kill_switch_engaged, halted, updated_at)
VALUES (1, 0, 0, 0, 0, 0);
