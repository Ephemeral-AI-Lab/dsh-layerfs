/**
 * `ctx.layerfs`: the pinned LayerFS runtime for this DSH host — which CLI and
 * daemon, which LAYERFS_HOME, the SDK-shaped client over them, host events,
 * and the plugin's own durable state file.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { boolOptions, CliError, client, discover, hasNativeLogs, knownIdentity, knownNativeLogs, plain, type Discovery, type Lfs } from './layerfs/cli.ts'
import { managedCli } from './layerfs/tracing.ts'
import { findSdk, managedSdk } from './layerfs/agent-sdk.ts'
import { fileURLToPath } from 'node:url'

/** This package's root: the nearest folder above this module with dsh-layerfs's package.json. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    try { if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'dsh-layerfs') return dir } catch { /* keep looking */ }
    const up = dirname(dir)
    if (up === dir) return process.cwd()
    dir = up
  }
}
import { installRuntime, installedRuntimes } from './layerfs/runtime-home.ts'
import type { LayerfsRemote } from './remote.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    layerfs: LayerfsService
  }
}

/** Plugin configuration (bundle patch row `layerfs`). */
export interface LayerfsConfig {
  /** Plugin root: this DSH install's dsh-layerfs state (docs/specs/homes.md); default `$DSH_HOME/layerfs`. */
  root?: string
  /** Unpacked project-session logs and annotations; default `<root>/project-sessions`, or DSH_LAYERFS_SESSION_HOME. */
  projectSessionHome?: string
  /** Absolute pinned `layerfs` CLI; else runtime.json, else DSH_LAYERFS_CLI, else the newest runtime installed in the home. */
  cli?: string
  /** Absolute matching `layerfs-daemon` (macOS native machine). */
  daemon?: string
  /** Absolute Linux bundle folder (holds bundle.json) the docker/VM machines start workers from. */
  bundle?: string
  /**
   * Absolute XDG cache home LayerFS reads prepared machine OS images from
   * (`<cacheHome>/layerfs/machine-images`, built by LayerFS `tools/machine_image.py`);
   * passed to every CLI as XDG_CACHE_HOME. Else runtime.json, else
   * DSH_LAYERFS_CACHE_HOME, else the host's own XDG_CACHE_HOME (else `~/.cache`).
   */
  cacheHome?: string
  /** LAYERFS_HOME, LayerFS's own and independent of DSH; else DSH_LAYERFS_HOME, else LAYERFS_HOME, else `~/.layerfs`. */
  home?: string
  /**
   * Where keys and passwords entered in the panel are saved (owner-only files,
   * passed to LayerFS as `file:` references); default `<home>/secret`, or
   * DSH_LAYERFS_SECRETS.
   */
  secrets?: string
  /** The `<store>/<name>` project sessions without a project of their own work in (a SQLite Store on native, made on first use). */
  scratchProject?: string
  /** Checkpoint each turn that changed files. */
  checkpoints?: 'turn' | 'off'
  /** Close an idle session's Sandbox after this many minutes (0 = never). */
  idleMinutes?: number
}

/** What Settings / the Machines header show about the runtime. */
export interface RuntimeStatus {
  readonly ok: boolean
  readonly cli: string | null
  readonly daemon: string | null
  readonly bundle: string | null
  /** The bundle's sealed hash and source commit (bundle.json), when readable. */
  readonly bundleInfo: { readonly hash: string | null, readonly source: string | null } | null
  /** The XDG cache home the CLI reads prepared machine images from (effective, pinned or inherited). */
  readonly cacheHome: string
  /** Where cacheHome came from; `inherited`: the host's XDG_CACHE_HOME, `default`: `~/.cache`. */
  readonly cacheHomeSource: 'config' | 'settings' | 'env' | 'inherited' | 'default'
  /** Prepared VM OS images installed there (`layerfs/machine-images/<provider>/<platform>/<image>/current.json`). */
  readonly preparedImages: number
  readonly home: string
  readonly root: string
  readonly projectSessionHome: string
  readonly scratchProject: string
  /** `layerfs`: the bundle's session persistence row runs (missing sessions are imported from LayerFS); `stock`: DSH's own. */
  readonly sessionPersistence: 'layerfs' | 'stock' | 'none'
  readonly checkpoints: 'turn' | 'off'
  /** Where the pin came from; `home`: the newest runtime installed in the LayerFS home. */
  readonly source: 'config' | 'settings' | 'env' | 'home' | 'none'
  readonly version: string | null
  readonly commit: string | null
  readonly features: readonly string[]
  /** The Node SDK agents import as `$DSH_LAYERFS_SDK`: the install built from the CLI's commit, or null with where it is looked for. */
  readonly sdk: { readonly dir: string, readonly commit: string } | null
  readonly sdkDir: string | null
  readonly error: { readonly code: string, readonly message: string } | null
}

