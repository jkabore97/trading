// Installs the repo's git hooks by pointing core.hooksPath at .githooks and
// ensuring the hooks are executable. Runs from the root `prepare` script so a
// fresh `pnpm install` wires up the secret-scanning pre-commit hook.
//
// Silently no-ops when there is no .git directory (e.g. CI checkouts that set
// their own hooks, or when installed as a dependency).

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(join(root, '.git'))) {
  process.exit(0);
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' });
  const hook = join(root, '.githooks', 'pre-commit');
  if (existsSync(hook)) {
    chmodSync(hook, 0o755);
  }
  console.log('git hooks installed (core.hooksPath = .githooks)');
} catch (err) {
  // Non-fatal: a developer without git, or a restricted CI env, should still install deps.
  console.warn('could not install git hooks:', err instanceof Error ? err.message : err);
}
