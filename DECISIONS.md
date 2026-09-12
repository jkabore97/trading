# Decisions

Decisions made autonomously while building, with reasoning. Newest at the bottom
of each phase. This is the record of every place the spec was silent or ambiguous
and I chose a path.

## Phase 1 — scaffold, core types, CI

- **pnpm workspaces, `type: module`, TS 5.6, Node 22.** The spec mandates pnpm
  workspaces + Wrangler + Vitest + Biome. ESM throughout because Workers are ESM
  and the "same module in both places" rule is easiest when there is one module
  system.

- **Packages reference each other by source (`main: ./src/index.ts`), not built
  output.** Vitest and Wrangler both bundle TypeScript directly, so there is no
  build step between packages. This keeps the one-codepath rule honest: the
  worker imports the exact `.ts` the backtester imports. Downside: no isolated
  package builds; acceptable for a single-operator monorepo.

- **Money/prices are `number` (float dollars), not integer cents or a decimal
  type.** Market data arrives as floats; a decimal library in the signal path is
  overkill for a placeholder strategy and adds a dependency to the pure module.
  Consequence: floating-point rounding can occur in P&L math. Mitigations:
  quantities are integer share counts; comparisons in the risk gate use
  inclusive limits; the backtester reports costs explicitly. If this system ever
  holds real size, revisit with integer cents for cash accounting. Recorded as a
  known limitation, not a hidden one.

- **`clientOrderId` uses a non-cryptographic hash (cyrb53).** The idempotency key
  must be a pure, synchronous, deterministic function shared by backtester and
  worker. `crypto.subtle` is async and would force the strategy/order path to be
  async. cyrb53 is deterministic across Node and Workers and the id also embeds
  strategy+symbol+timestamp, so collision risk within a symbol/day is negligible.
  The hash is not used for any security purpose.

- **Trading-day boundary is America/New_York, via `Intl` with a fixed timeZone.**
  The US equities session defines the day for "orders per day" and "daily loss".
  `Intl` with an explicit `timeZone` is available in both Node and Workers.

- **The strategy sees only `MarketState.asOf` as its clock.** No `Date.now()`,
  no randomness. `bars[symbol]` contains only bars at or before `asOf`. This is
  the mechanism that makes backtest and live indistinguishable to the strategy
  and enforces point-in-time discipline.

- **One root Vitest config** discovering all `*.test.ts`. The parity test needs
  to import from several packages at once; a single config keeps CI to one
  command and the parity test trivial to wire.

## Phase 2 — ingestion, D1 schema, fake broker

- **Bar storage format is NDJSON, not Parquet.** The spec allows either. NDJSON
  is dependency-free (no parquet lib in the Worker), diff-friendly, streamable
  and trivial to produce from any free source. R2 key convention:
  `bars/<interval>/<SYMBOL>.ndjson`. Parse/serialize live in `@trading/core` so
  the backtester (local files) and worker (R2) read bars identically.

- **Free data source is Stooq** (end-of-day CSV, no API key). Parser is pure and
  unit-tested. Daily bars are timestamped at a nominal 20:00 UTC close (≈16:00 ET,
  DST ignored — daily granularity makes intraday offset irrelevant to the
  strategy, which only sees closes).

- **CI/backtests use a deterministic SYNTHETIC dataset, not a live fetch.** Two
  reasons: (1) this build sandbox's network policy blocks stooq.com and every
  other market-data host (only the parser could be verified here, via unit
  tests); (2) CI must never depend on a flaky third-party host or the parity test
  becomes non-deterministic. `scripts/gen-fixtures.ts` produces committed
  synthetic bars; the real Stooq ingestion path remains and is unit-tested. This
  is a genuine improvement over fetching in CI, not just a sandbox workaround.

- **Survivorship bias is documented, not corrected.** Stooq's history covers
  only currently-listed symbols. Honest research needs point-in-time index
  membership; ingestion notes this in `scripts/ingest.ts` and the README rather
  than silently pretending today's tickers were always the universe.