/** A small JSON document in the plugin root, written atomically. */
export class JsonFile<T> {
  private value: T | undefined
  constructor(readonly path: string, private readonly initial: () => T) {}
  read(): T {
    if (this.value === undefined) {
      try { this.value = JSON.parse(readFileSync(this.path, 'utf8')) as T } catch { this.value = this.initial() }
    }
    return this.value
  }
  write(next: T): void {
    this.value = next
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.path)
  }
  update(fn: (draft: T) => T | void): T {
    const draft = structuredClone(this.read())
    const next = (fn(draft) ?? draft) as T
    this.write(next)
    return next
  }
}

const abs = (v: unknown): string | undefined => typeof v === 'string' && isAbsolute(v) ? v : undefined


/** The LayerFS runtime service. */
export class LayerfsService extends Service {
  static inject = ['layerfsRemote']
  readonly root: string
  /** The stand-in call log, `<root>/trace/calls.jsonl` (docs/specs/layerfs-logs.md §3). */
  readonly callLog: string
  readonly projectSessionHome: string
  readonly home: string
  /** The folder entered keys and passwords are saved in (see LayerfsConfig.secrets). */
  readonly secrets: string
  /** Storage job tables in the LayerFS home, named for no client: `<home>/job` (storage-jobs.json, doctor-jobs.json). */
  readonly jobDir: string
  /** Storage statistics in the LayerFS home: `<home>/stat` (storage-observations/, project-storage/). */
  readonly statDir: string
  readonly scratchProject: string
  readonly checkpoints: 'turn' | 'off'
  readonly idleMinutes: number
  /** `<root>/runtime.json`: the CLI/daemon chosen in the UI (wins over env). */
  readonly settings: JsonFile<{ cli?: string, daemon?: string, bundle?: string, cacheHome?: string }>
  private pin!: { cli: string | null, daemon: string | null, bundle: string | null, cacheHome: string | null, cacheHomeSource: RuntimeStatus['cacheHomeSource'], source: RuntimeStatus['source'] }
  private sdk: Lfs | undefined
  private nativeRecorded: Promise<unknown> | undefined
  /** Set while an operation holds the whole home (a preset build or reset): why new Sandboxes must wait, or null. */
  exclusive: (() => string | null) | undefined

  constructor(ctx: Context, private readonly config: LayerfsConfig = {}) {
    super(ctx, 'layerfs')
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    this.root = abs(config.root) ?? join(dshHome, 'layerfs')
    this.callLog = join(this.root, 'trace', 'calls.jsonl')
    this.projectSessionHome = abs(config.projectSessionHome) ?? abs(process.env.DSH_LAYERFS_SESSION_HOME) ?? join(this.root, 'project-sessions')
    this.home = abs(config.home) ?? abs(process.env.DSH_LAYERFS_HOME) ?? abs(process.env.LAYERFS_HOME) ?? join(homedir(), '.layerfs')
    this.secrets = abs(config.secrets) ?? abs(process.env.DSH_LAYERFS_SECRETS) ?? join(this.home, 'secret')
    this.jobDir = join(this.home, 'job')
    this.statDir = join(this.home, 'stat')
    this.scratchProject = config.scratchProject ?? 'dsh-scratch/scratch'
    if (!/^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(this.scratchProject)) {
      throw new Error(`dsh-layerfs: scratchProject must be "<store>/<name>" in LayerFS names, not ${JSON.stringify(this.scratchProject)}`)
    }
    this.checkpoints = config.checkpoints === 'off' ? 'off' : 'turn'
    this.idleMinutes = Number.isFinite(config.idleMinutes) ? Math.max(0, Number(config.idleMinutes)) : 30
    this.settings = new JsonFile(join(this.root, 'runtime.json'), () => ({}))
    this.resolvePin()
  }

