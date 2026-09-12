// Pure risk logic only. The Durable Object (which imports `cloudflare:workers`)
// is exposed via the `@trading/risk/do` subpath so Node/Vitest consumers of the
// pure gate never load the workers-only module.
export * from './gate.js';
