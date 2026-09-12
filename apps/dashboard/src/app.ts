// Read-only dashboard. Fetches the Worker's JSON APIs and renders them. No
// writes, no controls that mutate state (the kill switch is intentionally NOT
// here — it is an authenticated operator action, not a dashboard button).
//
// The Worker base URL comes from `?api=<url>` (persisted to localStorage) so the
// static page on Pages can point at the deployed Worker.

interface RiskState {
  tradingDay: string | null;
  ordersToday: number;
  dayStartEquity: number | null;
  killSwitchEngaged: boolean;
  halted: boolean;
  haltReason: string | null;
}
interface Position {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
}
interface StateResponse {
  mode: string;
  risk: RiskState;
  positions: Record<string, Position>;
}
interface Cycle {
  id: string;
  mode: string;
  as_of: number;
  started_at: number;
  finished_at: number | null;
  status: string;
  detail: string | null;
}

const API_KEY = 'trading_dashboard_api';

function apiBase(): string {
  const url = new URL(location.href);
  const fromQuery = url.searchParams.get('api');
  if (fromQuery) {
    try {
      localStorage.setItem(API_KEY, fromQuery);
    } catch {
      /* ignore */
    }
    return fromQuery.replace(/\/$/, '');
  }
  try {
    return (localStorage.getItem(API_KEY) ?? '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function fmtMoney(n: number | null): string {
  if (n === null) return '—';
  return `$${n.toFixed(2)}`;
}
function fmtTime(ms: number | null): string {
  return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '—';
}

async function refresh(): Promise<void> {
  const base = apiBase();
  const status = el('status');
  if (!base) {
    status.textContent = 'No API URL set. Append ?api=https://your-worker.workers.dev';
    return;
  }
  status.textContent = `Loading from ${base} …`;
  try {
    const [stateRes, cyclesRes] = await Promise.all([
      fetch(`${base}/api/state`),
      fetch(`${base}/api/cycles`),
    ]);
    const state = (await stateRes.json()) as StateResponse;
    const { cycles } = (await cyclesRes.json()) as { cycles: Cycle[] };
    renderState(state);
    renderCycles(cycles);
    status.textContent = `Updated ${new Date().toISOString().slice(11, 19)} UTC · mode: ${state.mode}`;
  } catch (err) {
    status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function renderState(state: StateResponse): void {
  const r = state.risk;
  const banner = el('banner');
  if (r.killSwitchEngaged) {
    banner.className = 'banner kill';
    banner.textContent = `KILL SWITCH ENGAGED — ${r.haltReason ?? ''}`;
  } else if (r.halted) {
    banner.className = 'banner halt';
    banner.textContent = `HALTED — ${r.haltReason ?? ''}`;
  } else {
    banner.className = 'banner ok';
    banner.textContent = `Trading active · mode ${state.mode}`;
  }

  el('risk').innerHTML = `
    <div><span>Mode</span><b>${state.mode}</b></div>
    <div><span>Trading day</span><b>${r.tradingDay ?? '—'}</b></div>
    <div><span>Orders today</span><b>${r.ordersToday}</b></div>
    <div><span>Day start equity</span><b>${fmtMoney(r.dayStartEquity)}</b></div>
    <div><span>Kill switch</span><b>${r.killSwitchEngaged ? 'ON' : 'off'}</b></div>
    <div><span>Halted</span><b>${r.halted ? 'yes' : 'no'}</b></div>`;

  const positions = Object.values(state.positions);
  el('positions').innerHTML = positions.length
    ? `<table><thead><tr><th>Symbol</th><th>Qty</th><th>Avg entry</th></tr></thead><tbody>${positions
        .map(
          (p) =>
            `<tr><td>${p.symbol}</td><td>${p.qty}</td><td>${fmtMoney(p.avgEntryPrice)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">No open positions.</p>';
}

function renderCycles(cycles: Cycle[]): void {
  el('cycles').innerHTML = cycles.length
    ? `<table><thead><tr><th>as_of</th><th>mode</th><th>status</th><th>detail</th></tr></thead><tbody>${cycles
        .map(
          (c) =>
            `<tr class="s-${c.status}"><td>${fmtTime(c.as_of)}</td><td>${c.mode}</td><td>${c.status}</td><td class="detail">${
              c.detail ? escapeHtml(c.detail).slice(0, 200) : ''
            }</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">No cycles yet.</p>';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

el('refresh').addEventListener('click', () => void refresh());
void refresh();
setInterval(() => void refresh(), 30_000);