  private resolvePin(): void {
    const saved = this.settings.read()
    const c = abs(this.config.cli), s = abs(saved.cli), e = abs(process.env.DSH_LAYERFS_CLI)
    // nothing pinned: the newest runtime installed in the LayerFS home
    const h = c || s || e ? undefined : installedRuntimes(this.home)[0]
    const cli = c ?? s ?? e ?? h?.cli ?? null
    const source = c ? 'config' : s ? 'settings' : e ? 'env' : h ? 'home' : 'none'
    const daemon = (c ? abs(this.config.daemon) : s ? abs(saved.daemon) : e ? abs(process.env.DSH_LAYERFS_DAEMON) : h?.daemon) ?? null
    const bundle = (c ? abs(this.config.bundle) : s ? abs(saved.bundle) : h ? h.bundle ?? undefined : undefined) ?? abs(process.env.DSH_LAYERFS_BUNDLE) ?? abs(process.env.LAYERFS_BUNDLE) ?? null
    // prepared machine images: independent of which CLI is pinned
    const cc = abs(this.config.cacheHome), cs = abs(saved.cacheHome), ce = abs(process.env.DSH_LAYERFS_CACHE_HOME)
    const cacheHome = cc ?? cs ?? ce ?? null
    const cacheHomeSource = cc ? 'config' : cs ? 'settings' : ce ? 'env' : abs(process.env.XDG_CACHE_HOME) ? 'inherited' : 'default'
    this.pin = { cli, daemon, bundle, cacheHome, cacheHomeSource, source }
    this.sdk = undefined
    this.nativeRecorded = undefined
    // Discover the CLI (identity, call log kind) now, so the first agent shell already gets $DSH_LAYERFS_SDK.
    if (cli) void hasNativeLogs(cli)
  }

  /** The SDK over the pinned CLI. Throws `CliUnavailable` when nothing is pinned. */
  get lfs(): Lfs {
    if (!this.pin.cli) throw new CliError('CliUnavailable', 'No LayerFS CLI is pinned. Set it in Machines → LayerFS runtime, or DSH_LAYERFS_CLI.', null, 'unavailable')
    return this.sdk ??= client({ cli: this.pin.cli, home: this.home, bundle: this.pin.bundle, cacheHome: this.pin.cacheHome, callLog: this.callLog })
  }

  /**
   * `<root>/agent-bin/layerfs`, the managed CLI agent shells run (rewritten when
   * the pin or the call log source changes), or null when nothing is pinned.
   */
  agentCli(): string | null {
    const cli = this.pin.cli
    if (!cli) return null
    const native = knownNativeLogs(cli)
    if (native === undefined) void hasNativeLogs(cli)
    return managedCli({ root: this.root, cli, home: this.home, bundle: this.pin.bundle, cacheHome: this.pin.cacheHome, callLog: this.callLog, native: native ?? false, bools: boolOptions(cli) })
  }

  /**
   * `<root>/agent-bin/sdk.mjs`, the LayerFS Node SDK agent shells import as
   * `$DSH_LAYERFS_SDK`, or null when no SDK built from the pinned CLI's commit is
   * installed (`DSH_LAYERFS_SDK_DIR`, else `.layerfs-sdk/<commit>/` in this
   * package; `scripts/install-sdk.mjs`) or the CLI is not discovered yet.
   */
  agentSdk(): string | null {
    const cli = this.pin.cli
    if (!cli) return null
    const commit = knownIdentity(cli)?.commit
    if (!commit) { void discover({ cli }).catch(() => {}); return null }
    const sdk = findSdk(this.sdkDir(), commit)
    if (!sdk) return null
    // As agentCli: until the call log kind is known, the stand-in log (the SDK falls back on its own).
    const native = knownNativeLogs(cli)
    if (native === undefined) void hasNativeLogs(cli)
    return managedSdk({ root: this.root, sdk, home: this.home, bundle: this.pin.bundle, cacheHome: this.pin.cacheHome, callLog: this.callLog, native: native ?? false, bools: boolOptions(cli) })
  }

