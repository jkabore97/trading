# Build log

Autonomous build of the automated trading system. Built end-to-end without
pausing for approval; verified with tests, not confirmation. 103 tests pass;
lint, typecheck, and the parity test are green.

## What was built

| Phase | Deliverable | State |
|------|-------------|-------|
| 1 | pnpm monorepo, `@trading/core` types + pure helpers, CI, secret-scan hook | done, tested |
| 2 | `Broker` interface, deterministic `FakeBroker`, Alpaca **paper** adapter, D1 schema, Stooq ingestion + synthetic fixtures | done, tested |
| 3 | Trivial placeholder strategy, backtest engine (no look-ahead), cost model, metrics, walk-forward + held-out gate | done, tested |
| 4 | Risk gate pure logic (exhaustive tests) + `RiskGate` Durable Object + kill switch | done, tested |
| 5 | Worker cron loop: reconcile → risk-gate → idempotent submit, decision logs, halt-safe | done, tested |
| 6 | Alpaca paper adapter wired via `makeBroker` (fake broker is the safe default) | done, tested |
| 7 | Read-only Pages dashboard, CI parity step, deploy workflow | done, tested |

Cloudflare resources created during the build (connected account):
- D1 `trading` (`ca89692a-417c-4b8e-b843-03fa82309214`), schema applied.
- R2 bucket `trading-bars`.

The parity test (backtester vs Worker `decide()` → byte-identical intents) is the
spine of the "one codepath" guarantee and runs in CI.

## The boundary I stopped at

Live trading. Two reasons it's not on, both real:
1. It needs Alpaca credentials only the operator can create.
2. There is deliberately **no code path** that routes an order to the live host.
   `makeBroker()` constructs the Alpaca adapter against the paper host only, and
   the adapter refuses the live URL in its constructor. Going live requires a
   named, human edit documented in `GOING_LIVE.md`.

## Decisions made on your behalf

Full reasoning is in [`DECISIONS.md`](./DECISIONS.md). The ones most worth your
attention:

- **Money is `float` dollars**, not integer cents. Simplest for a placeholder;
  a known precision limitation for real cash accounting. Revisit before size.
- **NDJSON, not Parquet**, for bars — dependency-free in the Worker.
- **CI/backtests use synthetic data**, not a live fetch. This sandbox blocks all
  market-data hosts, and CI should never depend on a flaky third party anyway.
  The real Stooq ingestion path is written and unit-tested.
- **Alpaca adapter built in Phase 2** (spec put it in Phase 6) because it belongs
  in the broker package and is fully testable with an injected `fetch`.
- **Fake broker is the default even in paper mode** when no Alpaca keys are set,
  so the whole loop runs and logs with zero credentials.
- **Trading day = America/New_York**; daily counters reset on that boundary.

## Things in the spec I think are wrong or worth pushing back on

1. **A 30-minute cron on a daily-bar strategy re-decides the same bar many times
   a day.** Idempotency makes this safe (same `asOf` → same client order id → no
   duplicate order), and it usefully exercises reconciliation, but it is wasteful
   and slightly muddies the logs. A real system should record "already acted on
   this bar" and no-op the rest of the day, or run the cron once near the close.
   I left the dense cron because it stress-tests the safety machinery, which is
   the point of this build — but flagged it here.

2. **"Cron Triggers driving the live loop" fits daily equities poorly.** Workers
   cron is fine for a once-daily decision, but for anything intraday you'd want a
   Durable Object alarm (precise, self-scheduling) rather than cron. The DO is
   already here for risk; extending it to own the schedule would be cleaner than
   cron for a real cadence.

3. **Max daily loss keyed to broker equity** includes unrealised P&L swings, so a
   volatile-but-recovering day can trip the halt. That is arguably correct
   (protect capital), but the spec didn't distinguish realised vs
   mark-to-market; I chose mark-to-market (more conservative) and noted it.

4. **"Create a private GitHub repo and push."** The repo already existed and the
   session is scoped to a designated branch, so I developed on
   `claude/automated-trading-system-quq886` and pushed there rather than creating
   a new repo. Branch protection on `main` and the PR-driven flow are set up in
   the workflows but must be enabled by the operator in GitHub settings (I can't
   set branch protection without repo-admin API access here).

5. **R2 Parquet suggestion** — over-engineered for daily bars and a placeholder;
   NDJSON is the better default. Documented, not silently swapped.

## What I'd do differently with more time

- **Integer-cents cash accounting** in a small money type, keeping prices as
  floats only for indicators. Removes the float-rounding caveat.
- **A per-bar action guard** so the loop no-ops after it has acted on a bar,
  making the dense cron free instead of merely safe.
- **DO alarm-driven scheduling and daily reset** instead of cron + per-cycle
  `ensureDay`.
- **Integration tests for the Durable Object** using
  `@cloudflare/vitest-pool-workers` (currently the DO is thin over exhaustively
  tested pure functions, and an in-memory twin is tested, but the real DO
  storage/RPC path is only exercised at deploy).
- **Property-based tests** for the risk gate (fuzz limits and positions) on top
  of the example-based ones.
- **A more honest backtest fill model** (partial fills, volume participation
  caps, gap handling) and corporate-actions handling in ingestion.
- **Point-in-time index membership ingestion** to actually remove survivorship
  bias rather than only documenting it.

## Note on the strategy

The included strategy is a trivial SMA crossover and is not meant to make money.
I did not tune it and did not characterise its backtest as good or bad — the
numbers are printed plainly and are there only to prove the harness runs. Swapping
in a real strategy means writing one new pure module with the same signature; the
parity test then guards that backtest and live still agree.
