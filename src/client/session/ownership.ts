/**
 * One ownership store for every reader of a session's project: the sidebar row
 * mark, the conversation views mode and the New Session chip. It makes one
 * `sessions.places` batch read for the ids it is asked about, coalesced (the
 * host events arrive many times a second during a run), and keeps three states
 * per id:
 *
 *   project     the session works in a project
 *   notProject  the session is a plain DSH workspace session
 *   unknown     the last read failed (or has not answered yet)
 *
 * A failed read is not "not a project": it keeps the last project/notProject
 * answer for display and carries the error, and `retry(id)` reads again. A
 * refresh is never dropped: while a batch is in flight one more is queued.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { LayerfsApi } from '../api.ts'

export type OwnershipState = 'project' | 'notProject' | 'unknown'

/** What one session's ownership is, and the last answer while a read fails. */
export interface OwnershipEntry {
  readonly state: OwnershipState
  /** The project name, when a project is known (kept through `unknown`). */
  readonly project?: string
  readonly projectId?: string
  /** The project session's local scratch folder, when a project is known. */
  readonly scratch?: string
  /** Why the last read failed; only present after a failed read. */
  readonly error?: unknown
}

/** One coalescing window (the UI data-loading rule: at least 500 ms). */
export const OWNERSHIP_COALESCE_MS = 500
/** The host's cap for one `sessions.places` batch. */
export const OWNERSHIP_MAX_IDS = 200

/** One batch answer's value: a project, or `null` for a plain session. */
export interface OwnershipPlace { readonly project: string, readonly projectId?: string, readonly scratch?: string }

const UNKNOWN: OwnershipEntry = Object.freeze({ state: 'unknown' })
const NOT_PROJECT: OwnershipEntry = Object.freeze({ state: 'notProject' })

const same = (a: OwnershipEntry, b: OwnershipEntry): boolean =>
  a.state === b.state && a.project === b.project && a.projectId === b.projectId && a.scratch === b.scratch && a.error === b.error

export class OwnershipStore {
  private readonly entries = new Map<string, OwnershipEntry>()
  private readonly listeners = new Set<() => void>()
  /** Ids a read has been asked for and not answered yet. */
  private readonly pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private readonly offs: (() => void)[]

  constructor(private readonly api: LayerfsApi) {
    // One subscription per client, however many rows/chips mount.
    this.offs = [
      this.api.onEvent('layerfs-session', (event) => this.sessionEvent(event)),
      this.api.onEvent('connection', () => this.refresh(this.entries.keys())),
    ]
  }

  /** The last answer for one id; a stable object until that answer changes. */
  entry = (id: string): OwnershipEntry => this.entries.get(id) ?? UNKNOWN

  /** The ids currently answered as project; the row adapter's probe watches these. */
  projectIds = (): string[] => {
    const ids: string[] = []
    for (const [id, entry] of this.entries) if (entry.state === 'project') ids.push(id)
    return ids
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Ask for these ids; the whole request shares one coalesced batch. */
  refresh = (ids: Iterable<string>): void => {
    let added = false
    for (const id of ids) {
      if (typeof id !== 'string' || !id || this.pending.has(id)) continue
      this.pending.add(id)
      added = true
    }
    if (added) this.schedule()
  }

  /** Read one id now: the person pressed Retry, so do not wait out the window. */
  retry = (id: string): void => {
    if (!id) return
    this.pending.add(id)
    if (this.running) return
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    void this.flush()
  }

  /** Unsubscribe (plugin unload, or a test). */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
    for (const off of this.offs.splice(0)) off()
    this.listeners.clear()
  }

  private sessionEvent(event: { data?: { sessionId?: unknown } }): void {
    const id = event?.data?.sessionId
    if (typeof id === 'string' && id) this.refresh([id])
    else this.refresh(this.entries.keys())
  }

  private schedule(): void {
    if (this.running || this.timer !== undefined) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, OWNERSHIP_COALESCE_MS)
  }

  private async flush(): Promise<void> {
    if (this.running) return
    const ids = [...this.pending].slice(0, OWNERSHIP_MAX_IDS)
    for (const id of ids) this.pending.delete(id)
    if (!ids.length) return
    this.running = true
    let changed = false
    try {
      const answer = await this.api.op<{ places?: Record<string, OwnershipPlace | null> }>('sessions.places', { sessionIds: ids })
      const places = answer?.places ?? {}
      for (const id of ids) {
        if (!Object.prototype.hasOwnProperty.call(places, id)) {
          changed = this.put(id, this.failed(id, new Error(`sessions.places did not answer for ${id}`))) || changed
          continue
        }
        const place = places[id]
        changed = this.put(id, place ? {
          state: 'project',
          project: place.project,
          ...(place.projectId ? { projectId: place.projectId } : {}),
          ...(place.scratch ? { scratch: place.scratch } : {}),
        } : NOT_PROJECT) || changed
      }
    } catch (error) {
      for (const id of ids) changed = this.put(id, this.failed(id, error)) || changed
    } finally {
      this.running = false
      // A refresh that arrived while this batch ran is one more batch, never dropped.
      if (this.pending.size) this.schedule()
    }
    if (changed) this.notify()
  }

  /** `unknown` with the last answer kept: a failed read must not flip what is on screen. */
  private failed(id: string, error: unknown): OwnershipEntry {
    const last = this.entries.get(id)
    return {
      state: 'unknown',
      ...(last?.project ? { project: last.project } : {}),
      ...(last?.projectId ? { projectId: last.projectId } : {}),
      ...(last?.scratch ? { scratch: last.scratch } : {}),
      error,
    }
  }

  private put(id: string, next: OwnershipEntry): boolean {
    const previous = this.entries.get(id)
    if (previous && same(previous, next)) return false
    this.entries.set(id, next)
    return true
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

const stores = new WeakMap<LayerfsApi, OwnershipStore>()

/** The one store for an api (the client has one for its lifetime); created on first use. */
export function ownershipStore(api: LayerfsApi): OwnershipStore {
  let store = stores.get(api)
  if (!store) { store = new OwnershipStore(api); stores.set(api, store) }
  return store
}

/** Drop an api's store (tests; the client keeps its one store for its lifetime). */
export function disposeOwnership(api: LayerfsApi): void {
  stores.get(api)?.dispose()
  stores.delete(api)
}

/** One session's ownership, live; cached across renders through {@link ownershipStore}. */
export function useOwnership(api: LayerfsApi, sessionId: string): OwnershipEntry {
  const store = ownershipStore(api)
  useEffect(() => { store.refresh([sessionId]) }, [store, sessionId])
  return useSyncExternalStore(store.subscribe, () => store.entry(sessionId), () => store.entry(sessionId))
}