  /** Where Node SDK installs are looked for (`<dir>/<commit>/`, or `<dir>` itself): `DSH_LAYERFS_SDK_DIR`, else `.layerfs-sdk/` in this package. */
  private sdkDir(): string {
    return process.env.DSH_LAYERFS_SDK_DIR || join(packageRoot(), '.layerfs-sdk')
  }

  /** Whether the pinned CLI keeps LayerFS's own call log (else the plugin's stand-in). */
  async nativeLogs(): Promise<boolean> { return !!this.pin.cli && await hasNativeLogs(this.pin.cli) }

  /** The pinned CLI path, if any. */
  get cli(): string | null { return this.pin.cli }
  /** The pinned daemon path, if any. */
  get daemon(): string | null { return this.pin.daemon }
  /** The pinned Linux bundle folder, if any. */
  get bundle(): string | null { return this.pin.bundle }
  /** The pinned XDG cache home for prepared machine images, if any (else the CLI inherits the host's). */
  get cacheHome(): string | null { return this.pin.cacheHome }

  /** The cache home the CLI actually reads: the pin, else the host's XDG_CACHE_HOME, else `~/.cache`. */
  private effectiveCacheHome(): string {
    return this.pin.cacheHome ?? abs(process.env.XDG_CACHE_HOME) ?? join(homedir(), '.cache')
  }

