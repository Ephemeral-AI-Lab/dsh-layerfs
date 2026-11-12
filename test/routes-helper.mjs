// Bundle src/host/routes (and the CLI SDK it uses) with esbuild for tests, and
// build a RouteHost over either a fake lfs or the real pinned CLI.
import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname

/** Import the routes module graph (router.ts plus cli.ts helpers). */
export async function loadRoutes() {
  const out = mkdtempSync(join(tmpdir(), 'dsh-routes-'))
  await build({
    absWorkingDir: root,
    stdin: {
      contents: "export * from './src/host/routes/router.ts'\nexport * as cli from './src/host/layerfs/cli.ts'\nexport { wire } from './src/host/routes/util.ts'\nexport { recordUrl } from './src/host/routes/storage.ts'\n",
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
export function testHost({ lfs, root, home, secrets = join(root, 'secrets'), jobs = join(home, 'job'), stats = join(home, 'stat'), discovery, cli = null, daemon = null, ensureNative = async () => {} }) {
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
    },
  }
}

/** The pinned CLI/daemon (DSH_LAYERFS_* or Connect's desktop/.env.local), or null. */
export function pinned() {
  const env = { cli: process.env.DSH_LAYERFS_CLI, daemon: process.env.DSH_LAYERFS_DAEMON }
  const local = join(root, '..', 'layerfs-connect', 'desktop', '.env.local')
  if (!env.cli && existsSync(local)) {
    for (const line of readFileSync(local, 'utf8').split('\n')) {
      const m = /^LAYERFS_CONNECT_(CLI|DAEMON)=(.+)$/.exec(line.trim())
      if (m) env[m[1].toLowerCase()] ??= m[2]
    }
  }
  return env.cli && existsSync(env.cli) ? env : null
}
