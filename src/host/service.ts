/**
 * `ctx.layerfs`: the pinned LayerFS runtime for this DSH host — which CLI and
 * daemon, the LayerFS folder (LAYERFS_ROOT) and its home, the SDK-shaped client over them, host events,
 * and the plugin's own durable state file.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { CliError, client, discover, knownIdentity, plain, uninitialized, type Discovery, type Lfs } from './layerfs/cli.ts'
import { managedCli } from './layerfs/tracing.ts'
import { outputsDir } from './layerfs/call-output.ts'
import { checkFolder, resolveFolder, writeJson, type FolderSource } from './folder.ts'
import { HOST_MACHINE, isHostMachine, machineRows } from './layerfs/machine-records.ts'
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
import { bundleStamp, cleanRuntimes, daemonStamp, installRuntime, installedRuntimes, leasePin, runningCommands, runtimePieces, runtimeRoot, verdictOf, type BuildStamp, type RuntimeCleanup, type Verdict } from './layerfs/runtime-home.ts'
import type { LayerfsRemote } from './remote.ts'
import { FOLDER_PARTS, isFolderPart, type FolderContents, type FolderEntry } from '../shared/folder-parts.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    layerfs: LayerfsService
  }
}

/** Plugin configuration (bundle patch row `layerfs`). */
export interface LayerfsConfig {
  /** The LayerFS folder (docs/specs/layerfs-folder.md); else DSH_LAYERFS_FOLDER, else the `$DSH_HOME/layerfs.json` pointer, else `~/.layerfs`. */
  folder?: string
  /** The DSH x LayerFS home, this install's plugin state; else DSH_LAYERFS_STATE, else `<folder>/dsh`. */
  state?: string
  /** Absolute pinned `layerfs` CLI; else runtime.json, else DSH_LAYERFS_CLI, else the newest runtime installed in the home. */
  cli?: string
  /** Absolute matching `layerfs-daemon` (the macOS host machine, `macos-host`). */
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
  /**
   * Where keys and passwords entered in the panel are saved (owner-only files,
   * passed to LayerFS as `file:` references); default `<home>/secret`, or
   * DSH_LAYERFS_SECRETS.
   */
  secrets?: string
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
  /** The DSH x LayerFS home (this install's plugin state). */
  readonly root: string
  /** The LayerFS folder. */
  readonly folder: string
  readonly projectSessionHome: string
  /** `layerfs`: the bundle's session persistence row runs (missing sessions are imported from LayerFS); `stock`: DSH's own. */
  readonly sessionPersistence: 'layerfs' | 'stock' | 'none'
  readonly checkpoints: 'turn' | 'off'
  /** Where the pin came from; `home`: the newest runtime installed in the LayerFS home. */
  readonly source: 'config' | 'settings' | 'env' | 'home' | 'none'
  readonly version: string | null
  readonly commit: string | null
  readonly features: readonly string[]
  /** The Store formats this build writes, by engine (`--version --json` `formats`, #804); null when it does not say. */
  readonly formats: Readonly<Record<string, number>> | null
  /** The Node SDK agents import as `$DSH_LAYERFS_SDK`: the install built from the CLI's commit, or null with where it is looked for. */
  readonly sdk: { readonly dir: string, readonly commit: string } | null
  readonly sdkDir: string | null
  readonly error: { readonly code: string, readonly message: string } | null
}

/** `layerfs home get` (LayerFS ≥ the `home` family), as LayerFS answers it. */
/** `home get --detail` (LayerFS 2.0, call-surface-2-0 `home.get`): the home's path, its state with `reason`/`fix`/`message`, `generation`, layout, mode and build pieces. */
export interface HomeGet {
  readonly home: string
  readonly state: string
  readonly version: string | null
  readonly generation: number | null
  readonly reason: string | null
  readonly fix: string | null
  readonly message: string | null
  readonly layout: number | null
  readonly mode: string | null
  readonly bundle: { readonly path: string, readonly source: string, readonly present: boolean, readonly commit: string | null, readonly dirty: boolean | null, readonly matches: boolean | null } | null
  readonly daemon: { readonly path: string, readonly source: string, readonly present?: boolean, readonly commit: string | null, readonly dirty?: boolean | null, readonly matches: boolean | null } | null
  readonly cache: { readonly path: string } | null
}

/**
 * The LayerFS folder as the setup modal words it: `current` (home get `ready`),
 * `missing` (`broken`, reason `missing`), `outdated` (`broken`, reason
 * `outdated`: an older LayerFS's home, which LayerFS 2.0 does not convert;
 * every call is refused with the fix that moves it aside and makes a new
 * one), else `unknown`; without the home family, `layerfs.json` present or not.
 */
export type HomeState = 'missing' | 'current' | 'outdated' | 'unknown'

/** The setup modal's folder word for a `home get` answer (see {@link HomeState}). */
export function homeStateOf(got: Pick<HomeGet, 'state' | 'reason'> | null | undefined): HomeState {
  if (!got) return 'unknown'
  if (got.state === 'ready') return 'current'
  if (got.state === 'broken' && got.reason === 'missing') return 'missing'
  if (got.state === 'broken' && got.reason === 'outdated') return 'outdated'
  return 'unknown'
}

