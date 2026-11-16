/**
 * Shared pieces of the ported Connect host API: the dependencies every route
 * group receives (`RouteHost`), refusals, project keys and the per-Sandbox
 * observation reader (Connect `host/config.js` and `host/layerfs.js`).
 */
import { PAGE, pages, type Discovery, type Lfs } from '../layerfs/cli.ts'
import type { CallLabel } from '../../shared/logs.ts'

export { PAGE, pages }

/** What the route groups need from `ctx.layerfs` (tests pass a stand-in). */
export interface RouteHost {
  /** The SDK over the pinned CLI (resolved per call: the pin can change). */
  lfs(): Lfs
  /** LAYERFS_HOME. */
  readonly home: string
  /** The plugin root (`$DSH_HOME/layerfs`): this DSH install's own state. */
  readonly root: string
  /**
   * Storage state in the LayerFS home, in folders named for no client so any
   * client of the home can use them: `jobs` (`<home>/job`: storage-jobs.json,
   * doctor-jobs.json) and `stats` (`<home>/stat`: storage-observations/,
   * project-storage/). Buckets are LayerFS's own records (`<home>/backup/`).
   */
  readonly jobs: string
  readonly stats: string
  /** The folder entered bucket keys and PostgreSQL passwords are saved in (owner-only files; default `<home>/secret`). */
  readonly secrets: string
  /** The pinned CLI, if any. */
  cli(): string | null
  /** The pinned daemon, if any. */
  daemon(): string | null
  /** The pinned Linux bundle folder (holds bundle.json), if any. */
  bundle?(): string | null
  /** The pinned CLI's discovery (identity, call table, commands). */
  discover(): Promise<Discovery>
  /** Record the native daemon once (never throws). */
  ensureNative(): Promise<unknown>
  /** Publish a host event. */
  emit(type: string, data?: unknown): void
  /** Log a line (warnings). */
  log(line: string): void
  /** Close a Sandbox a DSH session owns the way the session does (save first); false when no session owns it. */
  closeSessionSandbox?(name: string): Promise<boolean>
  /** Guard a name-based route against a permanent project identity. */
  assertProjectIdentity?(project: string, projectId: string): Promise<unknown>
  /** Before project.remove: close the project's session Sandboxes. */
  projectRemoving?(project: string): Promise<void>
  /** After project.remove: retain history and invalidate execution bindings. */
  projectRemoved?(project: string): Promise<void>
  /** A confirmed machine stop invalidates local mounts without deleting history. */
  machinesStopped?(machines: string[]): Promise<void>
  /** A confirmed Sandbox close invalidates its local mounts. */
  sandboxClosed?(name: string): Promise<void>
  /**
   * What each session tag (`dsh:<session>:<receipt>`) means to a project
   * session on this host: its title, turn and checkpoint, as the Logs page
   * labels a call. A tag no session here owns is absent. Best effort.
   */
  labelTags?(tags: readonly string[]): Promise<Record<string, CallLabel>>
}

/** An error the routes throw: answered as `{ code, message }` with `status` (or the code's mapped status). */
export const refuse = (status: number | null, code: string, message: string): Error & { status?: number, code: string } =>
  Object.assign(new Error(message), status === null ? { code } : { status, code })

/** A project key `<store>/<project>` as its parts; a bare name is refused, as 2.0 refuses it. LayerFS checks the names themselves. */
export function projectRef(key: unknown): { store: string, name: string, key: string } {
  const text = String(key ?? '')
  const at = text.indexOf('/')
  const store = text.slice(0, at)
  const name = text.slice(at + 1)
  if (at <= 0 || !name || name.includes('/') || text.includes('\0')) {
    throw refuse(400, 'InvalidInput', `${JSON.stringify(text)} is not a project key: write it as <store>/<project>`)
  }
  return { store, name, key: `${store}/${name}` }
}

/** The key of a project record (project.list/get: `project`, else `store/name`). */
export const keyOf = (p: any): string => p.project ?? `${p.store}/${p.name}`

/**
 * Optional LayerFS features the pinned CLI may lack (an older or newer call
 * table): each is read from discovery, so the routes refuse or answer without
 * the feature instead of sending a call or option the CLI does not have
 * (docs/specs/sandbox-images.md §4.2). Never read from a version string.
 */
