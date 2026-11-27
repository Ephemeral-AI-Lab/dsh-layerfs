// Bundle src/host/routes (and the CLI SDK it uses) with esbuild for tests, and
// build a RouteHost over either a fake lfs or the real pinned CLI.
import { build } from 'esbuild'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { liveCli, liveSkipReason } from './support/env.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Import the routes module graph (router.ts plus cli.ts helpers). */
export async function loadRoutes() {
  const out = mkdtempSync(join(tmpdir(), 'dsh-routes-'))
  await build({
    absWorkingDir: root,
    stdin: {
      contents: "export * from './src/host/routes/router.ts'\nexport * as cli from './src/host/layerfs/cli.ts'\nexport { wire } from './src/host/routes/util.ts'\nexport { recordUrl } from './src/host/routes/storage.ts'\nexport * as util from './src/host/routes/util.ts'\nexport * as machinesModule from './src/host/routes/machines.ts'\nexport * as creates from './src/host/routes/sandbox-creates.ts'\nexport * as exportsModule from './src/host/routes/project-exports.ts'\nexport * as inspect from './src/host/routes/inspect.ts'\nexport { sessionOfSandbox } from './src/host/routes/projects.ts'\n",
      resolveDir: root,
      loader: 'ts',
    },
    outfile: join(out, 'routes.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    logLevel: 'warning',
  })
  return import(pathToFileURL(join(out, 'routes.mjs')).href)
}

/** A RouteHost for tests. */
export function testHost({ lfs, root, home, secrets = join(root, 'secrets'), jobs = join(home, 'job'), stats = join(home, 'stat'), discovery, cli = null, daemon = null, ensureNative = async () => {}, sessionOf = undefined }) {
  const events = []
  const logs = []
  return {
    events,
    logs,
    host: {
      lfs: () => lfs,
      home,
      root,
      secrets,
      jobs,
      stats,
      cli: () => cli,
      daemon: () => daemon,
      discover: discovery,
      ensureNative,
      emit: (type, data) => events.push({ type, data }),
      log: (line) => logs.push(line),
      ...(sessionOf ? { sessionOf } : {}),
    },
  }
}

/** The pinned CLI/daemon (DSH_LAYERFS_*, else the newest runtime in ~/.layerfs), unpinned from a wrapper that fixes LAYERFS_HOME, or null. */
export function pinned() {
  return liveCli()
}

export { liveSkipReason }
