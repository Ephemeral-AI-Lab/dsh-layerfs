/**
 * `ctx.layerfs`: the pinned LayerFS runtime for this DSH host — which CLI and
 * daemon, which LAYERFS_HOME, the SDK-shaped client over them, host events,
 * and the plugin's own durable state file.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { CliError, client, discover, plain, type Discovery, type Lfs } from './layerfs/cli.ts'
import type { LayerfsRemote } from './remote.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    layerfs: LayerfsService
  }
}

/** Plugin configuration (bundle patch row `layerfs`). */
export interface LayerfsConfig {
  /** Plugin root: LayerFS home, project scratch-folder workspaces, plugin state. */
  root?: string
  /** Absolute pinned `layerfs` CLI; else runtime.json, else DSH_LAYERFS_CLI. */
  cli?: string
  /** Absolute matching `layerfs-daemon` (macOS native machine). */
  daemon?: string
  /** Absolute Linux bundle folder (holds bundle.json) the docker/VM machines start workers from. */
  bundle?: string
  /** LAYERFS_HOME; default `<root>/home`, or DSH_LAYERFS_HOME. */
  home?: string
  /** Where project sessions are kept: `layerfs` mirrors each session into its project. */
  sessionStore?: 'layerfs' | 'local'
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
  readonly home: string
  readonly root: string
  readonly sessionStore: 'layerfs' | 'local'
  readonly checkpoints: 'turn' | 'off'
  readonly source: 'config' | 'settings' | 'env' | 'none'
  readonly version: string | null
  readonly commit: string | null
  readonly features: readonly string[]
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
  readonly home: string
  readonly sessionStore: 'layerfs' | 'local'
  readonly checkpoints: 'turn' | 'off'
  readonly idleMinutes: number
  /** `<root>/runtime.json`: the CLI/daemon chosen in the UI (wins over env). */
  readonly settings: JsonFile<{ cli?: string, daemon?: string, bundle?: string }>
  private pin!: { cli: string | null, daemon: string | null, bundle: string | null, source: RuntimeStatus['source'] }
  private sdk: Lfs | undefined
  private nativeRecorded: Promise<unknown> | undefined

  constructor(ctx: Context, private readonly config: LayerfsConfig = {}) {
    super(ctx, 'layerfs')
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    this.root = abs(config.root) ?? join(dshHome, 'layerfs')
    this.home = abs(config.home) ?? abs(process.env.DSH_LAYERFS_HOME) ?? join(this.root, 'home')
    this.sessionStore = config.sessionStore === 'local' ? 'local' : 'layerfs'
    this.checkpoints = config.checkpoints === 'off' ? 'off' : 'turn'
    this.idleMinutes = Number.isFinite(config.idleMinutes) ? Math.max(0, Number(config.idleMinutes)) : 30
    this.settings = new JsonFile(join(this.root, 'runtime.json'), () => ({}))
    this.resolvePin()
  }

  private resolvePin(): void {
    const saved = this.settings.read()
    const c = abs(this.config.cli), s = abs(saved.cli), e = abs(process.env.DSH_LAYERFS_CLI)
    const cli = c ?? s ?? e ?? null
    const source = c ? 'config' : s ? 'settings' : e ? 'env' : 'none'
    const daemon = (c ? abs(this.config.daemon) : s ? abs(saved.daemon) : abs(process.env.DSH_LAYERFS_DAEMON)) ?? null
    const bundle = (c ? abs(this.config.bundle) : s ? abs(saved.bundle) : undefined) ?? abs(process.env.DSH_LAYERFS_BUNDLE) ?? abs(process.env.LAYERFS_BUNDLE) ?? null
    this.pin = { cli, daemon, bundle, source }
    this.sdk = undefined
    this.nativeRecorded = undefined
  }

  /** The SDK over the pinned CLI. Throws `CliUnavailable` when nothing is pinned. */
  get lfs(): Lfs {
    if (!this.pin.cli) throw new CliError('CliUnavailable', 'No LayerFS CLI is pinned. Set it in Machines → LayerFS runtime, or DSH_LAYERFS_CLI.', null, 'unavailable')
    return this.sdk ??= client({ cli: this.pin.cli, home: this.home, bundle: this.pin.bundle })
  }

  /** The pinned CLI path, if any. */
  get cli(): string | null { return this.pin.cli }
  /** The pinned daemon path, if any. */
  get daemon(): string | null { return this.pin.daemon }
  /** The pinned Linux bundle folder, if any. */
  get bundle(): string | null { return this.pin.bundle }

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
   * on `native` when none, or a missing one, is recorded. Never throws.
   */
  ensureNative(): Promise<unknown> {
    return this.nativeRecorded ??= (async () => {
      if (process.platform !== 'darwin' || !this.pin.cli || !this.pin.daemon) return
      try {
        const recorded = existsSync(join(this.home, 'layerfs.json')) ? (await this.lfs.machine.get('native')).daemon ?? null : null
        if (recorded && existsSync(recorded)) return
        await this.lfs.machine.update('native', { daemon: this.pin.daemon })
      } catch (error) {
        this.ctx.logger('layerfs').warn('native daemon not recorded: %s', (error as Error)?.message ?? error)
      }
    })()
  }

  /** Runtime facts for the UI. */
  async status(): Promise<RuntimeStatus> {
    const base = {
      cli: this.pin.cli, daemon: this.pin.daemon, bundle: this.pin.bundle, bundleInfo: this.bundleInfo(), home: this.home, root: this.root, source: this.pin.source,
      sessionStore: this.sessionStore, checkpoints: this.checkpoints,
    }
    try {
      const d = await this.discovery()
      return { ...base, ok: true, version: d.identity.version, commit: d.identity.commit, features: d.identity.features, error: null }
    } catch (error: any) {
      return { ...base, ok: false, version: null, commit: null, features: [], error: { code: error?.code ?? 'Failed', message: String(error?.message ?? error) } }
    }
  }

  /**
   * Save a new CLI/daemon pin (or clear it with nulls) and switch to it.
   * The new CLI is discovered first; an incompatible one is refused unchanged.
   */
  async savePin(next: { cli: string | null, daemon: string | null, bundle?: string | null }): Promise<RuntimeStatus> {
    if (next.cli !== null) {
      if (!abs(next.cli) || !existsSync(next.cli)) throw new CliError('InvalidInput', 'The CLI must be an absolute path to an existing file')
      if (next.daemon !== null && (!abs(next.daemon) || !existsSync(next.daemon))) throw new CliError('InvalidInput', 'The daemon must be an absolute path to an existing file')
      if (next.bundle && (!abs(next.bundle) || !existsSync(join(next.bundle, 'bundle.json')))) throw new CliError('InvalidInput', 'The Linux bundle must be an absolute folder holding bundle.json')
      await discover({ cli: next.cli }, true)
    }
    this.settings.write(next.cli === null ? {} : { cli: next.cli, ...(next.daemon ? { daemon: next.daemon } : {}), ...(next.bundle ? { bundle: next.bundle } : {}) })
    this.resolvePin()
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