/** Whether a mode string (`0700`) lets no group or world in; null when unknown. */
const modeOk = (mode: string | null | undefined): boolean | null => (typeof mode === 'string' && /^0?[0-7]{3,4}$/.test(mode) ? (parseInt(mode, 8) & 0o077) === 0 : null)

/** One piece of a runtime (CLI, daemon, Linux bundle) and whether it is from the CLI's build. */
export interface Piece {
  readonly path: string | null
  readonly commit: string | null
  readonly dirty: boolean | null
  /** Against the CLI's build (LayerFS's `matches` rule); the CLI itself is `matches` when its tree is clean. */
  readonly verdict: Verdict
}

/** What is still required before LayerFS can be used here (the setup modal's Done). */
export type SetupNeed = 'runtime' | 'folder' | 'build'

/** The setup check (docs/specs/layerfs-setup.md §3): the runtime, the LayerFS folder, and whether the pieces are one build. */
export interface SetupStatus {
  readonly at: number
  readonly runtime: RuntimeStatus
  readonly folder: {
    readonly path: string
    readonly state: HomeState
    readonly layout: number | null
    readonly mode: string | null
    /** No group or world access (null: unknown). A wrong mode is a note, never required. */
    readonly modeOk: boolean | null
    /** What the setup check did to it while this host runs (created it), or null. */
    readonly did: { readonly created: boolean, readonly at: number } | null
    /** A folder that is not ready, in LayerFS's words: its sentence and its fix line (`home get`). */
    readonly message?: string | null
    readonly fix?: string | null
    /** The LayerFS folder (docs/specs/layerfs-folder.md) and where it came from. */
    readonly root: string
    readonly rootSource: 'config' | 'env' | 'pointer' | 'default'
    /** A folder chosen in the setup modal that takes effect after a restart, or null. */
    readonly next: string | null
    /** The DSH x LayerFS home: its path, and `<root>/dsh` when another DeepSeek Harness owns that one. */
    readonly dsh: { readonly path: string, readonly taken: string | null }
    /** The user's home folder, so the page can write the folder as `~/…`. */
    readonly userHome: string
  }
  readonly pieces: { readonly cli: Piece | null, readonly daemon: Piece | null, readonly bundle: Piece | null }
  /** A home that is not ready, in LayerFS's words (`home get` `message` and `fix`). */
  readonly warnings: readonly { readonly code: string, readonly message: string }[]
  /** What blocks Done: no runtime, a folder that is not current, pieces from another build. */
  readonly needs: readonly SetupNeed[]
  /** Mixed builds may be saved (DSH_LAYERFS_ALLOW_MIXED=1, development): a piece from another build is a note, not a need. */
  readonly mixedAllowed: boolean
  /** The host machine records another daemon than this runtime's, and this runtime's is from its build: the modal offers to record it. */
  readonly daemonRecordable: boolean
  /** The setup check could not finish (the CLI failed): its refusal. */
  readonly error: { readonly code: string, readonly message: string } | null
}

/** One runtime installed in the LayerFS home, for the runtime picker (`runtime.installed`). */
export interface InstalledView {
  readonly id: string
  readonly cli: string
  readonly daemon: string | null
  readonly bundle: string | null
  readonly at: number
  readonly version: string | null
  readonly commit: string | null
  readonly dirty: boolean | null
  readonly pieces: { readonly daemon: Piece | null, readonly bundle: Piece | null }
  /** An SDK built from its commit is installed (scripts/install-sdk.mjs). */
  readonly sdk: boolean
  /** This host's pin. */
  readonly active: boolean
  /** Its CLI could not be discovered: why. */
  readonly error: string | null
}

/** Installed runtimes whose CLI failed discovery, by path and modification time, with why. */
const failedDiscovery = new Map<string, string>()

const mixedAllowed = (): boolean => process.env.DSH_LAYERFS_ALLOW_MIXED === '1'