  /** How many prepared VM OS images the effective cache home holds. */
  private preparedImages(): number {
    const root = join(this.effectiveCacheHome(), 'layerfs', 'machine-images')
    const dirs = (p: string) => { try { return readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory()) } catch { return [] } }
    let n = 0
    for (const provider of dirs(root)) {
      if (provider === 'objects' || provider === 'builds') continue
      for (const platform of dirs(join(root, provider))) for (const image of dirs(join(root, provider, platform))) if (existsSync(join(root, provider, platform, image, 'current.json'))) n++
    }
    return n
  }

  private bundleInfo(): RuntimeStatus['bundleInfo'] {
    if (!this.pin.bundle) return null
    try {
      const b = JSON.parse(readFileSync(join(this.pin.bundle, 'bundle.json'), 'utf8'))
      return { hash: typeof b.hash === 'string' ? b.hash : null, source: typeof b.source?.head === 'string' ? b.source.head : null }
    } catch { return { hash: null, source: null } }
  }

  /** Discovery for the pinned CLI. */
  async discovery(fresh = false): Promise<Discovery> {
    return await discover({ cli: this.lfs.spec.cli }, fresh)
  }

  /**
   * Before calls that need the native machine (macOS): record the pinned daemon
   * on `native` when none, or a missing one, is recorded; after a runtime
   * change (`moved`), whenever another one is recorded. Never throws.
   */
  ensureNative(moved = false): Promise<unknown> {
    if (this.nativeRecorded) return this.nativeRecorded
    let failed = false
    const attempt: Promise<unknown> = (async () => {
      if (process.platform !== 'darwin' || !this.pin.cli || !this.pin.daemon) return
      try {
        const recorded = existsSync(join(this.home, 'layerfs.json')) ? (await this.lfs.machine.get('native')).daemon ?? null : null
        if (recorded && existsSync(recorded) && (!moved || recorded === this.pin.daemon)) return
        await this.lfs.machine.update('native', { daemon: this.pin.daemon })
      } catch (error) {
        failed = true
        this.ctx.logger('layerfs').warn('native daemon not recorded: %s', (error as Error)?.message ?? error)
      }
    })()
    this.nativeRecorded = attempt
    // Not recorded: the next caller tries again (unless the pin changed meanwhile).
    void attempt.then(() => { if (failed && this.nativeRecorded === attempt) this.nativeRecorded = undefined })
    return attempt
  }

  private persistenceKind(): RuntimeStatus['sessionPersistence'] {
    const persistence = this.ctx.get('sessionPersistence' as never) as any
    return !persistence ? 'none' : persistence.local ? 'layerfs' : 'stock'
  }

  /** Runtime facts for the UI. */
  async status(): Promise<RuntimeStatus> {
    const base = {
      cli: this.pin.cli, daemon: this.pin.daemon, bundle: this.pin.bundle, bundleInfo: this.bundleInfo(),
      cacheHome: this.effectiveCacheHome(), cacheHomeSource: this.pin.cacheHomeSource, preparedImages: this.preparedImages(), home: this.home, root: this.root, projectSessionHome: this.projectSessionHome, source: this.pin.source,
      scratchProject: this.scratchProject, checkpoints: this.checkpoints,
      sessionPersistence: this.persistenceKind(),
    }
    try {
      const d = await this.discovery()
      const sdkDir = this.sdkDir(), sdk = findSdk(sdkDir, d.identity.commit)
      return { ...base, ok: true, version: d.identity.version, commit: d.identity.commit, features: d.identity.features, sdk: sdk && { dir: sdk.dir, commit: sdk.commit }, sdkDir, error: null }
    } catch (error: any) {
      return { ...base, ok: false, version: null, commit: null, features: [], sdk: null, sdkDir: null, error: { code: error?.code ?? 'Failed', message: String(error?.message ?? error) } }
    }
  }

  /**
   * Save a new CLI/daemon pin (or clear it with nulls) and switch to it.
   * The new CLI is discovered first; an incompatible one is refused unchanged.
   * The CLI, daemon and bundle are installed into the LayerFS home
   * (`<home>/runtime/<version>-<sha>`) and the pin names those copies.
   * `cacheHome` (the prepared machine image cache) is saved as given; left out,
   * the saved one is kept, except when the pin is cleared.
   */
  async savePin(next: { cli: string | null, daemon: string | null, bundle?: string | null, cacheHome?: string | null }): Promise<RuntimeStatus> {
    if (next.cacheHome && (!abs(next.cacheHome) || !existsSync(next.cacheHome) || !statSync(next.cacheHome).isDirectory())) throw new CliError('InvalidInput', 'The machine image cache must be an absolute path to an existing folder')
    const cacheHome = next.cacheHome !== undefined ? next.cacheHome : next.cli === null ? null : this.settings.read().cacheHome ?? null
    let pin: { cli: string | null, daemon: string | null, bundle?: string | null } = next
    if (next.cli !== null) {
      if (!abs(next.cli) || !existsSync(next.cli)) throw new CliError('InvalidInput', 'The CLI must be an absolute path to an existing file')
      if (next.daemon !== null && (!abs(next.daemon) || !existsSync(next.daemon))) throw new CliError('InvalidInput', 'The daemon must be an absolute path to an existing file')
      if (next.bundle && (!abs(next.bundle) || !existsSync(join(next.bundle, 'bundle.json')))) throw new CliError('InvalidInput', 'The Linux bundle must be an absolute folder holding bundle.json')
      const found = await discover({ cli: next.cli }, true)
      try {
        pin = installRuntime(this.home, found.identity.version, { cli: next.cli, daemon: next.daemon, bundle: next.bundle ?? null })
      } catch (error: any) {
        throw new CliError(error?.code === 'InvalidInput' ? 'InvalidInput' : 'Failed', `Could not install the runtime into the LayerFS home: ${error?.message ?? error}`)
      }
    }
    this.settings.write({ ...(pin.cli === null ? {} : { cli: pin.cli, ...(pin.daemon ? { daemon: pin.daemon } : {}), ...(pin.bundle ? { bundle: pin.bundle } : {}) }), ...(cacheHome ? { cacheHome } : {}) })
    this.resolvePin()
    // the native machine follows the new daemon (the installed copy in the home)
    if (pin.daemon) await this.ensureNative(true)
    this.emit('runtime-changed')
    return await this.status()
  }

  /** Publish a host event to connected clients (the `layerfs/events` stream). */
  emit(type: string, data?: unknown): void {
    this.ctx.get('layerfsRemote' as never as 'layerfsRemote')?.emit(type, data === undefined ? undefined : plain(data))
  }

  /** The `layerfs` Remote, for modules registering operations. */
  get remote(): LayerfsRemote { return this.ctx.layerfsRemote }
}
