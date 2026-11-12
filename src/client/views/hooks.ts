/** Session data shared by the conversation views: the project root and its `session.state`. */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { LayerfsApi } from '../api.ts'
import { rootOf, type MapBinding, type SessionRow } from './model.ts'

/** DSH's session list as an observable (`ctx.sessions.list`). */
export interface SessionsSource {
  getSnapshot: () => { byId?: Record<string, SessionRow>, projectionsBySession?: Record<string, { values?: { title?: unknown, subagent?: { label?: unknown } } }> } | undefined
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
  binding: (MapBinding & { sessionId: string, kind: 'project' | 'shared', mount?: string }) | null
  project: string | null
  scratchProject?: boolean
  status: { overlay?: { inodes?: number, entries?: number }, error?: { message: string } } | null
  execution?: { state: string, available: boolean, reason?: string }
}

/**
 * `session.state` of the project root of `sessionId`, reread on LayerFS
 * session events.
 */
export function useRootState(api: LayerfsApi, sessionId: string, source: SessionsSource | undefined) {
  const { byId, title, label } = useSessionRows(source)
  const root = rootOf(sessionId, byId)
  const [view, setView] = useState<SessionStateView | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])
  useEffect(() => {
    let live = true
    api.op<SessionStateView>('session.state', { sessionId: root }).then(
      (v) => { if (live) { setView(v); setError(null) } },
      (e) => { if (live) setError(e) },
    )
    return () => { live = false }
  }, [api, root, tick])
  useEffect(() => {
    const mine = (e: { data?: any }) => { if (!e.data?.sessionId || e.data.sessionId === root) reload() }
    const offs = [api.onEvent('layerfs-session', mine), api.onEvent('layerfs-checkpoint', mine), api.onEvent('connection', reload)]
    return () => { offs.forEach((off) => off()) }
  }, [api, root, reload])
  return { root, byId, title, label, view: view?.sessionId === root ? view : null, error, reload, tick }
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