export interface CliFeatures {
  /** machine.stop takes `force`. */
  readonly forceStop: boolean
  /** machine.images exists (a machine's cached Sandbox images). */
  readonly images: boolean
  /** machine.load exists (copy an image to a machine without a Sandbox). */
  readonly imageLoad: boolean
  /** machine.prune exists (remove a machine's cached images). */
  readonly imagePrune: boolean
  /** sandbox.create's `image` option has kind `image`: a digest, Docker reference or Id (not only a digest). */
  readonly imageRefs: boolean
  /** sandbox.create takes `on_progress` (inspect, export, send, unpack, start phases). */
  readonly createProgress: boolean
  /** identity feature `sandbox-runtime`: the bundle's runtime layer runs images without glibc or bash. */
  readonly sandboxRuntime: boolean
  /** 1 when every Stage 1 piece is there (images, load, prune, refs, runtime), else 0. */
  readonly imageStage: 0 | 1
  /**
   * Monitoring reads (layerfs-project#178), one per call: a page shows a part
   * only when its call is in the table. `machineLog`: logs.machine (a machine's
   * worker log); `sandboxLog`: logs.sandbox (a Sandbox's daemon log); `files`:
   * sandbox.files; `machineFiles`: machine.files; `machineStats`: machine.stats
   * (a machine's observed resources, data disk, Store sizes and live Sandbox
   * count, layerfs-project#164).
   */
  readonly inspect: { readonly machineLog: boolean, readonly sandboxLog: boolean, readonly files: boolean, readonly machineFiles: boolean, readonly machineStats: boolean }
  /** sandbox.list takes `live`: each Sandbox says whether its daemon process runs now (layerfs-project#164). */
  readonly sandboxLive: boolean
  /** doctor.fix exists: `layerfs doctor` lists what interrupted operations left, each with the id `layerfs doctor fix <id>` takes (layerfs-project#180). */
  readonly leftovers: boolean
}

/** The features a discovery (its call table and identity features) has. */
export function featuresOf(discovery: Partial<Pick<Discovery, 'calls' | 'identity'>> | null | undefined): CliFeatures {
  const table: Discovery['calls'] = Array.isArray(discovery?.calls) ? discovery.calls : []
  const tokens: readonly string[] = Array.isArray(discovery?.identity?.features) ? discovery.identity.features : []
  const call = (family: string, name: string) => table.find((c) => c.family === family && c.call === name)
  const optionOf = (family: string, name: string, opt: string) => call(family, name)?.options?.find((o: { name: string }) => o.name === opt)
  const option = (family: string, name: string, opt: string) => !!optionOf(family, name, opt)
  const images = !!call('machine', 'images'), imageLoad = !!call('machine', 'load'), imagePrune = !!call('machine', 'prune')
  const imageRefs = optionOf('sandbox', 'create', 'image')?.kind === 'image'
  const sandboxRuntime = tokens.includes('sandbox-runtime')
  return {
    forceStop: option('machine', 'stop', 'force'),
    images, imageLoad, imagePrune, imageRefs,
    createProgress: option('sandbox', 'create', 'on_progress'),
    sandboxRuntime,
    imageStage: images && imageLoad && imagePrune && imageRefs && sandboxRuntime ? 1 : 0,
    inspect: { machineLog: !!call('logs', 'machine'), sandboxLog: !!call('logs', 'sandbox'), files: !!call('sandbox', 'files'), machineFiles: !!call('machine', 'files'), machineStats: !!call('machine', 'stats') },
    sandboxLive: option('sandbox', 'list', 'live'),
    leftovers: !!call('doctor', 'fix'),
  }
}

/** The pinned CLI's features; none when discovery fails (its calls fail too). */
export async function cliFeatures(host: Pick<RouteHost, 'discover'>): Promise<CliFeatures> {
  try { return featuresOf(await host.discover()) } catch { return featuresOf(null) }
}

/** A route answer with a status other than 200 (e.g. `202` for a background job's admission). */
export class Answer {
  constructor(readonly status: number, readonly body: unknown) {}
}

