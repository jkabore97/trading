import { defineConfig } from 'vitest/config';

// Single root Vitest config that discovers tests across every workspace package.
// Keeping one config (rather than per-package) makes the parity test — which imports
// from several packages at once — trivial to run and keeps CI to a single command.
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.wrangler/**'],
    environment: 'node',
    globals: false,
  },
});
