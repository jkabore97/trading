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

- **Secret scanning via a `core.hooksPath` pre-commit hook** installed by the
  root `prepare` script. Conservative pattern set (AWS, GitHub, Slack, OpenAI,
  PEM, Alpaca AK/PK ids, generic secret assignments). `.md`/`.example` files are
  skipped so docs can show placeholder shapes.