/** A piece of the runtime at `path` with its build `stamp`, judged against the CLI's build. */
function pieceOf(path: string | null, stamp: BuildStamp | null, cli: BuildStamp | null): Piece | null {
  if (!path) return null
  return { path, commit: stamp?.commit ?? null, dirty: stamp?.dirty ?? null, verdict: verdictOf(cli, stamp) }
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
  /** The LayerFS folder: holds the home (or is it) and the DSH x LayerFS home. */
  readonly folder: string
  /** Where the folder came from. */
  readonly folderSource: FolderSource
  /** The DSH x LayerFS home: this install's plugin state (`<folder>/dsh`). */
  readonly state: string
  /** `<folder>/dsh` when it belongs to another DSH_HOME and `state` is this install's own fallback. */
  readonly stateTaken: string | null
  /** This install's id (64 hex): Sandbox names and the runtime pin lease. */
  readonly install: string
  /** `$DSH_HOME/layerfs.json`: the folder chosen in the setup modal. */
  readonly pointer: string
  /** `<state>/trace/outputs`: what calls made through DSH printed (docs/specs/layerfs-logs.md "Outputs"). */
  readonly outputs: string
  readonly projectSessionHome: string
  readonly home: string
  /** The folder entered keys and passwords are saved in (see LayerfsConfig.secrets). */
  readonly secrets: string
  /** Storage job tables in the LayerFS home, named for no client: `<home>/job` (storage-jobs.json, doctor-jobs.json). */
  readonly jobDir: string
  /** Storage statistics in the LayerFS home: `<home>/stat` (storage-observations/, project-storage/). */
  readonly statDir: string
  readonly checkpoints: 'turn' | 'off'
  readonly idleMinutes: number
  /** `<state>/runtime.json`: the installed runtime chosen in the UI, by id (`runtime`; wins over env), and the image cache. */
  readonly settings: JsonFile<{ runtime?: string, cacheHome?: string }>
  private pin!: { cli: string | null, daemon: string | null, bundle: string | null, cacheHome: string | null, cacheHomeSource: RuntimeStatus['cacheHomeSource'], source: RuntimeStatus['source'] }
  private sdk: Lfs | undefined
  private hostDaemonRecorded: Promise<unknown> | undefined
  /** Set while an operation holds the whole home (a preset build or reset): why new Sandboxes must wait, or null. */
  exclusive: (() => string | null) | undefined
  /** The LayerFS folder's last known state (the setup check); `outdated` closes the home gate. */
  private homeState: HomeState | null = null
  /** Goes up when the folder changes under a running check (set up, moved aside) or the pin moves: older answers are stale. */
  private homeGeneration = 0
  /** The background parts run (startSetup): lease, watch, first check. */
  private started = false
  private watcher: FSWatcher | undefined
  private watchTimer: NodeJS.Timeout | undefined
  /** The `home get` in flight that tells the gate the folder's state. */
  private homeLearn: Promise<void> | null = null
  /** The home set up in flight (one `home init`, or one `machine list` for an older CLI). */
  private homeInit: Promise<void> | null = null
  /** What the setup check did to the folder while this host runs. */
  private homeDid: SetupStatus['folder']['did'] = null
  /** The setup check in flight, shared by concurrent callers. */
  private setupRead: Promise<SetupStatus> | null = null
  private lastSetup: SetupStatus | null = null

  constructor(ctx: Context, private readonly config: LayerfsConfig = {}) {
    super(ctx, 'layerfs')
    const where = resolveFolder(config, process.env)
    this.folder = where.folder
    this.folderSource = where.folderSource
    this.state = where.state
    this.stateTaken = where.stateTaken
    this.install = where.install
    this.pointer = where.pointer
    this.outputs = outputsDir(this.state)
    this.projectSessionHome = join(this.state, 'sessions')
    this.home = where.home
    this.secrets = abs(config.secrets) ?? abs(process.env.DSH_LAYERFS_SECRETS) ?? join(this.home, 'secret')
    this.jobDir = join(this.home, 'job')
    this.statDir = join(this.home, 'stat')
    this.checkpoints = config.checkpoints === 'off' ? 'off' : 'turn'
    this.idleMinutes = Number.isFinite(config.idleMinutes) ? Math.max(0, Number(config.idleMinutes)) : 30
    this.settings = new JsonFile(join(this.state, 'runtime.json'), () => ({}))
    this.resolvePin()
  }

  /**
   * Starts the setup check's background parts (index.ts, once the plugin
   * runs; a service built in a test starts none of them): this host's pin
   * lease, the watch on `<home>/runtime`, and the first setup check, which
   * creates a missing LayerFS folder without asking.
   */
  startSetup(): void {
    if (this.started) return
    this.started = true
    leasePin(this.home, this.state, this.pin.cli, this.install)
    this.ctx.effect(() => () => { clearTimeout(this.watchTimer); this.watcher?.close(); this.watcher = undefined }, 'dsh-layerfs: runtime watch')
    this.armWatch()
    const first = setTimeout(() => { void this.setup().catch(() => {}) }, 0)
    first.unref()
    this.ctx.effect(() => () => clearTimeout(first), 'dsh-layerfs: first setup check')
  }

  /**
   * Watches `<home>/runtime`, so a runtime the LayerFS app installs later is
   * picked up without a restart (when nothing else is pinned). Until that
   * folder exists (a first run) the setup check arms it again each time.
   */
  private armWatch(): void {
    if (!this.started || this.watcher) return
    try {
      const watcher = watch(runtimeRoot(this.home), () => {
        clearTimeout(this.watchTimer)
        this.watchTimer = setTimeout(() => { if (this.rescan()) void this.setup().catch(() => {}) }, 1000)
        this.watchTimer.unref()
      })
      watcher.unref()
      watcher.on('error', () => { watcher.close(); if (this.watcher === watcher) this.watcher = undefined })
      this.watcher = watcher
    } catch { /* no runtime folder yet: armed again by the next setup check */ }
  }

  /**
   * When nothing pins a runtime but the home (or nothing at all), take the
   * newest runtime installed in the home now. Answers whether the pin moved.
   */
  private rescan(): boolean {
    if (this.pin.source !== 'home' && this.pin.source !== 'none') return false
    const newest = installedRuntimes(this.home)[0]?.cli ?? null
    if (newest === this.pin.cli) return false
    this.resolvePin()
    this.emit('runtime-changed')
    this.emit('setup-changed')
    return true
  }

  private resolvePin(): void {
    const saved = this.settings.read()
    // a saved pin names an installed runtime by id, found in this home (a moved home keeps its runtimes)
    const r = typeof saved.runtime === 'string' && /^[0-9A-Za-z_.+-]+$/.test(saved.runtime) ? runtimePieces(this.home, saved.runtime) : undefined
    const c = abs(this.config.cli), s = r?.cli, e = abs(process.env.DSH_LAYERFS_CLI)
    // nothing pinned: the newest runtime installed in the LayerFS home
    const h = c || s || e ? undefined : installedRuntimes(this.home)[0]
    const cli = c ?? s ?? e ?? h?.cli ?? null
    const source = c ? 'config' : s ? 'settings' : e ? 'env' : h ? 'home' : 'none'
    const daemon = (c ? abs(this.config.daemon) : s ? r!.daemon : e ? abs(process.env.DSH_LAYERFS_DAEMON) : h?.daemon) ?? null
    const bundle = (c ? abs(this.config.bundle) : s ? r!.bundle ?? undefined : h ? h.bundle ?? undefined : undefined) ?? abs(process.env.DSH_LAYERFS_BUNDLE) ?? abs(process.env.LAYERFS_BUNDLE) ?? null
    // prepared machine images: independent of which CLI is pinned
    const cc = abs(this.config.cacheHome), cs = abs(saved.cacheHome), ce = abs(process.env.DSH_LAYERFS_CACHE_HOME)
    const cacheHome = cc ?? cs ?? ce ?? null
    const cacheHomeSource = cc ? 'config' : cs ? 'settings' : ce ? 'env' : abs(process.env.XDG_CACHE_HOME) ? 'inherited' : 'default'
    this.pin = { cli, daemon, bundle, cacheHome, cacheHomeSource, source }
    this.sdk = undefined
    this.homeState = null
    // a pin change makes a running check's answer stale
    this.homeGeneration = (this.homeGeneration ?? 0) + 1
    this.hostDaemonRecorded = undefined
    // this host's lease on the runtime folder it pins, so no host's cleanup removes it (only once the plugin runs: never from a test)
    if (this.started) leasePin(this.home, this.state, cli, this.install)
    // Discover the CLI now, so the first agent shell already gets $DSH_LAYERFS_SDK.
    if (cli) void discover({ cli }).catch(() => {})
  }

  /** The SDK over the pinned CLI. Throws `CliUnavailable` when nothing is pinned. */
  get lfs(): Lfs {
    if (!this.pin.cli) throw new CliError('CliUnavailable', 'No LayerFS runtime is chosen yet. Open Set up LayerFS in Center, or set DSH_LAYERFS_CLI.', null, 'unavailable')
    return this.sdk ??= client({ cli: this.pin.cli, home: this.home, bundle: this.pin.bundle, cacheHome: this.pin.cacheHome, outputs: this.outputs, gate: (call) => this.gate(call) })
  }

  /** The gate's refusal for a folder this LayerFS can't use as it is. */
  private closed(): CliError | null {
    if (this.homeState === 'outdated') return uninitialized(this.home, `The LayerFS folder ${this.home} was made by an older LayerFS, which this LayerFS does not convert: move it aside and make a new one (Set up LayerFS in Center shows how).`)
    if (this.homeState === 'unknown') return uninitialized(this.home, `This LayerFS can't read the folder ${this.home}. Open Set up LayerFS in Center.`)
    return null
  }

  /**
   * The home gate (cli.ts `CliSpec.gate`): an older LayerFS's folder (or one
   * that `home get` could not read) refuses every call `Uninitialized` until
   * the user moves it aside; a read on a missing folder sets it up first
   * (`home init`, or one `machine list` for an older CLI) and is refused
   * `Uninitialized` if it is still missing.
   */
  private async gate(call: { family: string, call: string, read: boolean }): Promise<void> {
    // not known yet (the first call after start or a runtime change): ask `home get` once, so nothing is set up over an older folder by accident
    if (this.homeState === null) await this.learnHome()
    const refused = this.closed()
    if (refused) { this.recheck(); throw refused }
    if (!call.read || existsSync(join(this.home, 'layerfs.json'))) return
    try { await this.ensureHome() } catch { /* answered below */ }
    if (!existsSync(join(this.home, 'layerfs.json'))) {
      this.recheck()
      throw this.closed() ?? uninitialized(this.home)
    }
  }

  /** After an `Uninitialized` refusal: the setup check again, at most every 2 s (the folder may have been set up elsewhere). */
  private recheck(): void {
    if (this.setupRead || (this.lastSetup && Date.now() - this.lastSetup.at < 2000)) return
    void this.setup().catch(() => {})
  }

  /**
   * The folder's state from `home get` (one read shared by every caller).
   * A failed `home get` leaves it `unknown` (the gate refuses; nothing writes
   * it by accident). Never throws.
   */
  private learnHome(): Promise<void> {
    return this.homeLearn ??= (async () => {
      const generation = this.homeGeneration
      let state: HomeState | null = null
      try {
        await this.discovery()
        try { state = homeStateOf((await this.lfs.home.get({ detail: true })) as HomeGet) } catch { state = 'unknown' }
      } catch { /* discovery failed: no call can run anyway */ } finally { this.homeLearn = null }
      if (generation === this.homeGeneration && this.homeState === null) this.homeState = state
    })()
  }

  /**
   * Sets a missing LayerFS folder up, once at a time: `home get` first (an
   * older LayerFS's folder is left alone), then `home init`.
   */
  private ensureHome(): Promise<void> {
    return this.homeInit ??= (async () => {
      try {
        const got: HomeGet = await this.lfs.home.get({ detail: true })
        this.homeState = homeStateOf(got)
        if (this.homeState !== 'missing') return
        // 2.0 long form: `outcome` created | unchanged
        const did = await this.lfs.home.init({ detail: true })
        this.homeDid = { created: did?.outcome === 'created', at: Date.now() }
        this.homeGeneration++
        this.homeState = existsSync(join(this.home, 'layerfs.json')) ? 'current' : this.homeState
        this.ctx.logger('layerfs').info('LayerFS folder %s set up', this.home)
        this.emit('setup-changed')
      } finally { this.homeInit = null }
    })()
  }

  /**
   * `home init` (a refusal's `layerfs home init` fix): makes a missing
   * folder; LayerFS refuses an older LayerFS's folder (`Unsupported`, with
   * the fix that moves it aside), which this never touches. A check already
   * running read the folder before: it is waited for and a fresh one answers.
   */
  async initHome(): Promise<SetupStatus> {
    const did = await this.lfs.home.init({ detail: true })
    this.homeDid = { created: did?.outcome === 'created', at: Date.now() }
    this.homeGeneration++
    this.homeState = null
    await this.setupRead?.catch(() => {})
    this.emit('setup-changed')
    return await this.setup()
  }

  /** Re-records this runtime's daemon on the host machine (the setup modal's fix for a daemon from another build). */
  async recordDaemon(): Promise<SetupStatus> {
    if (!this.pin.daemon) throw new CliError('InvalidInput', 'This runtime has no host daemon to record')
    this.hostDaemonRecorded = undefined
    await this.ensureHostDaemon(true)
    this.emit('setup-changed')
    return await this.setup()
  }

  /**
   * Opens the LayerFS folder, a home, or one of a home's listed folders
   * (`FOLDER_PARTS`, by name only) in the file manager (Finder on macOS):
   * the setup modal's Open and its folder tree.
   */
  openFolder(which: unknown, part?: unknown): { ok: true } {
    if (part != null && !isFolderPart(which, part)) throw new CliError('InvalidInput', `${String(part)} is not a folder the setup modal opens`)
    const base = which === 'home' ? this.home : which === 'dsh' ? this.state : this.folder
    const path = part != null ? join(base, part) : base
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new CliError('NotFound', `${path} is not there yet`)
    const [cmd, args] = process.platform === 'darwin' ? ['open', [path]]
      : process.platform === 'win32' ? ['explorer', [path]]
        : ['xdg-open', [path]]
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
    return { ok: true }
  }

  /** What each home holds, for the setup modal's folder tree: one directory listing per listed folder, nothing read inside. */
  folderContents(): FolderContents {
    const list = (base: string, names: readonly FolderEntry['name'][]): FolderEntry[] => names.flatMap((name) => {
      let entries: string[]
      try { entries = readdirSync(join(base, name)).filter((n) => !n.startsWith('.')).sort() } catch { return [] }
      return [{ name, count: entries.length, names: entries.slice(0, 6) }]
    })
    return { home: list(this.home, FOLDER_PARTS.home), dsh: list(this.state, FOLDER_PARTS.dsh) }
  }

  /** The folder the pointer names when it is not the one in use (it takes effect after a restart), else null. */
  private nextFolder(): string | null {
    let pointed: unknown
    try { pointed = JSON.parse(readFileSync(this.pointer, 'utf8'))?.folder } catch { return null }
    return typeof pointed === 'string' && pointed !== this.folder ? pointed : null
  }

  /**
   * Choose the LayerFS folder (the setup modal's Change…): saved in the
   * `$DSH_HOME/layerfs.json` pointer and used from the next start. Refused
   * while config or env names the folder; nothing is moved.
   */
  saveFolder(path: unknown): SetupStatus['folder']['next'] {
    if (this.folderSource === 'config' || this.folderSource === 'env') throw new CliError('InvalidInput', `The LayerFS folder is set by ${this.folderSource === 'env' ? 'DSH_LAYERFS_FOLDER' : 'the plugin config'}; change it there.`)
    const folder = checkFolder(path)
    writeJson(this.pointer, { folder })
    this.lastSetup = null
    this.emit('setup-changed')
    return this.nextFolder()
  }

  /**
   * The setup check (docs/specs/layerfs-setup.md §3): rescans the home's
   * runtimes, reads `home get` (creating a missing folder without asking),
   * and judges the pinned pieces against the CLI's build. Concurrent callers
   * share one check; a check that raced a conversion, a set up or a pin
   * change reads again. Never throws.
   */
  setup(): Promise<SetupStatus> {
    return this.setupRead ??= (async () => {
      for (let attempt = 0; ; attempt++) {
        const generation = this.homeGeneration
        const answer = await this.readSetup(generation)
        if (generation === this.homeGeneration || attempt >= 2) return answer
      }
    })().finally(() => { this.setupRead = null })
  }

  /** The last setup check's answer, if any (no CLI call). */
  get lastSetupStatus(): SetupStatus | null { return this.lastSetup }

  private async readSetup(generation: number): Promise<SetupStatus> {
    this.rescan()
    this.armWatch()
    const runtime = await this.status()
    let got: HomeGet | null = null, error: SetupStatus['error'] = null
    if (runtime.ok) {
      try {
        got = await this.lfs.home.get({ detail: true })
        if (homeStateOf(got) === 'missing') { await this.ensureHome(); got = await this.lfs.home.get({ detail: true }) }
      } catch (e: any) { error = { code: e?.code ?? 'Failed', message: String(e?.message ?? e) } }
    }
    // never `current` from layerfs.json alone: a failed `home get` is unknown
    const state: HomeState = got ? homeStateOf(got) : runtime.ok ? 'unknown' : existsSync(join(this.home, 'layerfs.json')) ? 'current' : 'missing'
    // a conversion, set up or pin change meanwhile: this answer is stale (setup() reads again)
    if (generation === this.homeGeneration) this.homeState = runtime.ok ? state : null
    const identity = runtime.ok && this.pin.cli ? knownIdentity(this.pin.cli) : null
    const cliStamp: BuildStamp | null = identity ? { commit: identity.commit, dirty: identity.dirty } : null
    const cli: Piece | null = this.pin.cli ? { path: this.pin.cli, commit: cliStamp?.commit ?? null, dirty: cliStamp?.dirty ?? null, verdict: !cliStamp ? 'unknown' : cliStamp.dirty === false ? 'matches' : 'unknown' } : null
    const judged = (matches: boolean | null | undefined): Verdict => (matches === true ? 'matches' : matches === false ? 'other' : 'unknown')
    // the bundle LayerFS resolved (LAYERFS_BUNDLE, else its cache) when it says; else the pinned folder
    const bundle: Piece | null = got?.bundle
      ? (got.bundle.present ? { path: got.bundle.path, commit: got.bundle.commit, dirty: got.bundle.dirty, verdict: judged(got.bundle.matches) } : { path: got.bundle.path, commit: null, dirty: null, verdict: 'missing' })
      : pieceOf(this.pin.bundle, bundleStamp(this.pin.bundle), cliStamp)
    // the daemon the host machine has recorded when LayerFS says (what its DaemonMismatch is about); else the pinned one
    const daemon: Piece | null = process.platform !== 'darwin' ? null
      : got?.daemon
        ? (got.daemon.present === false ? { path: got.daemon.path, commit: null, dirty: null, verdict: 'missing' } : { path: got.daemon.path, commit: got.daemon.commit, dirty: got.daemon.dirty ?? null, verdict: judged(got.daemon.matches) })
        : this.pin.daemon ? pieceOf(this.pin.daemon, daemonStamp(this.pin.daemon), cliStamp) : { path: null, commit: null, dirty: null, verdict: 'missing' }
    const needs: SetupNeed[] = []
    if (!runtime.ok) needs.push('runtime')
    else if (state !== 'current') needs.push('folder')
    // development may run mixed builds on purpose: then it is a note, not a need
    if (runtime.ok && !mixedAllowed() && [bundle, daemon].some((p) => p?.verdict === 'other')) needs.push('build')
    const answer: SetupStatus = {
      at: Date.now(), runtime,
      folder: {
        path: this.home, state, layout: got?.layout ?? null, mode: got?.mode ?? null, modeOk: modeOk(got?.mode), did: this.homeDid,
        ...(got && got.state !== 'ready' ? { message: got.message ?? null, fix: got.fix ?? null } : {}),
        root: this.folder, rootSource: this.folderSource, next: this.nextFolder(),
        dsh: { path: this.state, taken: this.stateTaken },
        userHome: homedir(),
      },
      pieces: { cli, daemon, bundle },
      // a home that is not ready: LayerFS's sentence and its fix (2.0 has no warnings list; `home doctor` reports the rest)
      warnings: got && got.state !== 'ready' && got.message ? [{ code: got.reason ?? got.state, message: got.fix ? `${got.message} (${got.fix})` : got.message }] : [],
      needs, mixedAllowed: mixedAllowed(), error,
      // only when the recorded one is gone or from another build (a same-build copy elsewhere is fine), and ours is not
      daemonRecordable: process.platform === 'darwin' && !!this.pin.daemon && !!daemon?.path && daemon.path !== this.pin.daemon
        && (daemon.verdict === 'other' || daemon.verdict === 'missing') && verdictOf(cliStamp, daemonStamp(this.pin.daemon)) !== 'other',
    }
    this.lastSetup = answer
    return answer
  }

  /** The runtimes installed in the LayerFS home, newest first, each judged (`runtime.installed`). */
  async installed(): Promise<{ runtimes: InstalledView[], pinned: string | null, source: RuntimeStatus['source'], root: string }> {
    const sdkDir = this.sdkDir()
    const runtimes = await Promise.all(installedRuntimes(this.home).map(async (r): Promise<InstalledView> => {
      let d: Discovery | null = null, error: string | null = null
      // a CLI that failed discovery is not asked again until its file changes (runtime folders are filled once)
      const failedKey = `${r.cli}:${r.at}`
      if (failedDiscovery.has(failedKey)) error = failedDiscovery.get(failedKey)!
      else try { d = await discover({ cli: r.cli }) } catch (e: any) { error = String(e?.message ?? e); failedDiscovery.set(failedKey, error) }
      const stamp: BuildStamp | null = d ? { commit: d.identity.commit, dirty: d.identity.dirty } : null
      return {
        id: r.id, cli: r.cli, daemon: r.daemon, bundle: r.bundle, at: r.at,
        version: d?.identity.version ?? null, commit: stamp?.commit ?? null, dirty: stamp?.dirty ?? null,
        pieces: {
          daemon: process.platform === 'darwin' ? (pieceOf(r.daemon, daemonStamp(r.daemon), stamp) ?? { path: null, commit: null, dirty: null, verdict: 'missing' }) : null,
          bundle: pieceOf(r.bundle, bundleStamp(r.bundle), stamp) ?? { path: null, commit: null, dirty: null, verdict: 'missing' },
        },
        sdk: !!(stamp?.commit && findSdk(sdkDir, stamp.commit)),
        active: r.cli === this.pin.cli,
        error,
      }
    }))
    return { runtimes, pinned: this.pin.cli, source: this.pin.source, root: runtimeRoot(this.home) }
  }

  /** Whether every worker machine (docker, Lima, Apple Container) is stopped, so none has a bundle mounted; false when unknown. */
  private async workersIdle(): Promise<boolean> {
    try {
      if (!this.pin.cli || !existsSync(join(this.home, 'layerfs.json'))) return true
      // records only (2.0): every worker machine stopped; a built-in docker never started reads `stopped`.
      // The host machine mounts no bundle: its state does not count.
      return (await machineRows(this.lfs, { timeout_ms: 15000 })).every((m) => isHostMachine(m) || m.state === 'stopped')
    } catch { return false }
  }

  /**
   * `<state>/bin/layerfs`, the managed CLI agent shells run (rewritten when
   * the pin changes), or null when nothing is pinned.
   */
  agentCli(): string | null {
    const cli = this.pin.cli
    if (!cli) return null
    return managedCli({ root: this.state, cli, home: this.home, bundle: this.pin.bundle, cacheHome: this.pin.cacheHome, outputs: this.outputs })
  }

  /**
   * `<state>/bin/sdk.mjs`, the LayerFS Node SDK agent shells import as
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
    return managedSdk({ root: this.state, sdk, home: this.home, bundle: this.pin.bundle, cacheHome: this.pin.cacheHome, outputs: this.outputs })
  }

  /** Where Node SDK installs are looked for (`<dir>/<commit>/`, or `<dir>` itself): `DSH_LAYERFS_SDK_DIR`, else `.layerfs-sdk/` in this package. */
  private sdkDir(): string {
    return process.env.DSH_LAYERFS_SDK_DIR || join(packageRoot(), '.layerfs-sdk')
  }

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
   * Before calls that need the host machine (macOS): record the pinned daemon
   * on `macos-host` when none, or a missing one, is recorded; after a runtime
   * change (`moved`), whenever another one is recorded. Never throws.
   */
  ensureHostDaemon(moved = false): Promise<unknown> {
    if (this.hostDaemonRecorded) return this.hostDaemonRecorded
    let failed = false
    const attempt: Promise<unknown> = (async () => {
      if (process.platform !== 'darwin' || !this.pin.cli || !this.pin.daemon) return
      try {
        const recorded = existsSync(join(this.home, 'layerfs.json')) ? (await this.lfs.machine.get(HOST_MACHINE, { detail: true })).daemon ?? null : null
        if (recorded && existsSync(recorded) && (!moved || recorded === this.pin.daemon)) return
        await this.lfs.machine.update(HOST_MACHINE, { daemon: this.pin.daemon })
      } catch (error) {
        failed = true
        this.ctx.logger('layerfs').warn('host daemon not recorded: %s', (error as Error)?.message ?? error)
      }
    })()
    this.hostDaemonRecorded = attempt
    // Not recorded: the next caller tries again (unless the pin changed meanwhile).
    void attempt.then(() => { if (failed && this.hostDaemonRecorded === attempt) this.hostDaemonRecorded = undefined })
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
      cacheHome: this.effectiveCacheHome(), cacheHomeSource: this.pin.cacheHomeSource, preparedImages: this.preparedImages(), home: this.home, root: this.state, folder: this.folder, projectSessionHome: this.projectSessionHome, source: this.pin.source,
      checkpoints: this.checkpoints,
      sessionPersistence: this.persistenceKind(),
    }
    try {
      const d = await this.discovery()
      const sdkDir = this.sdkDir(), sdk = findSdk(sdkDir, d.identity.commit)
      return { ...base, ok: true, version: d.identity.version, commit: d.identity.commit, features: d.identity.features, formats: formatsOf(d.identity.formats), sdk: sdk && { dir: sdk.dir, commit: sdk.commit }, sdkDir, error: null }
    } catch (error: any) {
      return { ...base, ok: false, version: null, commit: null, features: [], formats: null, sdk: null, sdkDir: null, error: { code: error?.code ?? 'Failed', message: String(error?.message ?? error) } }
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
  async savePin(given: { cli: string | null, daemon: string | null, bundle?: string | null, cacheHome?: string | null, runtime?: string | null }): Promise<RuntimeStatus> {
    let next = given
    if (given.runtime) {
      // an installed runtime by its folder name: its own CLI, daemon and bundle
      const r = installedRuntimes(this.home).find((x) => x.id === given.runtime)
      if (!r) throw new CliError('InvalidInput', `No runtime ${given.runtime} is installed in ${runtimeRoot(this.home)}`)
      next = { cli: r.cli, daemon: r.daemon, bundle: r.bundle, ...(given.cacheHome !== undefined ? { cacheHome: given.cacheHome } : {}) }
    }
    if (next.cacheHome && (!abs(next.cacheHome) || !existsSync(next.cacheHome) || !statSync(next.cacheHome).isDirectory())) throw new CliError('InvalidInput', 'The machine image cache must be an absolute path to an existing folder')
    const cacheHome = next.cacheHome !== undefined ? next.cacheHome : next.cli === null ? null : this.settings.read().cacheHome ?? null
    let pin: { id?: string, cli: string | null, daemon: string | null, bundle?: string | null } = next
    if (next.cli !== null) {
      if (!abs(next.cli) || !existsSync(next.cli)) throw new CliError('InvalidInput', 'The CLI must be an absolute path to an existing file')
      if (next.daemon !== null && (!abs(next.daemon) || !existsSync(next.daemon))) throw new CliError('InvalidInput', 'The daemon must be an absolute path to an existing file')
      if (next.bundle && (!abs(next.bundle) || !existsSync(join(next.bundle, 'bundle.json')))) throw new CliError('InvalidInput', 'The Linux bundle must be an absolute folder holding bundle.json')
      const found = await discover({ cli: next.cli }, true)
      // one build: a daemon or bundle from another commit is refused (development may allow it)
      const stamp: BuildStamp = { commit: found.identity.commit, dirty: found.identity.dirty }
      const other = [
        ...(next.daemon && verdictOf(stamp, daemonStamp(next.daemon)) === 'other' ? [`the daemon (${daemonStamp(next.daemon)?.commit?.slice(0, 8)})`] : []),
        ...(next.bundle && verdictOf(stamp, bundleStamp(next.bundle)) === 'other' ? [`the Linux bundle (${bundleStamp(next.bundle)?.commit?.slice(0, 8)})`] : []),
      ]
      if (other.length && !mixedAllowed()) {
        throw new CliError('MixedBuild', `The CLI was built from ${found.identity.commit.slice(0, 8)}, but ${other.join(' and ')} from another commit. Choose pieces from one build (DSH_LAYERFS_ALLOW_MIXED=1 allows this in development).`, { cli: found.identity.commit, other })
      }
      try {
        pin = installRuntime(this.home, found.identity.version, { cli: next.cli, daemon: next.daemon, bundle: next.bundle ?? null }, { replaceBundle: !!next.bundle && await this.workersIdle() })
      } catch (error: any) {
        throw new CliError(error?.code === 'InvalidInput' ? 'InvalidInput' : 'Failed', `Could not install the runtime into the LayerFS home: ${error?.message ?? error}`)
      }
    }
    this.settings.write({ ...(pin.id ? { runtime: pin.id } : {}), ...(cacheHome ? { cacheHome } : {}) })
    this.resolvePin()
    // the host machine follows the new daemon (the installed copy in the home)
    if (pin.daemon) await this.ensureHostDaemon(true)
    this.emit('runtime-changed')
    this.emit('setup-changed')
    // a new runtime folder was installed: remove the ones nothing uses any more (never fails the save)
    if (pin.cli !== null) void this.cleanRuntimes()
    return await this.status()
  }

  /**
   * Removes old runtime folders from `<home>/runtime` (layerfs-project#180).
   * Kept: the pinned one (this host's pin, its saved pin and the environment's),
   * the newest few, any a machine record names (`machine.list()`), any a running
   * process was started from, and every one with a Linux bundle unless all
   * worker machines are stopped (LayerFS does not report which bundle folder a
   * running docker worker has mounted). When `machine.list()` or the process
   * list cannot be read nothing is removed. Never throws.
   */
  async cleanRuntimes(): Promise<RuntimeCleanup> {
    const saved = this.settings.read()
    const kept = typeof saved.runtime === 'string' ? runtimePieces(this.home, saved.runtime) : undefined
    const pinned = [this.pin.cli, this.pin.daemon, this.pin.bundle, kept?.cli, kept?.daemon, kept?.bundle,
      this.config.cli, this.config.daemon, this.config.bundle,
      process.env.DSH_LAYERFS_CLI, process.env.DSH_LAYERFS_DAEMON, process.env.DSH_LAYERFS_BUNDLE, process.env.LAYERFS_BUNDLE]
    let machines: unknown = null
    // a deliberate probe (its own budget), so the answer is read now, after the host machine's record moved
    try { if (this.pin.cli && existsSync(join(this.home, 'layerfs.json'))) machines = await this.lfs.machine.list({ timeout_ms: 15000, detail: true }) } catch { machines = null }
    const result = cleanRuntimes(this.home, { pinned, machines, processes: runningCommands() })
    const logger = this.ctx.logger('layerfs')
    if (result.removed.length) logger.info('removed %d unused LayerFS runtime folder(s): %s', result.removed.length, result.removed.join(', '))
    for (const f of result.failed) logger.warn('runtime folder %s not removed: %s', f.id, f.message)
    return result
  }

  /** Publish a host event to connected clients (the `layerfs/events` stream). */
  emit(type: string, data?: unknown): void {
    this.ctx.get('layerfsRemote' as never as 'layerfsRemote')?.emit(type, data === undefined ? undefined : plain(data))
  }

  /** The `layerfs` Remote, for modules registering operations. */
  get remote(): LayerfsRemote { return this.ctx.layerfsRemote }
}

/** `--version --json` `formats` as the status answers it: engine -> format, positive integers only; null without any. */
function formatsOf(f: unknown): Readonly<Record<string, number>> | null {
  if (!f || typeof f !== 'object') return null
  const out = Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0)) as Record<string, number>
  return Object.keys(out).length ? out : null
}
