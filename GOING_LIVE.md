# Going live

Everything up to real money is built, wired, and tested against paper and the
fake broker. The remaining steps require credentials and account actions only you
can perform. Nothing here is gated by me to slow you down — it is gated by the
fact that I cannot (and must not) hold your broker keys.

Do the paper checklist first. Do not skip to live.

---

## What already exists (created during the build)

Using the connected Cloudflare account, the build created and configured:

- **D1 database** `trading` — id `ca89692a-417c-4b8e-b843-03fa82309214`, already
  in `packages/worker/wrangler.toml`. The schema (`migrations/0001_init.sql`) has
  been applied to it.
- **R2 bucket** `trading-bars` — bound as `BARS` in `wrangler.toml`.

If you run in a *different* Cloudflare account, recreate both and update the
`database_id` in `wrangler.toml`:

```bash
wrangler d1 create trading            # copy the new database_id into wrangler.toml
wrangler r2 bucket create trading-bars
wrangler d1 migrations apply trading --remote
```

## Deploying — GitHub Actions

Deployment is driven by `.github/workflows/deploy.yml`: on merge to `main` it
runs the full check suite (lint, typecheck, tests, parity) and, only if that
passes, applies the D1 migrations and deploys the Worker + Pages. Gating deploys
on the tests — the parity test especially — is the reason we use Actions rather
than Cloudflare's native Git build, which deploys whatever you push with no test
gate.

It needs two GitHub repo secrets (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — scoped to Workers Scripts / D1 / R2 / Pages **Edit**
  on your account.
- `CLOUDFLARE_ACCOUNT_ID` — your account id.

> **Do not also connect Cloudflare's Git integration (Workers Builds).** It runs
> `wrangler deploy`/`versions upload` from the repo root — where there is no
> `wrangler.toml` (it lives in `packages/worker/`) — and fails on every push, and
> two systems deploying the same Worker fight. If it was ever connected, remove
> it: Cloudflare dashboard → Workers & Pages → the auto-created project →
> Settings → Build → disconnect the Git repository.

For a one-off manual deploy from your machine (Wrangler authenticated):
`cd packages/worker && pnpm exec wrangler deploy` (and
`pnpm exec wrangler d1 migrations apply trading --remote` for migrations).

## What you must add

### 1. GitHub repository secrets (for CI deploy)

In the repo settings → Secrets and variables → Actions:

- `CLOUDFLARE_API_TOKEN` — a scoped token with **Workers Scripts:Edit**,
  **D1:Edit**, **R2:Edit**, **Pages:Edit** on your account.
- `CLOUDFLARE_ACCOUNT_ID` — your account id.

Then merges to `main` deploy the Worker and Pages via `.github/workflows/deploy.yml`
(gated on the check job passing).

### 2. Wrangler secrets on the Worker

```bash
cd packages/worker
wrangler secret put KILL_SWITCH_TOKEN        # a long random string; you'll send it as a Bearer token
wrangler secret put ALPACA_API_KEY_ID        # Alpaca PAPER key id (starts PK...)
wrangler secret put ALPACA_API_SECRET_KEY    # Alpaca PAPER secret
```

Create the Alpaca **paper** keys at <https://app.alpaca.markets> → Paper account →
API keys. With these two set, the Worker uses the Alpaca **paper** adapter (it
physically refuses the live host). With none set, it uses the fake broker.

### 3. Populate R2 with bar data

The Worker needs bars in R2 to compute `asOf` and run. Either:

```bash
# Real end-of-day data (needs wrangler auth):
pnpm --filter @trading/scripts run ingest -- --upload AAPL MSFT SPY
# or deterministic synthetic bars, then upload:
pnpm --filter @trading/scripts run gen:fixtures
for s in AAPL MSFT SPY; do wrangler r2 object put trading-bars/bars/daily/$s.ndjson --file=data/bars/daily/$s.ndjson --remote; done
```

## Paper checklist (do all of this before even thinking about live)

1. Deploy: merge to `main` (or `cd packages/worker && wrangler deploy`).
2. Confirm `GET /health` returns `{"ok":true,"mode":"paper"}`.
3. Point the dashboard at the Worker: open the Pages URL with
   `?api=https://<your-worker>.workers.dev`.
4. Trigger a cycle manually and watch it:
   ```bash
   curl -X POST https://<worker>/api/run -H "Authorization: Bearer $KILL_SWITCH_TOKEN"
   curl https://<worker>/api/state
   curl https://<worker>/api/cycles
   ```
5. **Test the kill switch and prove it works** (do this early and often):
   ```bash
   curl -X POST https://<worker>/api/kill  -H "Authorization: Bearer $KILL_SWITCH_TOKEN"
   # -> positions flattened, gate latched closed. Confirm /api/state shows killSwitchEngaged:true
   curl -X POST https://<worker>/api/clear -H "Authorization: Bearer $KILL_SWITCH_TOKEN"
   ```
6. Let it run on paper for a while. Verify: orders are idempotent across cron
   retries, reconciliation stays green, daily-loss and orders/day limits engage
   when you tighten them in `[vars]`, and every cycle writes a decision log.

## Turning on live (the one thing I could not do)

Only after the paper checklist is genuinely satisfied. Live requires **all** of:

1. `wrangler secret put ALPACA_LIVE_SECRET_KEY` — the presence of this secret is
   part of the gate. **Also** set `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY`
   to your live keys.
2. In `wrangler.toml` `[vars]`: set `LIVE_TRADING_ENABLED = "true"` **and**
   `TRADING_MODE = "live"`.

   > `resolveConfig()` only returns `mode: 'live'` when the flag is exactly
   > `"true"` AND the live secret is present. Any other combination stays paper.

3. **Before the first live cron:** review the live wiring in
   [`packages/worker/src/index.ts`](./packages/worker/src/index.ts) `makeBroker()`.
   It currently constructs the Alpaca adapter against the **paper** host only —
   the adapter refuses the live host by design. **To trade live you must
   deliberately edit `makeBroker()` to construct an Alpaca client pointed at the
   live host, guarded by `resolveConfig(env).mode === 'live'`.** This edit is the
   last, explicit, human step — it does not exist yet on purpose, so that there is
   no code path in the repo that can route real orders without you writing it.
4. Set conservative limits in `[vars]` (`MAX_POSITION_QTY`, `MAX_NOTIONAL_EXPOSURE`,
   `MAX_DAILY_LOSS`, `MAX_ORDERS_PER_DAY`). Start tiny.
5. Keep the kill switch command in a terminal you can reach instantly.

## If something goes wrong

- Fire the kill switch (`POST /api/kill`). It flattens and latches closed.
- The gate also auto-halts on: reconciliation mismatch, daily-loss breach,
  broker trading-blocked, or any unexpected cycle error.
- A halt clears on the next trading day (fresh day may trade); the **kill switch
  does not** — clear it manually only when you understand what happened.
- Everything needed to reconstruct a decision is in D1 (`decision_logs`,
  `cycles`, `orders`, `fills`, `reconciliations`).