/** How long a Sandbox's `Busy` refusal answers its reads before it is asked again. */
export const BUSY_MS = 30_000
/** How long a Sandbox's sandbox.get answer serves every tab that asks (layerfs-project#182 D2): two tabs on one Sandbox cost what one does. */
export const SANDBOX_KEEP_MS = 10_000
type Read = Promise<any> & { started?: number }
const reads = new WeakMap<object, { flying: Map<string, Read>, busy: Map<string, { at: number, error: unknown }>, kept: Map<string, { at: number, value: any }> }>()

/**
 * Forget what {@link sandboxObservation} holds for `sandbox` (a cached `Busy`
 * refusal, a read in flight): a write on the Sandbox (mount, unmount, commit,
 * close) changed it, so the next read asks LayerFS again.
 */
export function invalidateSandbox(lfs: object, sandbox: string): void {
  const state = reads.get(lfs)
  if (!state) return
  state.busy.delete(sandbox)
  state.flying.delete(sandbox)
  state.kept.delete(sandbox)
}

/**
 * A Sandbox's Workspaces: every page of sandbox.get (its pages hold
 * `workspaces`, not `items`). One read per Sandbox at a time: callers share
 * the one in flight, so polls never stack 60 s admission waits. A `Busy`
 * refusal answers again for BUSY_MS without a call, and a good answer for
 * SANDBOX_KEEP_MS (shared by every tab; a write on the Sandbox drops it,
 * {@link invalidateSandbox}). With `wait` (ms) the caller gives up first,
 * refused `Timeout`; the read goes on and the next caller shares it.
 */
export function sandboxObservation(lfs: Lfs, sandbox: string, { wait = null as number | null } = {}): Promise<any> {
  if (!reads.has(lfs)) reads.set(lfs, { flying: new Map(), busy: new Map(), kept: new Map() })
  const { flying, busy, kept } = reads.get(lfs)!
  const refused = busy.get(sandbox)
  if (refused && Date.now() - refused.at < BUSY_MS) return Promise.reject(refused.error)
  const good = kept.get(sandbox)
  if (good && Date.now() - good.at < SANDBOX_KEEP_MS) return Promise.resolve(good.value)
  let read = flying.get(sandbox)
  if (!read) {
    // a kept answer's age counts from when its read began, so a page that
    // polls every 5 s while a command runs still gets a new answer every 10 s
    const began = Date.now()
    // only the read still current settles the cache: one an invalidation dropped leaves it alone
    const current = () => flying.get(sandbox) === read
    read = (async () => {
      const all: unknown[] = []
      let observation: any
      for (let pos: number | null = 0; pos !== null;) {
        const page = await lfs.sandbox.get(sandbox, { page_size: PAGE, page_pos: pos })
        observation ??= page
        all.push(...(page.workspaces ?? []))
        pos = page.next_page_pos ?? null
      }
      return { ...observation, workspaces: all }
    })().then(
      (all) => {
        if (current()) {
          busy.delete(sandbox)
          if (kept.size >= 256) kept.delete(kept.keys().next().value!)
          kept.set(sandbox, { at: began, value: all })
        }
        return all
      },
      (error) => {
        if (current()) kept.delete(sandbox)
        if (error?.code === 'Busy' && current()) busy.set(sandbox, { at: Date.now(), error })
        throw error
      },
    ).finally(() => { if (current()) flying.delete(sandbox) }) as Read
    read.started = began
    flying.set(sandbox, read)
  }
  if (!wait) return read
  // a read already past the wait is not waited for again
  const left = wait - (Date.now() - (read.started ?? Date.now()))
  let timer: NodeJS.Timeout | undefined
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(refuse(null, 'Timeout', `Sandbox ${sandbox} did not answer in ${wait / 1000} s`)), Math.max(0, left))
  })
  return Promise.race([read, late]).finally(() => clearTimeout(timer))
}

/** JSON for the wire, Connect's convention: unsafe integers become `{ $layerfs: 'i64-v1', decimal }` (renderer `exact-count.ts`). */
export function wire<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? { $layerfs: 'i64-v1', decimal: String(v) } : v))
}

/** Same as {@link wire}, as a string (persisted job files). */
export const stringify = (value: unknown): string => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? { $layerfs: 'i64-v1', decimal: String(v) } : v)
