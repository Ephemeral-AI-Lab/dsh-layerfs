// Bundle packages/client with the deepseek-harness checkout's tsdown.
// Portable: no shell, so Windows cmd.exe and POSIX shells run the same script.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dshRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const clientDir = join(dshRoot, 'packages', 'client');
// `||`, not `??`: an empty DSH_SOURCE takes the default, like `${DSH_SOURCE:-...}`.
const dshSource = resolve(
  clientDir,
  process.env.DSH_SOURCE || '../../../../deepseek-harness',
);
const hint = `set DSH_SOURCE to a built deepseek-harness checkout (looked in ${dshSource})`;
const packageJson = join(dshSource, 'node_modules', 'tsdown', 'package.json');

if (!existsSync(packageJson)) {
  console.error(`tsdown: No such file or directory\n${hint}`);
  process.exit(1);
}

const { bin } = JSON.parse(readFileSync(packageJson, 'utf8'));
const cli = join(dshSource, 'node_modules', 'tsdown', typeof bin === 'string' ? bin : bin.tsdown);
if (!existsSync(cli)) {
  console.error(`tsdown: No such file or directory (${cli})\n${hint}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: clientDir,
  // The CLI and its config must use the same checkout, including for empty input.
  env: { ...process.env, DSH_SOURCE: dshSource },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