- **D1 stores OUR belief; the broker is the source of truth.** `positions`,
  `orders`, `risk_state` are mirrors. Reconciliation each cycle diffs broker vs
  D1 and halts on mismatch (never auto-corrects). The Durable Object holds the
  authoritative live risk counters; `risk_state` is a durable mirror for the
  dashboard and cold-start recovery.

- **Alpaca adapter is built in Phase 2 alongside the broker interface** (spec
  lists it as Phase 6) because it belongs in `@trading/broker` and is fully
  unit-testable with an injected `fetch` — no credentials needed to write or test
  it. It hard-refuses the live host in its constructor; wiring it into the worker
  is still gated behind Phase 6's mode/secret checks.

- **Secret scanning via a `core.hooksPath` pre-commit hook** installed by the
  root `prepare` script. Conservative pattern set (AWS, GitHub, Slack, OpenAI,
  PEM, Alpaca AK/PK ids, generic secret assignments). `.md`/`.example` files are
  skipped so docs can show placeholder shapes.

## Phase 3 — strategy & backtest

- **Placeholder strategy is SMA-crossover, target-position style.** Trivial on
  purpose. It emits the minimal intent to move from the current position to the
  target, so a held position produces no order — this exercises the
  portfolio-aware path without being a "strategy". It refuses to trade on
  misconfiguration (fast >= slow) rather than emit nonsense.

- **Execution model: decide on close, fill at next open.** Removes look-ahead:
  the decision only uses information known at the bar close; the fill happens at
  the next bar's open. The last bar therefore never trades.

- **Per-trade P&L is realised on position reductions (avg-cost).** Returns/Sharpe
  come from the net equity curve; hit rate / avg win-loss from realised closes.
  Total cost paid is tracked separately and always printed next to net return.

- **Walk-forward is structural even though the placeholder does no fitting.** The
  harness still tiles train/test windows and reserves a held-out tail, so the
  discipline is in place for a real strategy. `--final` is required to touch the
  held-out set and prints a loud banner.

## Phase 4 — risk gate

- **Limits are inclusive; deny-by-default on ambiguity.** Reaching a limit
  exactly is allowed; exceeding it is denied. A missing/zero/NaN reference price
  is a denial, not a guess.

- **All logic is pure (gate.ts); the DO is a thin wrapper.** Every limit check
  and state transform is a pure function with exhaustive unit tests. The Durable
  Object only loads state, applies a transform, and persists — so the hard part
  is tested without a Workers runtime.

- **evaluate + reserve is one serialized DO call.** Counting an order slot
  happens inside the same DO method as the check, so two concurrent cron ticks
  can't both pass the orders/day limit.

- **Kill switch is a manual latch that survives day rollover; loss-halt does
  not.** A fresh trading day clears a loss halt (so the system can trade again)
  but never clears the kill switch — that requires an explicit operator `clear`.

## Phase 5/6 — worker & Alpaca

- **Reconcile first; halt on mismatch; never auto-correct** (spec #5). The broker
  is the source of truth; D1 is our belief. Any position/open-order divergence
  halts the cycle before any trading.

- **On any unexpected error, halt-safe.** The cycle's catch-all halts trading and
  mirrors state rather than continuing. Errors never lead to more trading.

- **Fake broker is the default even in "paper" mode when no Alpaca keys are
  set.** This lets the whole loop run and log end-to-end with zero credentials.
  Alpaca paper is used only when paper keys are present. There is no code path
  that constructs a live broker; the adapter also refuses the live host.

- **Idempotency across cron retries** relies on `asOf` being the latest bar
  timestamp (stable within a day), not the wall clock — so the client order id is
  identical on a retry of the same bar.

## Phase 7 — dashboard & deployment

- **Dashboard is static + read-only, points at the Worker via `?api=`.** No build
  server; TypeScript compiled to a single `app.js` served by Pages. The kill
  switch is deliberately NOT a dashboard button — it is an authenticated operator
  endpoint. Dashboard is not in the trading path, so browser JS is acceptable
  there (the trading path stays TypeScript/Workers only).

- **CI runs the parity test both inside `pnpm test` and as an explicit named
  step** for visibility. Deploy is a separate workflow gated on a full check job.
