import { useEffect, useRef, useState } from 'react'
import type { LayerfsApi } from '../api.ts'
import type { SessionFailure } from '../../shared/pg-failure.ts'
import { useQuery } from '../files/use-query.ts'
import type { MachinesView } from '../machines/model.ts'
import { useHostEvents } from '../storage/hooks.ts'
import { readWithDeadline, steadyRead } from './read-deadline.ts'

/**
 * The sidebar's reads (catalog, Storage, machines) are on every page: host events
 * carry their changes, so the poll only catches what no event reports (a VM that died).
 */
export const SIDEBAR_POLL_MS = 60_000
/** Host events arrive many a second during a team run: one reread per burst. */
export const EVENT_COALESCE_MS = 2_000

export function useProjectMachines(api: LayerfsApi) {
  const last = useRef<{ value: MachinesView, failures: number } | null>(null)
  const read = useQuery(() => steadyRead(last, () => readWithDeadline(api.call<MachinesView>('GET', '/api/machines'))), [api], { cache: 'GET /api/machines' })
  useHostEvents(api, ['machine-progress', 'layerfs-availability', 'storage', 'runtime-changed', 'connection'], read.reload, { coalesceMs: EVENT_COALESCE_MS })
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') read.reload() }, SIDEBAR_POLL_MS)
    return () => clearInterval(timer)
  }, [read.reload])
  return read
}

export interface ProjectSession {
  sessionId: string, title: string | null, local: boolean, updatedAt: number
  /** `sessions.list`: a binding's state (`bound`, `closed`, `failed`), else `pending`, `local` or `stored` (only in the Store). */
  state?: string
  /** Local bindings only: `interrupted` when its Store became unavailable or its context was lost. */
  executionState?: 'inactive' | 'activating' | 'active' | 'interrupted'
  error?: string | null
  failure?: SessionFailure | null
}
interface SessionList { sessions: ProjectSession[], discoveryError?: { code: string, message: string } | null }

/** The local session list (this DSH's own logs, no Store walk). */
const LOCAL_POLL_MS = 15_000
/** Delay before an expand asks the Store for stored sessions (the local rows paint first). */
const ARCHIVE_DEFER_MS = 400
/** The portable archive: a Store walk, so slow (F22). */
const ARCHIVE_POLL_MS = 60_000

/**
 * The two reads' rows as one list. The local read paints first, then the archive
 * read lands: a session already on screen keeps the place it painted in (its
 * first `updatedAt` is kept for ordering), so a late answer only adds rows; its
 * fields and a missing title fill in from the other answer. `order` is the
 * caller's map of session id to first-seen `updatedAt`, reset when the project
 * changes.
 */
export function mergeSessionRows(local: readonly ProjectSession[] | undefined, archive: readonly ProjectSession[] | undefined, order?: Map<string, number>): ProjectSession[] {
  const rows = new Map<string, ProjectSession>()
  for (const s of archive ?? []) rows.set(s.sessionId, s)
  for (const s of local ?? []) {
    const kept = rows.get(s.sessionId)
    // The archive keeps a settled title; the local row's own fields win.
    rows.set(s.sessionId, { ...kept, ...s, title: kept?.title ?? s.title })
  }
  const keyed = [...rows.values()].map((row) => {
    let at = order?.get(row.sessionId)
    if (at === undefined) {
      at = row.updatedAt
      order?.set(row.sessionId, at)
    }
    return { row, at }
  })
  // Stable: rows added by the late answer keep their sorted place below the
  // rows already visible.
  keyed.sort((a, b) => b.at - a.at)
  return keyed.map(({ row }) => row)
}

/** Local logs remain visible while the portable archive loads or fails. */
export function useProjectSessions(api: LayerfsApi, project: string, enabled = true, projectId?: string) {
  const load = (localOnly: boolean) => enabled
    ? readWithDeadline(api.op<SessionList>('sessions.list', { project, projectId, localOnly }))
    : Promise.resolve<SessionList>({ sessions: [] })
  const key = `${project}:${projectId ?? ''}:${enabled}`
  const local = useQuery(() => load(true), [api, project, projectId, enabled], { cache: `sessions-local:${key}` })
  // The archive read is a Store walk (a Branch list plus a manifest per stored
  // session) and it competes with the local read that must paint the list: let
  // the local paint go first, then ask for the stored rows. A later expand inside
  // the window finds the answer in the query cache, so the deferral costs one
  // frame, not a second walk.
  const [archiveArmed, setArchiveArmed] = useState(enabled)
  useEffect(() => {
    if (!enabled) return
    setArchiveArmed(false)
    const timer = setTimeout(() => setArchiveArmed(true), ARCHIVE_DEFER_MS)
    return () => clearTimeout(timer)
  }, [enabled, project, projectId])
  const archive = useQuery(
    () => archiveArmed ? load(false) : Promise.resolve<SessionList>({ sessions: [] }),
    [api, project, projectId, enabled, archiveArmed],
    { cache: `sessions-archive:${key}` })
  const reload = () => { local.reload(); archive.reload() }
  /** Reload only the local read: an open or an archive only changes local rows, and a Store walk per open made a click slow. */
  const reloadLocal = () => { local.reload() }
  // Session, storage and machine events come many a second during a run: they reread the
  // local list only. The portable archive (a Store walk: a Branch list plus one manifest
  // read per stored session) is reread on reconnect and by its own slow poll; under a team
  // run a 15 s archive poll per open project stalled host reads (Quarry v2 FIX-LOG F22).
  useHostEvents(api, ['layerfs-session', 'layerfs-workspaces-changed', 'layerfs-availability', 'storage', 'machine-progress'], () => { if (enabled) local.reload() }, { coalesceMs: 1_000 })
  useHostEvents(api, ['connection'], () => { if (enabled) reload() })
  useEffect(() => {
    if (!enabled) return
    const visible = () => document.visibilityState === 'visible'
    const fast = setInterval(() => { if (visible()) local.reload() }, LOCAL_POLL_MS)
    const slow = setInterval(() => { if (visible()) archive.reload() }, ARCHIVE_POLL_MS)
    return () => { clearInterval(fast); clearInterval(slow) }
  }, [enabled, local.reload, archive.reload])
  // The first read to paint fixes each session's place; the other answer adds
  // rows (and titles) without dropping or moving one already on screen.
  const order = useRef<{ key: string, at: Map<string, number> }>({ key, at: new Map() })
  if (order.current.key !== key) order.current = { key, at: new Map() }
  return {
    sessions: mergeSessionRows(local.data?.sessions, archive.data?.sessions, order.current.at),
    loading: local.loading || archive.loading,
    /** An answer has arrived at least once: a reload after that keeps the rows, so the loading notice is for the first read only. */
    loaded: local.data !== undefined || archive.data !== undefined,
    error: local.error ?? archive.error ?? (archive.data?.discoveryError ? new Error(archive.data.discoveryError.message) : undefined),
    reload,
    reloadLocal,
  }
}
