// Trading-day helpers. The risk gate resets its per-day counters on a trading-day
// boundary. We use the US Eastern calendar day, since that is the session the US
// equities market trades on. Intl with a fixed timeZone is available both in
// Node and in Cloudflare Workers.

const ET_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Trading day for an epoch-ms instant, as an America/New_York `YYYY-MM-DD`
 * string. Deterministic for a given instant.
 */
export function tradingDay(epochMs: number): string {
  // en-CA formats as YYYY-MM-DD.
  return ET_FORMATTER.format(new Date(epochMs));
}
