// Worker environment bindings and operator config resolution.
//
// SAFETY-CRITICAL: this is where paper-vs-live is decided. The rules (spec
// requirement #1) are enforced in resolveConfig() below and are covered by tests:
//   * TRADING_MODE defaults to 'paper'.
//   * 'live' requires BOTH an explicit config flag (LIVE_TRADING_ENABLED === 'true')
//     AND the presence of the live secret (ALPACA_LIVE_SECRET_KEY).
//   * Any error or ambiguity falls back to 'paper', never to 'live'.

import type { RiskConfig, TradingMode } from '@trading/core';

/** Raw Cloudflare bindings + vars/secrets as they arrive on `env`. */
export interface Env {
  // Bindings
  DB: D1Database;
  BARS: R2Bucket;
  RISK_GATE: DurableObjectNamespace;

  // Vars (wrangler.toml [vars]) — non-secret operator config.
  TRADING_MODE?: string;
  LIVE_TRADING_ENABLED?: string;
  SYMBOLS?: string;
  MAX_POSITION_QTY?: string;
  MAX_NOTIONAL_EXPOSURE?: string;
  MAX_DAILY_LOSS?: string;
  MAX_ORDERS_PER_DAY?: string;
  STRATEGY_FAST?: string;
  STRATEGY_SLOW?: string;
  STRATEGY_QTY?: string;
  LOOKBACK?: string;

  // Secrets (wrangler secret put) — never in the repo.
  KILL_SWITCH_TOKEN?: string;
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string; // paper secret
  ALPACA_LIVE_SECRET_KEY?: string; // presence is part of the live gate
}

export interface ResolvedConfig {
  mode: TradingMode;
  symbols: string[];
  risk: RiskConfig;
  strategy: { fast: number; slow: number; qty: number };
  lookback: number;
  /** True only when every live precondition is met. */
  liveEnabled: boolean;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : fallback;
}

/**
 * Resolve the operator config from env, enforcing the paper-by-default and
 * live-gating rules. Returns `mode: 'paper'` unless live is fully, explicitly,
 * and safely enabled.
 */
export function resolveConfig(env: Env): ResolvedConfig {
  const symbols = (env.SYMBOLS ?? 'AAPL,MSFT,SPY')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);

  const risk: RiskConfig = {
    maxPositionQty: num(env.MAX_POSITION_QTY, 10),
    maxNotionalExposure: num(env.MAX_NOTIONAL_EXPOSURE, 10_000),
    maxDailyLoss: num(env.MAX_DAILY_LOSS, 500),
    maxOrdersPerDay: num(env.MAX_ORDERS_PER_DAY, 20),
    // The kill switch lives in the DO state; this static flag stays false.
    killSwitchEngaged: false,
  };

  const strategy = {
    fast: num(env.STRATEGY_FAST, 10),
    slow: num(env.STRATEGY_SLOW, 30),
    qty: num(env.STRATEGY_QTY, 10),
  };

  const liveEnabled = isLiveEnabled(env);
  // Even if the mode var says 'live', we only honour it when liveEnabled holds.
  const requestedLive = (env.TRADING_MODE ?? 'paper').toLowerCase() === 'live';
  const mode: TradingMode = requestedLive && liveEnabled ? 'live' : 'paper';

  return { mode, symbols, risk, strategy, lookback: num(env.LOOKBACK, 200), liveEnabled };
}

/**
 * Live is enabled ONLY when the explicit flag is exactly 'true' AND the live
 * secret is present. Anything else — missing flag, missing secret, typo — is not
 * live. There is no code path that makes live the fallback.
 */
export function isLiveEnabled(env: Env): boolean {
  const flag = env.LIVE_TRADING_ENABLED === 'true';
  const hasLiveSecret =
    typeof env.ALPACA_LIVE_SECRET_KEY === 'string' && env.ALPACA_LIVE_SECRET_KEY.length > 0;
  return flag && hasLiveSecret;
}
