/** Session data shared by the conversation views: the project root and its `session.state`. */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { LayerfsApi } from '../api.ts'
import { useQuery } from '../files/use-query.ts'
import { rootOf, SESSION_POLL_MS, type MapBinding, type SessionRow } from './model.ts'
import type { BranchKind } from '../../shared/session-branch.ts'

/** DSH's session list as an observable (`ctx.sessions.list`). */
export interface SessionsSource {
  getSnapshot: () => { ids?: readonly string[], byId?: Record<string, SessionRow>, projectionsBySession?: Record<string, { values?: { title?: unknown, subagent?: { label?: unknown } } }> } | undefined
  subscribe: (listener: () => void) => () => void
}

const EMPTY: Record<string, SessionRow> = {}
const NONE: Record<string, { values?: { title?: unknown, subagent?: { label?: unknown } } }> = {}
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined

/** Summaries by id, and titles and subagent labels where DSH's projections have them. */
export function useSessionRows(source: SessionsSource | undefined): { byId: Record<string, SessionRow>, title: (id: string) => string | undefined, label: (id: string) => string | undefined } {
  const subscribe = useCallback((listener: () => void) => source?.subscribe(listener) ?? (() => {}), [source])
  const byId = useSyncExternalStore(subscribe, () => source?.getSnapshot()?.byId ?? EMPTY)
  const projections = useSyncExternalStore(subscribe, () => source?.getSnapshot()?.projectionsBySession ?? NONE)
  const title = useCallback((id: string) => text(projections[id]?.values?.title), [projections])
  /** The label a subagent was delegated under (`subagent` projection), e.g. "Docs worker". */
  const label = useCallback((id: string) => text(projections[id]?.values?.subagent?.label), [projections])
  return { byId, title, label }
}

/** What `session.state` answers, as far as the views read it. */
export interface SessionStateView {
  sessionId: string
  binding: (MapBinding & { sessionId: string, kind: 'project' | 'shared', mount?: string, branchKind: BranchKind, restore?: number }) | null
  project: string | null
  status: { overlay?: { inode_count?: number, entry_count?: number }, error?: { message: string } } | null
  execution?: { state: string, available: boolean, reason?: string }
}

/**
 * `session.state` of the project root of `sessionId`, reread on LayerFS
 * session events.
 */
export function useRootState(api: LayerfsApi, sessionId: string, source: SessionsSource | undefined) {
  const { byId, title, label } = useSessionRows(source)
  const root = rootOf(sessionId, byId)
  const [tick, setTick] = useState(0)
  // Content views (Files' tree, History's graph, Stats' storage) only move when a
  // checkpoint lands, not on every operation burst: their own tick.
  const [contentTick, setContentTick] = useState(0)
  // One read at a time, never dropped for a newer event (events come many a second during a
  // run); the last answer per session draws at once when a tab mounts.
  // `observe`: this read runs on mount, events and a poll (no press), so it changes nothing on the host
  const query = useQuery(() => api.op<SessionStateView>('session.state', { sessionId: root, observe: true }), [api, root], { refresh: [tick], cache: `session.state:${root}`, persist: true })
  const reload = useCallback(() => setTick((n) => n + 1), [])
  const reloadContent = useCallback(() => setContentTick((n) => n + 1), [])
  useEffect(() => {
    // Coalesce bursts: one refresh per 500 ms at most, the content tick separately so
    // the session read can follow every operation while the views wait for a checkpoint.
    let timer: ReturnType<typeof setTimeout> | undefined
    let contentTimer: ReturnType<typeof setTimeout> | undefined
    const later = () => { if (!timer) timer = setTimeout(() => { timer = undefined; reload() }, 500) }
    const laterContent = () => { if (!contentTimer) contentTimer = setTimeout(() => { contentTimer = undefined; reloadContent() }, 500) }
    const mine = (e: { data?: any }) => { if (!e.data?.sessionId || e.data.sessionId === root) later() }
    const mineContent = (e: { data?: any }) => { if (!e.data?.sessionId || e.data.sessionId === root) { later(); laterContent() } }
    // a tool call's operation changed the Workspace (its unsaved line follows), and a shell's writes send no event: a poll while visible
    const offs = [api.onEvent('layerfs-session', mine), api.onEvent('layerfs-checkpoint', mineContent), api.onEvent('layerfs-operation', mine), api.onEvent('connection', () => { later(); laterContent() })]
    const poll = setInterval(() => { if (document.visibilityState === 'visible') later() }, SESSION_POLL_MS)
    return () => { offs.forEach((off) => off()); clearInterval(poll); if (timer) clearTimeout(timer); if (contentTimer) clearTimeout(contentTimer) }
  }, [api, root, reload, reloadContent])
  const view = query.data?.sessionId === root ? query.data : null
  return { root, byId, title, label, view, error: view ? null : query.error ?? null, reload, tick, contentTick }
}

/** One focus request between views: JSON `{branch?, commit?, path?}`. */
export interface ViewFocus { branch?: string, commit?: string, path?: string }

export function parseFocus(raw: string | undefined | null): ViewFocus | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value as ViewFocus : null
  } catch { return null }
}
