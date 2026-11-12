// The LayerFS build dev servers and live tests use when DSH_LAYERFS_CLI is unset:
// the newest runtime installed in the user's LayerFS home (`$LAYERFS_HOME`, else
// ~/.layerfs), the folder the app installs and pins builds into. Its binaries are
// only read; dev servers and tests still run on a private LayerFS home.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `{ cli, daemon, bundle }` from env, else the newest installed runtime, else null. */
export function runtimePin(env = process.env) {
  if (env.DSH_LAYERFS_CLI) return { cli: env.DSH_LAYERFS_CLI, daemon: env.DSH_LAYERFS_DAEMON ?? null, bundle: env.DSH_LAYERFS_BUNDLE ?? null }
  const root = join(env.LAYERFS_HOME ?? join(homedir(), '.layerfs'), 'runtime')
  let names = []
  try { names = readdirSync(root) } catch { return null }
  const found = names.filter((id) => !id.includes('.tmp-') && existsSync(join(root, id, 'bin', 'layerfs'))).map((id) => {
    const dir = join(root, id)
    let bundle = null
    try { bundle = readdirSync(join(dir, 'bundle')).map((p) => join(dir, 'bundle', p)).find((p) => existsSync(join(p, 'bundle.json'))) ?? null } catch {}
    const daemon = join(dir, 'bin', 'layerfs-daemon')
    return { cli: join(dir, 'bin', 'layerfs'), daemon: existsSync(daemon) ? daemon : null, bundle, at: statSync(join(dir, 'bin', 'layerfs')).mtimeMs }
  }).sort((a, b) => b.at - a.at)
  if (!found[0]) return null
  const { at, ...pin } = found[0]
  return pin
}
