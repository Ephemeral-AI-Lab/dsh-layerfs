/**
 * Project exports the host runs (`/api/project-exports`, host
 * routes/project-exports.ts), shared by every view that shows one: the Home
 * project row, its export dialog, and History's inspector and dock. One store
 * per page: the list is read once, then each `project-export { export }` event
 * moves its job in place (the host coalesces byte updates to one per 500 ms).
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { HostEvent, LayerfsApi } from '../api.ts'

export type ExportPhase = 'queued' | 'prepare' | 'export' | 'finalize' | 'stopping' | 'done' | 'stopped' | 'failed'

export interface ProjectExport {
  id: string
  project: string
  branch: string
  commit: string | null
  head: boolean
  folder: string
  destination: string
  phase: ExportPhase
  done: number | null
  total: number | null
  files: number | null
  error?: { code: string, message: string, detail?: unknown, fix?: string }
  startedAt: number
  updatedAt: number
  endedAt: number | null
}

export interface ExportInput {
  project: string
  branch?: string
  commit?: string
  folder: string
  name?: string
}

const RUNNING = new Set<ExportPhase>(['queued', 'prepare', 'export', 'finalize', 'stopping'])
export const running = (job: ProjectExport | null | undefined): boolean => !!job && RUNNING.has(job.phase)
/** Whether a stop can still reach it: not while it finalizes, nor once asked. */
export const stoppable = (job: ProjectExport): boolean => job.phase === 'queued' || job.phase === 'prepare' || job.phase === 'export'
/** Whole percent copied, or null while the size is not known or nothing is copied yet. */
export function percentOf(job: ProjectExport): number | null {
  if (job.phase === 'finalize' || job.phase === 'done') return 100
  if (job.total === null || job.done === null) return null
  if (job.total === 0) return 100
  return Math.max(0, Math.min(100, Math.floor((job.done / job.total) * 100)))
}
/** The folder name the export makes, for a preview: the last path part. */
export const leaf = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

/** A suggested folder name: the project for main's head, else the project, Branch and short Commit (as the host does). */
export function suggestedName(project: string, branch: string, commit: string | null): string {
  const name = project.slice(project.indexOf('/') + 1)
  const text = branch === 'main' && !commit ? name : [name, branch, commit?.slice(0, 8)].filter(Boolean).join('-')
  return text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 120) || 'project'
}

const FOLDER_KEY = 'dsh-layerfs:export-folder'
/** The folder the viewer last exported into (a convenience; nothing breaks without it). */
export function lastFolder(): string {
  try { return localStorage.getItem(FOLDER_KEY) ?? '' } catch { return '' }
}
export function rememberFolder(folder: string): void {
  try { localStorage.setItem(FOLDER_KEY, folder) } catch { /* storage unavailable */ }
}

/** The page's export store, one per api. */
class Store {
  private jobs: ReadonlyMap<string, ProjectExport> = new Map()
  /** Dismissed here: a list read or event already in flight never brings them back. */
  private readonly dismissed = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private off: (() => void) | null = null
  private reading = false
  private again = false

  constructor(private readonly api: LayerfsApi) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.off) {
      this.off = this.api.onEvent('project-export', (e) => this.event(e))
      this.read()
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size && this.off) { this.off(); this.off = null }
    }
  }

  snapshot = (): ReadonlyMap<string, ProjectExport> => this.jobs

  /** Reads the list again; a read asked for while one runs queues one more after it. */
  read(): void {
    if (this.reading) { this.again = true; return }
    this.reading = true
    void this.api.call<{ exports: ProjectExport[] }>('GET', '/api/project-exports').then((r) => {
      const next = new Map<string, ProjectExport>()
      for (const job of r.exports ?? []) {
        if (this.dismissed.has(job.id)) continue
        const known = this.jobs.get(job.id)
        next.set(job.id, known && known.updatedAt > job.updatedAt ? known : job)
      }
      this.set(next)
    }, () => { /* an older host has no exports: nothing to show */ }).finally(() => {
      this.reading = false
      if (this.again) { this.again = false; this.read() }
    })
  }

  put(job: ProjectExport): void {
    if (this.dismissed.has(job.id)) return
    const known = this.jobs.get(job.id)
    // an event older than what is shown (the admission answer can overtake it) changes nothing
    if (known && known.updatedAt > job.updatedAt) return
    this.set(new Map(this.jobs).set(job.id, job))
  }

  drop(id: string): void {
    this.dismissed.add(id)
    if (!this.jobs.has(id)) return
    const next = new Map(this.jobs)
    next.delete(id)
    this.set(next)
  }

  private event(e: HostEvent): void {
    const job = (e.data as { export?: ProjectExport } | undefined)?.export
    if (job && typeof job.id === 'string') this.put(job)
  }

  private set(next: ReadonlyMap<string, ProjectExport>): void {
    this.jobs = next
    for (const l of this.listeners) l()
  }
}

const stores = new WeakMap<LayerfsApi, Store>()
const storeOf = (api: LayerfsApi): Store => {
  let s = stores.get(api)
  if (!s) { s = new Store(api); stores.set(api, s) }
  return s
}

/** Every listed export, newest first; `project` narrows to one project. Rereads the list on mount. */
export function useExports(api: LayerfsApi, project?: string | null): ProjectExport[] {
  const store = storeOf(api)
  const jobs = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  useEffect(() => { store.read() }, [store])
  return [...jobs.values()].filter((j) => !project || j.project === project).sort((a, b) => b.startedAt - a.startedAt)
}

/** One export by id, live. */
export function useExport(api: LayerfsApi, id: string | null): ProjectExport | null {
  const store = storeOf(api)
  const jobs = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  return id ? jobs.get(id) ?? null : null
}

export async function startExport(api: LayerfsApi, input: ExportInput): Promise<ProjectExport> {
  const job = await api.call<ProjectExport>('POST', '/api/project-exports', input)
  storeOf(api).put(job)
  rememberFolder(input.folder)
  return job
}

export async function stopExport(api: LayerfsApi, id: string): Promise<void> {
  storeOf(api).put(await api.call<ProjectExport>('POST', `/api/project-exports/${encodeURIComponent(id)}/stop`))
}

export async function dismissExport(api: LayerfsApi, id: string): Promise<void> {
  storeOf(api).drop(id)
  await api.call('DELETE', `/api/project-exports/${encodeURIComponent(id)}`).catch(() => {})
}

export async function revealExport(api: LayerfsApi, id: string): Promise<void> {
  await api.call('POST', `/api/project-exports/${encodeURIComponent(id)}/reveal`)
}
