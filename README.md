# Automated trading system

Infrastructure for evaluating strategies honestly and executing them safely, for
a single operator's own capital. This repo is **machinery, not a strategy**: the
only strategy included is a deliberately trivial SMA-crossover placeholder, there
so the infrastructure is what gets tested. Do not treat any backtest number here
as a signal of anything.

> **Paper by default. Live trading is off and cannot turn itself on.** See
> [`GOING_LIVE.md`](./GOING_LIVE.md).

## The one-codepath rule

The strategy is a pure function:

```ts
(marketState, portfolioState, config) => Intent[]
```

No I/O, no clock, no randomness, no network. Its only notion of "now" is
`market.asOf`, and it only ever sees bars at or before that. The **same** module
(`@trading/strategy`) is imported unchanged by the backtester and the live
Worker, and both build the strategy's inputs through the **same**
`buildMarketState()` in `@trading/core`. The [parity test](./packages/worker/src/parity.test.ts)
asserts the two produce **byte-identical** intents over the same window — it is
the most important test in the repo and runs in CI.

## Architecture

```
Cron (Workers)  ──▶  Worker cycle  ──▶  RiskGate (Durable Object)  ──▶  Broker (fake | Alpaca paper)
                        │                     ▲                              │
                        ├── R2 (bars) ────────┘                              │
                        └── D1 (orders, fills, positions, decision logs, reconciliation, risk mirror)
Pages (read-only dashboard)  ──▶  Worker JSON APIs
```

Each cycle (see [`packages/worker/src/cycle.ts`](./packages/worker/src/cycle.ts)):

1. **Reconcile** broker (source of truth) vs D1 (our belief). On any mismatch:
   log, halt, do not auto-correct.
2. Refresh equity; roll the trading day; halt on daily-loss breach or
   broker-reported trading block.
3. **Decide** — build the shared `MarketState`/`PortfolioState` and run the
   strategy (the step the parity test pins).
4. For each intent: deterministic client order id → **risk gate** → submit
   (idempotent). Log the full input snapshot and output intents to D1.
5. Refresh positions from the broker into D1 so the next cycle reconciles clean.

Any unexpected error halts the cycle — the system never keeps trading through an
error.

## Safety

- **Paper by default.** `TRADING_MODE=paper`. Live needs `LIVE_TRADING_ENABLED=true`
  **and** the `ALPACA_LIVE_SECRET_KEY` secret present. Never falls back to live.
- **Risk gate outside the strategy.** A Durable Object holds max position size,
  max notional, max daily loss, max orders/day and the kill switch. Every order
  passes through it; the strategy cannot read or change the limits.
- **Kill switch.** Authenticated `POST /api/kill` flattens all positions and
  latches the gate closed until `POST /api/clear`.
- **Idempotent orders.** Deterministic client order id from
  `(strategy, symbol, bar timestamp, intent hash)`. A retry never creates a
  second order; a broker "already exists" is treated as success.
- **Reconciliation every cycle** (see above).
- **No secrets in the repo.** Wrangler/GitHub encrypted secrets only, plus a
  secret-scanning pre-commit hook installed by `pnpm install`.
- **Structured decision logs.** Every cycle writes its full input snapshot and
  output intents to D1, enough to replay offline.

## Backtesting

```bash
pnpm --filter @trading/backtest run backtest          # per-window + development region
pnpm --filter @trading/backtest run backtest -- --final   # also the held-out set (loud)
```

- Walk-forward windows with explicit train/test split; a held-out tail refused
  without `--final`.
- Pessimistic, configurable cost model (commission + spread + slippage) with
  conservative defaults. **All returns are net of costs**, and cost paid is
  always printed next to net return.
- Metrics: total & annualised return, max drawdown, Sharpe, hit rate, avg
  win/loss, turnover, total cost paid, trade count.

### Data & survivorship bias

Bars are NDJSON in R2 at `bars/daily/<SYMBOL>.ndjson`. Two ways to populate:

```bash
pnpm --filter @trading/scripts run gen:fixtures        # deterministic synthetic bars (offline/CI)
pnpm --filter @trading/scripts run ingest -- AAPL MSFT SPY          # real: Stooq end-of-day CSV
pnpm --filter @trading/scripts run ingest -- --upload AAPL          # also push to R2 (needs wrangler auth)
```

**Where survivorship bias can enter, and what ingestion does about it:** Stooq's
free history only covers *currently listed* symbols, and its prices are
back-adjusted. If you drive the symbol list from today's tickers you silently
exclude every name that was delisted, merged, or went to zero — the classic
survivorship trap that makes strategies look better than they were. This
ingestion **does not correct for it**; it documents it. For honest research,
drive the universe from a *point-in-time* index-membership file (the constituents
as they were on each date) rather than today's list, and prefer a data source
that retains delisted symbols. Point-in-time discipline within a backtest is
already enforced in code: the strategy only ever receives bars with `t <= asOf`.

> CI and the default backtest use the **synthetic** dataset, not a live fetch, so
> results are deterministic and CI never depends on a third-party host. The real
> Stooq path is unit-tested. See [`DECISIONS.md`](./DECISIONS.md).

## Repository layout

```
packages/core       shared types + pure helpers (ids, portfolio math, bars, time)
packages/strategy    pure placeholder strategy (trivial, do not tune)
packages/backtest    Node CLI: engine, cost model, metrics, walk-forward
packages/risk        pure risk gate + RiskGate Durable Object (via ./do subpath)
packages/broker      Broker interface, deterministic FakeBroker, Alpaca paper adapter
packages/worker      Cloudflare Worker: cron loop, reconciliation, kill switch, APIs
apps/dashboard       read-only Pages dashboard (static, TS -> app.js)
scripts              R2 ingestion, fixtures, D1 migrate helpers
migrations           D1 schema
```

## Development

```bash
pnpm install         # also installs the secret-scanning git hook
pnpm run check       # lint + typecheck + test (what CI runs)
pnpm test            # vitest (unit + parity)
```

Requires Node 22 and pnpm 10.

## Going live

You can't from this repo alone — it needs broker credentials only you can create.
Everything up to that boundary is built, wired, and tested against paper and the
fake broker. Follow [`GOING_LIVE.md`](./GOING_LIVE.md).
