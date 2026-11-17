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
 *
 * Old folders are removed by {@link cleanRuntimes} (layerfs-project#180): it
 * keeps every runtime something may still use and removes only what it can
 * show is unused; anything it cannot tell is kept.
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

export interface InstalledRuntime {
  readonly id: string
  readonly dir: string
  readonly cli: string
  readonly daemon: string | null
  readonly bundle: string | null
  /** Its CLI file's modification time (ms): the build's own time, which an install keeps. Newest first by it. */
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

/**
 * The bundle folder into `bundle/<platform>`: reused when its bundle.json
 * matches. A different one is refused, unless `replace` (no worker machine
 * runs, so none has the old one mounted): then the old folder is renamed away
 * and removed after the new one is in place.
 */
function placeBundle(src: string, dir: string, replace = false): string {
  const dest = join(dir, 'bundle', basename(src))
  if (src === dest) return dest
  if (existsSync(dest)) {
    if (readFileSync(join(src, 'bundle.json'), 'utf8') === readFileSync(join(dest, 'bundle.json'), 'utf8')) return dest
    if (!replace) throw refusal(`This runtime (${basename(dir)}) already has a different Linux bundle for ${basename(src)}; stop the docker and VM machines to replace it`)
    const old = `${dest}.tmp-rm-${randomUUID().slice(0, 8)}`
    renameSync(dest, old)
    try { place(src, dest, true) } catch (error) { renameSync(old, dest); throw error }
    rmSync(old, { recursive: true, force: true })
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
export function installRuntime(home: string, version: string, given: { cli: string, daemon: string | null, bundle: string | null }, options: { replaceBundle?: boolean } = {}): { id: string, cli: string, daemon: string | null, bundle: string | null } {
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
  const bundle = given.bundle ? placeBundle(given.bundle, dir, options.replaceBundle === true) : present?.bundle ?? null
  return { id, cli, daemon, bundle }
}

// ---------------------------------------------------------------- pin leases

/**
 * A host's pin lease on a runtime folder: `<home>/runtime/<id>/pins/<host id>`
 * (a small JSON file naming the host's plugin root). A cleanup on any host
 * keeps a folder that holds a lease, so one host never removes the runtime
 * another host pins. A host moves its lease when its pin moves.
 */
export const hostId = (root: string): string => createHash('sha256').update(root).digest('hex').slice(0, 16)

/** The runtime folder (`<home>/runtime/<id>`) a path lies in, or null. */
export function runtimeOf(home: string, path: string | null | undefined): string | null {
  if (!path) return null
  const root = runtimeRoot(home)
  if (!inside(root, path)) return null
  const id = relative(root, path).split(/[\\/]/)[0]
  return id ? join(root, id) : null
}

/**
 * Leaves this host's lease on the folder holding `cli` (if it is an installed
 * runtime) and removes its lease from every other folder. Never throws.
 */
export function leasePin(home: string, root: string, cli: string | null): void {
  const id = hostId(root)
  const held = runtimeOf(home, cli)
  for (const r of installedRuntimes(home)) {
    const lease = join(r.dir, 'pins', id)
    try {
      if (r.dir === held) {
        mkdirSync(join(r.dir, 'pins'), { recursive: true, mode: 0o700 })
        writeFileSync(lease, `${JSON.stringify({ root, at: new Date().toISOString() })}\n`, { mode: 0o600 })
      } else if (existsSync(lease)) rmSync(lease, { force: true })
    } catch { /* a lease is advisory */ }
  }
}

/**
 * Whether any host holds a lease on the runtime folder `dir`. A lease whose
 * host root is gone (a removed DSH install, a test's temporary folder) holds
 * nothing; an unreadable one still holds.
 */
export function leased(dir: string): boolean {
  let names: string[]
  try { names = readdirSync(join(dir, 'pins')).filter((n) => !n.startsWith('.')) } catch { return false }
  return names.some((n) => {
    try {
      const root = JSON.parse(readFileSync(join(dir, 'pins', n), 'utf8'))?.root
      return typeof root !== 'string' || existsSync(root)
    } catch { return true }
  })
}

// ---------------------------------------------------------------- build identity

/** A piece's build: its commit (40 hex) and whether its tree was dirty; null where it says nothing. */
export interface BuildStamp { readonly commit: string | null, readonly dirty: boolean | null }

/** `matches` (same commit, both clean), `other` (different commits), `unknown` (a commit or a clean tree cannot be told), `missing` (no such piece). */
export type Verdict = 'matches' | 'other' | 'unknown' | 'missing'

/** LayerFS's rule (`home get` `matches`): false when the commits differ, true when equal and both clean, else unknown. */
export function verdictOf(cli: BuildStamp | null, piece: BuildStamp | null): Verdict {
  if (!piece) return 'missing'
  if (!cli?.commit || !piece.commit) return 'unknown'
  if (cli.commit !== piece.commit) return 'other'
  return cli.dirty === false && piece.dirty === false ? 'matches' : 'unknown'
}

/** A Linux bundle's build from its bundle.json (`source.head`, `source.dirty`), or null when unreadable. */
export function bundleStamp(dir: string | null | undefined): BuildStamp | null {
  if (!dir) return null
  try {
    const b = JSON.parse(readFileSync(join(dir, 'bundle.json'), 'utf8'))
    const head = typeof b?.source?.head === 'string' && /^[0-9a-f]{40}$/.test(b.source.head) ? b.source.head : null
    return { commit: head, dirty: typeof b?.source?.dirty === 'boolean' ? b.source.dirty : null }
  } catch { return null }
}

const stamps = new Map<string, { key: string, stamp: BuildStamp }>()
const MARK = Buffer.from('layerfs-build-identity:')

/**
 * A `layerfs-daemon`'s build from the identity LayerFS stamps into it
 * (`layerfs-build-identity:<commit>:clean|dirty`), read from the file, never
 * by running it; kept by path, size and modification time. A daemon from
 * before the stamp answers `{ commit: null, dirty: null }`; a missing file null.
 */
export function daemonStamp(path: string | null | undefined): BuildStamp | null {
  if (!path) return null
  let st
  try { st = statSync(path) } catch { return null }
  const key = `${st.size}:${st.mtimeMs}`
  const kept = stamps.get(path)
  if (kept?.key === key) return kept.stamp
  let stamp: BuildStamp = { commit: null, dirty: null }
  try {
    const data = readFileSync(path)
    for (let at = data.indexOf(MARK); at >= 0; at = data.indexOf(MARK, at + 1)) {
      const m = /^([0-9a-f]{40}):(clean|dirty)/.exec(data.subarray(at + MARK.length, at + MARK.length + 48).toString('latin1'))
      if (m) { stamp = { commit: m[1]!, dirty: m[2] === 'dirty' }; break }
    }
  } catch { /* unreadable: unknown */ }
  stamps.set(path, { key, stamp })
  return stamp
}

// ---------------------------------------------------------------- cleanup

/** How many of the newest runtimes a cleanup always keeps, whatever else holds. */
export const KEEP_NEWEST = 3

/** Why a cleanup kept a runtime. */
export type KeptWhy =
  /** A pin names it (this host's CLI, daemon or bundle; a saved or environment pin). */
  | 'pinned'
  /** One of the {@link KEEP_NEWEST} newest. */
  | 'newest'
  /** `machine.list()` names a path inside it (a machine record's `daemon`, …). */
  | 'machine'
  /** A running process was started from it (a native Sandbox's daemon, a CLI call). */
  | 'process'
  /** It has a Linux bundle and a worker machine is not stopped: its worker may have the bundle mounted. */
  | 'worker'
  /** A host's pin lease names it (`pins/<host id>`): another host sharing this home pins it. */
  | 'lease'
  /** A fact could not be read (machines, processes) or the folder is not a plain folder here: kept. */
  | 'unknown'

/** What a cleanup may rely on. A fact that could not be read is null, and then nothing is removed. */
export interface CleanupFacts {
  /** Pinned paths (CLI, daemon, bundle of this host's pin, its saved pin and the environment's). */
  readonly pinned: readonly (string | null | undefined)[]
  /** `machine.list()`'s answer as LayerFS gave it (`{ machines: [...] }`), or null when it could not be read. */
  readonly machines: unknown | null
  /** The command line of every running process (`ps`), or null when they could not be listed. */
  readonly processes: readonly string[] | null
  /** How many of the newest to keep (default {@link KEEP_NEWEST}). */
  readonly newest?: number
}

/** What a cleanup did. */
export interface RuntimeCleanup {
  readonly kept: { readonly id: string, readonly why: KeptWhy }[]
  readonly removed: string[]
  readonly failed: { readonly id: string, readonly message: string }[]
}

const real = (path: string): string => { try { return realpathSync(path) } catch { return path } }
const within = (dir: string, path: string): boolean => path === dir || inside(dir, path)

/** Every string anywhere in a JSON value. */
function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof value === 'string') out.push(value)
  else if (value && typeof value === 'object' && depth < 12) for (const v of Array.isArray(value) ? value : Object.values(value)) strings(v, out, depth + 1)
  return out
}

/**
 * Whether a worker may have a runtime's bundle mounted. LayerFS does not
 * report which bundle folder a running docker worker bind-mounts
 * (`machine.list`/`status` carry no path), so this answers for all bundles at
 * once: true unless every machine that is not `native` is `stopped`. A machine
 * with no readable platform or state counts as running.
 */
function workersMayRun(machines: readonly unknown[]): boolean {
  return machines.some((m: any) => !(m && typeof m === 'object' && (m.platform === 'native' || m.state === 'stopped')))
}

/**
 * Which installed runtimes a cleanup keeps (and why) and which it may remove.
 * Pure: it reads only `facts` and the list. Kept, in this order of reasons:
 * a pinned one, the newest few, one a machine record names, one a running
 * process was started from, one with a bundle while a worker machine is not
 * stopped; and all of them when a fact is missing.
 */
export function planRuntimeCleanup(runtimes: readonly InstalledRuntime[], facts: CleanupFacts): { keep: Map<string, KeptWhy>, remove: InstalledRuntime[] } {
  const keep = new Map<string, KeptWhy>()
  const remove: InstalledRuntime[] = []
  const list = (facts.machines as any)?.machines
  const known = Array.isArray(list) && Array.isArray(facts.processes)
  const pinned = facts.pinned.filter((p): p is string => typeof p === 'string' && !!p).flatMap((p) => [p, real(p)])
  const named = known ? strings(list).filter((s) => s.startsWith('/')).flatMap((p) => [p, real(p)]) : []
  const mayRun = known ? workersMayRun(list) : true
  const newest = Math.max(0, facts.newest ?? KEEP_NEWEST)
  // newest first, as installedRuntimes answers
  runtimes.forEach((r, index) => {
    const dirs = [r.dir, real(r.dir)]
    const holds = (paths: readonly string[]) => paths.some((p) => dirs.some((d) => within(d, p)))
    const why: KeptWhy | null = holds(pinned) ? 'pinned'
      : leased(r.dir) ? 'lease'
      : index < newest ? 'newest'
      : !known ? 'unknown'
      : holds(named) ? 'machine'
      : facts.processes!.some((line) => dirs.some((d) => line.includes(`${d}/`))) ? 'process'
      : mayRun && existsSync(join(r.dir, 'bundle')) ? 'worker'
      : null
    if (why) keep.set(r.id, why)
    else remove.push(r)
  })
  return { keep, remove }
}

/** The command line of every running process, or null when `ps` cannot tell. */
export function runningCommands(): string[] | null {
  try {
    const out = execFileSync('/bin/ps', ['-axww', '-o', 'command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    const lines = out.split('\n').filter(Boolean)
    return lines.length ? lines : null
  } catch { return null }
}

/**
 * Removes the installed runtimes nothing uses ({@link planRuntimeCleanup}).
 * A folder goes by a rename to `<id>.tmp-rm-<8 hex>` (so it is no longer
 * listed), then a recursive delete; a rename left from an earlier run is
 * deleted too. Only plain folders directly inside `<home>/runtime` are
 * touched, never a symlink. Never throws.
 */
export function cleanRuntimes(home: string, facts: CleanupFacts): RuntimeCleanup {
  const result: RuntimeCleanup = { kept: [], removed: [], failed: [] }
  const root = runtimeRoot(home)
  let plan: ReturnType<typeof planRuntimeCleanup>
  try { plan = planRuntimeCleanup(installedRuntimes(home), facts) } catch (error: any) {
    result.failed.push({ id: '*', message: String(error?.message ?? error) })
    return result
  }
  for (const [id, why] of plan.keep) result.kept.push({ id, why })
  for (const r of plan.remove) {
    try {
      const st = lstatSync(r.dir)
      if (!st.isDirectory() || dirname(r.dir) !== root || real(r.dir) !== join(real(root), r.id)) { result.kept.push({ id: r.id, why: 'unknown' }); continue }
      const gone = `${r.dir}.tmp-rm-${randomUUID().slice(0, 8)}`
      renameSync(r.dir, gone)
      result.removed.push(r.id)
      rmSync(gone, { recursive: true, force: true })
    } catch (error: any) {
      result.failed.push({ id: r.id, message: String(error?.message ?? error) })
    }
  }
  // what an interrupted removal left: already renamed away by this function, so nothing uses it
  if (plan.remove.length || result.removed.length) {
    try {
      for (const name of readdirSync(root)) {
        if (!/\.tmp-rm-[0-9a-f]{8}$/.test(name)) continue
        const path = join(root, name)
        try { if (lstatSync(path).isDirectory()) rmSync(path, { recursive: true, force: true }) } catch { /* next cleanup */ }
      }
    } catch { /* no runtime folder */ }
  }
  return result
}
