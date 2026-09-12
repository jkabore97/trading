// Cloudflare Worker entrypoint.
//
//  * scheduled()  — the cron-driven live loop (fake broker by default; Alpaca
//                   paper only when configured; never live unless fully gated).
//  * fetch()      — read-only dashboard APIs + the authenticated kill switch.
//
// The RiskGate Durable Object is re-exported at the bottom so Wrangler can bind it.

import { AlpacaBroker, type Broker, FakeBroker } from '@trading/broker';
import type { Bar } from '@trading/core';
import type { RiskGate } from '@trading/risk/do';
import { defaultConfig, strategy } from '@trading/strategy';
import { runCycle } from './cycle.js';
import { D1Db } from './d1.js';
import { type Env, resolveConfig } from './env.js';
import { R2BarStore } from './r2store.js';
import { riskGateClient } from './riskclient.js';

const RISK_GATE_SINGLETON = 'global';

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, mode: resolveConfig(env).mode });
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        return await handleState(env);
      }
      if (request.method === 'GET' && url.pathname === '/api/cycles') {
        return await handleCycles(env);
      }
      if (request.method === 'POST' && url.pathname === '/api/kill') {
        return await handleKill(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/clear') {
        return await handleClear(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/run') {
        // Manual trigger for the loop (same auth as the kill switch).
        if (!authorized(request, env)) return unauthorized();
        const outcome = await runScheduled(env);
        return json({ outcome });
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },
};

async function runScheduled(env: Env): Promise<unknown> {
  const config = resolveConfig(env);
  const bars = new R2BarStore(env.BARS);
  const db = new D1Db(env.DB);
  const risk = riskGateClient(getRiskGate(env));
  const broker = makeBroker(env, config.mode);
  const strategyConfig = {
    ...defaultConfig(config.symbols),
    params: { fast: config.strategy.fast, slow: config.strategy.slow, qty: config.strategy.qty },
  };

  const now = Date.now();
  const asOf = await computeAsOf(bars, config.symbols, now);
  if (asOf === undefined) {
    return { status: 'skipped', reason: 'no bars available' };
  }

  return runCycle({ broker, bars, db, risk, strategy }, { config, strategyConfig, asOf, now });
}

/**
 * Choose the broker. Default is the fake broker. The Alpaca PAPER adapter is used
 * only when paper keys are present. There is NO branch here that constructs a live
 * broker — going live is a documented manual change (GOING_LIVE.md), and the
 * Alpaca adapter itself refuses the live host.
 */
function makeBroker(env: Env, mode: string): Broker {
  if (env.ALPACA_API_KEY_ID && env.ALPACA_API_SECRET_KEY) {
    return new AlpacaBroker({
      keyId: env.ALPACA_API_KEY_ID,
      secretKey: env.ALPACA_API_SECRET_KEY,
      // baseUrl omitted -> paper host. Live host is refused by the adapter.
    });
  }
  // No broker credentials: fall back to the fake broker (safe default), regardless
  // of mode. This means the loop runs and logs without touching a real broker.
  void mode;
  return new FakeBroker();
}

function getRiskGate(env: Env): DurableObjectStub<RiskGate> {
  const id = env.RISK_GATE.idFromName(RISK_GATE_SINGLETON);
  return env.RISK_GATE.get(id) as DurableObjectStub<RiskGate>;
}

async function computeAsOf(
  bars: R2BarStore,
  symbols: string[],
  now: number,
): Promise<number | undefined> {
  let latest: number | undefined;
  for (const symbol of symbols) {
    const list: Bar[] = await bars.load(symbol);
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i] as Bar;
      if (b.t <= now) {
        if (latest === undefined || b.t > latest) latest = b.t;
        break;
      }
    }
  }
  return latest;
}

// ---- HTTP handlers ---------------------------------------------------------

async function handleState(env: Env): Promise<Response> {
  const risk = getRiskGate(env);
  const [state, positions] = await Promise.all([risk.getState(), new D1Db(env.DB).getPositions()]);
  return json({ mode: resolveConfig(env).mode, risk: state, positions });
}

async function handleCycles(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT id, mode, as_of, started_at, finished_at, status, detail FROM cycles ORDER BY as_of DESC LIMIT 50',
  ).all();
  return json({ cycles: results ?? [] });
}

async function handleKill(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return unauthorized();
  const risk = getRiskGate(env);
  const state = await risk.engageKill('manual kill switch endpoint');

  // Flatten all positions via the broker, then mirror state to D1.
  const broker = makeBroker(env, resolveConfig(env).mode);
  let flattened: unknown = [];
  let flattenError: string | undefined;
  try {
    flattened = await broker.closeAllPositions();
  } catch (err) {
    flattenError = err instanceof Error ? err.message : String(err);
  }
  await new D1Db(env.DB).mirrorRiskState(state, Date.now());
  return json({ killed: true, state, flattened, flattenError });
}

async function handleClear(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return unauthorized();
  const risk = getRiskGate(env);
  const state = await risk.clearKill();
  await new D1Db(env.DB).mirrorRiskState(state, Date.now());
  return json({ cleared: true, state });
}

// ---- auth / responses ------------------------------------------------------

function authorized(request: Request, env: Env): boolean {
  const token = env.KILL_SWITCH_TOKEN;
  if (!token) return false; // no token configured -> endpoint is closed
  const header = request.headers.get('authorization') ?? '';
  const provided = header.replace(/^Bearer\s+/i, '');
  return timingSafeEqual(provided, token);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function unauthorized(): Response {
  return json({ error: 'unauthorized' }, 401);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Re-export the Durable Object class so Wrangler can bind it.
export { RiskGate } from '@trading/risk/do';
