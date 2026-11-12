import { useEffect, useRef } from 'react'
import type { LayerfsApi } from '../api.ts'
import { useQuery } from '../files/use-query.ts'
import type { MachinesView } from '../machines/model.ts'
import { useHostEvents } from '../storage/hooks.ts'
import { readWithDeadline, steadyRead } from './read-deadline.ts'

export function useProjectMachines(api: LayerfsApi) {
  const last = useRef<{ value: MachinesView, failures: number } | null>(null)
  const read = useQuery(() => steadyRead(last, () => readWithDeadline(api.call<MachinesView>('GET', '/api/machines'))), [api])
  useHostEvents(api, ['machine-progress', 'layerfs-availability', 'storage', 'runtime-changed', 'connection'], read.reload)
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') read.reload() }, 15_000)
    return () => clearInterval(timer)
  }, [read.reload])
  return read
}

export interface ProjectSession {
  sessionId: string, title: string | null, local: boolean, updatedAt: number
  /** Local bindings only: `interrupted` when its Store became unavailable or its context was lost. */
  executionState?: 'inactive' | 'activating' | 'active' | 'interrupted'
  error?: string | null
}
interface SessionList { sessions: ProjectSession[], discoveryError?: { code: string, message: string } | null }

/** Local logs remain visible while the portable archive loads or fails. */
export function useProjectSessions(api: LayerfsApi, project: string, enabled = true, projectId?: string) {
  const load = (localOnly: boolean) => enabled
    ? readWithDeadline(api.op<SessionList>('sessions.list', { project, projectId, localOnly }))
    : Promise.resolve<SessionList>({ sessions: [] })
  const local = useQuery(() => load(true), [api, project, projectId, enabled])
  const archive = useQuery(() => load(false), [api, project, projectId, enabled])
  const reload = () => { local.reload(); archive.reload() }
  useHostEvents(api, ['layerfs-session', 'layerfs-availability', 'layerfs-workspaces-changed', 'storage', 'machine-progress', 'connection'], () => { if (enabled) reload() })
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') reload() }, 15_000)
    return () => clearInterval(timer)
  }, [enabled, local.reload, archive.reload])
  const rows = new Map((archive.data?.sessions ?? []).map((s) => [s.sessionId, s]))
  for (const s of local.data?.sessions ?? []) rows.set(s.sessionId, { ...rows.get(s.sessionId), ...s, title: rows.get(s.sessionId)?.title ?? s.title })
  return {
    sessions: [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    loading: local.loading || archive.loading,
    error: local.error ?? archive.error ?? (archive.data?.discoveryError ? new Error(archive.data.discoveryError.message) : undefined),
    reload,
  }
}
