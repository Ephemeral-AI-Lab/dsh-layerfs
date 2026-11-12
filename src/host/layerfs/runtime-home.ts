/**
 * The LayerFS runtime kept in the LayerFS home (docs/specs/homes.md §3):
 *
 *   <home>/runtime/<version>-<cli sha256, 12>/
 *     bin/layerfs            the CLI
 *     bin/layerfs-daemon     the native machine's daemon (macOS)
 *     bundle/<platform>/     the Linux bundle (bundle.json) docker/VM machines start from
 *
 * One folder per CLI build, so hosts sharing a home can pin different builds.
 * A folder is filled once: a later install into it must bring the same files
 * (a different daemon or bundle for the same CLI is refused, never replaced,
 * since a running machine may be using them). On macOS copies are APFS clones
 * (`cp -c`), so the 3 GB bundle costs no space; elsewhere they are plain copies.
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

export interface InstalledRuntime {
  readonly id: string
  readonly dir: string
  readonly cli: string
  readonly daemon: string | null
  readonly bundle: string | null
  /** When the folder was installed (ms). */
  readonly at: number
}

/** `<home>/runtime`. */
export const runtimeRoot = (home: string): string => join(home, 'runtime')

/** Whether `path` lies inside `dir`. */
export function inside(dir: string, path: string): boolean {
  const r = relative(dir, path)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

/** The installed runtimes, newest first. */
export function installedRuntimes(home: string): InstalledRuntime[] {
  const root = runtimeRoot(home)
  let names: string[]
  try { names = readdirSync(root) } catch { return [] }
  const found: InstalledRuntime[] = []
  for (const id of names) {
    const dir = join(root, id)
    const cli = join(dir, 'bin', 'layerfs')
    if (id.includes('.tmp-') || !existsSync(cli)) continue
    const daemon = join(dir, 'bin', 'layerfs-daemon')
    let bundle: string | null = null
    try { bundle = readdirSync(join(dir, 'bundle')).map((p) => join(dir, 'bundle', p)).find((p) => existsSync(join(p, 'bundle.json'))) ?? null } catch {}
    found.push({ id, dir, cli, daemon: existsSync(daemon) ? daemon : null, bundle, at: statSync(cli).mtimeMs })
  }
  return found.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
}

/** The folder name for a CLI build: `<version>-<sha256 of the CLI, 12>`. */
export function runtimeId(cli: string, version: string): string {
  const v = String(version || 'unknown').replace(/[^0-9A-Za-z_.+-]/g, '-')
  return `${v}-${sha256(cli).slice(0, 12)}`
}

function refusal(message: string): Error {
  return Object.assign(new Error(message), { code: 'InvalidInput', transport: 'refusal' })
}

/** Copies `src` to `dest` through a temporary sibling, cloning where the filesystem can. */
function place(src: string, dest: string, folder: boolean): void {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
  const tmp = `${dest}.tmp-${randomUUID().slice(0, 8)}`
  const from = realpathSync(src)
  try {
    // Node's COPYFILE_FICLONE does not clone on macOS; cp -c does (clonefile)
    let cloned = false
    if (process.platform === 'darwin') {
      try { execFileSync('/bin/cp', ['-c', ...(folder ? ['-R'] : []), '-p', from, tmp], { stdio: 'ignore' }); cloned = true } catch { rmSync(tmp, { recursive: true, force: true }) }
    }
    if (!cloned) cpSync(from, tmp, { recursive: folder, preserveTimestamps: true })
    renameSync(tmp, dest)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** One file into the runtime folder: reused when the same bytes are already there, refused when different. */
function placeFile(src: string, dest: string, what: string): string {
  if (src === dest) return dest
  if (existsSync(dest)) {
    if (sha256(src) !== sha256(dest)) throw refusal(`This runtime (${basename(dirname(dirname(dest)))}) already has a different ${what}; install the matching one, or a different CLI build`)
    return dest
  }
  place(src, dest, false)
  chmodSync(dest, 0o755)
  return dest
}

/** The bundle folder into `bundle/<platform>`: reused when its bundle.json matches, refused when different. */
function placeBundle(src: string, dir: string): string {
  const dest = join(dir, 'bundle', basename(src))
  if (src === dest) return dest
  if (existsSync(dest)) {
    if (readFileSync(join(src, 'bundle.json'), 'utf8') !== readFileSync(join(dest, 'bundle.json'), 'utf8')) throw refusal(`This runtime (${basename(dir)}) already has a different Linux bundle for ${basename(src)}`)
    return dest
  }
  place(src, dest, true)
  return dest
}

/**
 * Installs a CLI (and its daemon and bundle) into `<home>/runtime/<id>` and
 * answers the paths to pin there. Paths already inside that folder are kept.
 * The home folder is made owner-only when this creates it (LayerFS requires 0700).
 */
export function installRuntime(home: string, version: string, given: { cli: string, daemon: string | null, bundle: string | null }): { id: string, cli: string, daemon: string | null, bundle: string | null } {
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 })
  const root = runtimeRoot(home)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const id = runtimeId(given.cli, version)
  const dir = join(root, id)
  mkdirSync(join(dir, 'bin'), { recursive: true, mode: 0o700 })
  const cli = placeFile(given.cli, join(dir, 'bin', 'layerfs'), 'CLI')
  // not given: keep what this folder already has
  const present = installedRuntimes(home).find((r) => r.id === id)
  const daemon = given.daemon ? placeFile(given.daemon, join(dir, 'bin', 'layerfs-daemon'), 'daemon') : present?.daemon ?? null
  const bundle = given.bundle ? placeBundle(given.bundle, dir) : present?.bundle ?? null
  return { id, cli, daemon, bundle }
}
