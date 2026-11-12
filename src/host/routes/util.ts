/**
 * Shared pieces of the ported Connect host API: the dependencies every route
 * group receives (`RouteHost`), refusals, project keys and the per-Sandbox
 * observation reader (Connect `host/config.js` and `host/layerfs.js`).
 */
import { PAGE, pages, type Discovery, type Lfs } from '../layerfs/cli.ts'

export { PAGE, pages }

/** What the route groups need from `ctx.layerfs` (tests pass a stand-in). */
export interface RouteHost {
  /** The SDK over the pinned CLI (resolved per call: the pin can change). */
  lfs(): Lfs
  /** LAYERFS_HOME. */
  readonly home: string
  /** The plugin root: Connect's `<state>` files (buckets.json, storage-jobs.json, …) go here. */
  readonly root: string
  /** The pinned CLI, if any. */
  cli(): string | null
  /** The pinned daemon, if any. */
  daemon(): string | null
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

/** How long a Sandbox's `Busy` refusal answers its reads before it is asked again. */
export const BUSY_MS = 30_000
const reads = new WeakMap<object, { flying: Map<string, Promise<any> & { started?: number }>, busy: Map<string, { at: number, error: unknown }> }>()

/**
 * A Sandbox's Workspaces: every page of sandbox.get (its pages hold
 * `workspaces`, not `items`). One read per Sandbox at a time: callers share
 * the one in flight, so polls never stack 60 s admission waits. A `Busy`
 * refusal answers again for BUSY_MS without a call. With `wait` (ms) the
 * caller gives up first, refused `Timeout`; the read goes on and the next
 * caller shares it.
 */
export function sandboxObservation(lfs: Lfs, sandbox: string, { wait = null as number | null } = {}): Promise<any> {
  if (!reads.has(lfs)) reads.set(lfs, { flying: new Map(), busy: new Map() })
  const { flying, busy } = reads.get(lfs)!
  const refused = busy.get(sandbox)
  if (refused && Date.now() - refused.at < BUSY_MS) return Promise.reject(refused.error)
  let read = flying.get(sandbox)
  if (!read) {
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
      (all) => { busy.delete(sandbox); return all },
      (error) => {
        if (error?.code === 'Busy') busy.set(sandbox, { at: Date.now(), error })
        throw error
      },
    ).finally(() => flying.delete(sandbox)) as Promise<any> & { started?: number }
    read.started = Date.now()
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
