// The environment the live suites need, once: a directory on a filesystem LayerFS
// can create a Store on, and the pinned CLI without a managed wrapper that pins
// LAYERFS_ROOT. A test that makes a real Store creates its case under tmpRoot();
// a live test uses liveCli() and skips with liveSkipReason() when no CLI can be
// pointed at a private home.
//
// Why: /tmp is an overlay (or tmpfs) here and SQLite's locks do not carry between
// kernels there (`store create` refuses `Unsupported`), while the managed
// `<state>/bin/layerfs` wrapper exports a fixed LAYERFS_ROOT, so a test that sets
// LAYERFS_ROOT to its own folder would talk to the user's home instead.
//
// A private home: make a root (`root = tmpRoot()`), run the CLI with
// `LAYERFS_ROOT: root` and hand dsh-layerfs `home: join(root, 'home')`, the home
// LayerFS finds in a root without layerfs.json (folder.ts `rootOf` maps it back).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, statfsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runtimePin } from '../../scripts/runtime-pin.mjs'

// ext4, xfs, btrfs: the filesystems LayerFS accepts for a Store's SQLite locks.
const STORE_FILESYSTEMS = new Set([0xef53, 0x58465342, 0x9123683e])

function filesystemType(path) {
  try { return Number(statfsSync(path).type) } catch { return null }
}

let base
/** The directory Store-capable case folders live under (TMPDIR when it can hold a Store, else `$HOME/tmp/dsh-tests`). */
export function storeBase() {
  if (base) return base
  const configured = process.env.LAYERFS_TEST_TMPDIR
  if (configured) { mkdirSync(configured, { recursive: true }); return (base = configured) }
  const system = tmpdir()
  if (STORE_FILESYSTEMS.has(filesystemType(system))) return (base = system)
  const home = join(homedir(), 'tmp', 'dsh-tests')
  mkdirSync(home, { recursive: true })
  return (base = home)
}

/** A fresh case folder on a Store-capable filesystem; the caller removes it when the test ends. */
export function tmpRoot(prefix = 'dsh-test-') {
  return mkdtempSync(join(storeBase(), prefix))
}

/** Whether `cli` honours the LAYERFS_ROOT given to it (a managed wrapper or a CLI older than LAYERFS_ROOT does not). */
function obeysRoot(cli, root) {
  const run = spawnSync(cli, ['home', 'get'], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, LAYERFS_ROOT: root },
  })
  try {
    const answer = JSON.parse(run.stdout)
    return answer?.home === join(root, 'home')
  } catch { return false }
}

/** The binaries a wrapper names, plus the usual unpinned sibling locations. */
function candidates(selected) {
  const found = []
  if (process.env.DSH_LAYERFS_TEST_CLI) found.push(process.env.DSH_LAYERFS_TEST_CLI)
  // The binary a managed wrapper itself runs is the exact build it would have used.
  try {
    const text = readFileSync(selected.cli, 'utf8')
    for (const pattern of [/^\s*cli=['"]?([^'"\s]+)['"]?/m, /^\s*(?:exec\s+)?['"]?(\/[^'"\s]*\/layerfs)['"]?/m]) {
      const named = pattern.exec(text)?.[1]
      if (named) found.push(named)
    }
  } catch { /* not a readable script (a binary): only the fixed locations below */ }
  found.push(join(homedir(), 'layerfs-bin', 'layerfs'))
  found.push(join(dirname(selected.cli), '..', '..', 'layerfs-bin', 'layerfs'))
  return [...new Set(found)].filter((path) => path && path !== selected.cli && existsSync(path) && statSync(path).isFile())
}

let resolved
/** The pinned CLI when it can use a private home, else an unpinned sibling, else null. */
export function liveCli() {
  if (resolved !== undefined) return resolved
  const selected = runtimePin()
  if (!selected?.cli || !existsSync(selected.cli)) return (resolved = null)
  // A root that does not exist: an obedient CLI names <probe>/home, a wrapper pins its own home.
  const probe = join(storeBase(), `probe-${process.pid}-${Date.now()}`)
  if (obeysRoot(selected.cli, probe)) return (resolved = selected)
  for (const path of candidates(selected)) {
    if (!obeysRoot(path, probe)) continue
    const daemon = join(dirname(path), 'layerfs-daemon')
    let bundle = selected.bundle
    if (!bundle) {
      const named = /^\s*export\s+LAYERFS_BUNDLE=['"]?([^'"\s]+)['"]?/m.exec(readFileSync(selected.cli, 'utf8').slice(0, 64 * 1024))?.[1]
      if (named && existsSync(named)) bundle = named
    }
    return (resolved = { cli: path, daemon: existsSync(daemon) ? daemon : null, bundle })
  }
  return (resolved = null)
}

/** Why no live CLI is usable here, or false when one is. */
export function liveSkipReason() {
  if (liveCli()) return false
  const selected = runtimePin()
  if (!selected?.cli) return 'no pinned LayerFS CLI (set DSH_LAYERFS_CLI or install a runtime in ~/.layerfs/runtime)'
  if (!existsSync(selected.cli)) return `the selected LayerFS CLI does not exist (${selected.cli})`
  return 'the selected CLI does not honour LAYERFS_ROOT: a managed wrapper or a CLI older than LAYERFS_ROOT (set DSH_LAYERFS_TEST_CLI to an unpinned current CLI)'
}
