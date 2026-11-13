/**
 * A project's Sandboxes tab: the conversation Sandbox map at project scope.
 * Every conversation (and its subagents) that called LayerFS on this project
 * or its Sandboxes, plus the calls made outside conversations (pages, presets,
 * other clients), wired to the branches and the open Sandboxes, live.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { LOGS_EVENT, parseTag, type LabeledLine, type LogsProjectAnswer } from '../../shared/logs.ts'
import { enc, type LayerfsApi } from '../api.ts'
import { useQuery } from '../files/use-query.ts'
import { LoadError, Loading } from '../ui/index.tsx'
import { useSessionRows, type SessionsSource } from '../views/hooks.ts'
import type { Translate } from '../views/locale.ts'
import { agentTree, rootOf, type LiveSandboxes, type MapAgent } from '../views/model.ts'
import { SandboxMap } from '../views/SandboxView.tsx'
import type { StorageDialog } from './dialogs.tsx'
import type { StorageT } from './locale.ts'
import { refusalLabels } from './parts.tsx'
import type { SandboxInfo } from './types.ts'

/** What the Storage page needs of the conversation views to draw the map. */
export interface ProjectMapShare {
  /** The conversation views' `t` (the map's copy). */
  t: Translate
  /** DSH's session list, for subagent trees and titles. */
  sessions: SessionsSource | undefined
}

const LIMIT = 500
/** Agent ids of the calls made outside conversations. */
const HOST = '#host'
const OTHER = '#other'
/** Calls that change what is open: when one appears, the Sandbox list is reread. */
const SHAPE = new Set(['sandbox.create', 'sandbox.close', 'workspace.mount', 'workspace.unmount'])

const keyOf = (line: LabeledLine) => `${line.at}|${line.tag ?? ''}|${line.argv.join('\u0000')}`
const agentOf = (line: LabeledLine) => parseTag(line.tag)?.sessionId ?? (line.tag?.startsWith('dsh:') ? HOST : OTHER)
const opOf = (line: LabeledLine) => `${line.argv[0]}.${String(line.argv[1] ?? '').replaceAll('_', '-')}`

/**
 * `logs.project`, reread when the log grows: newest `LIMIT` lines, merged so a
 * reread does not reset the replay.
 */
function useProjectCalls(api: LayerfsApi, project: string, sandboxes: readonly string[] | undefined, tick: number) {
  const [lines, setLines] = useState<LabeledLine[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [hasMore, setHasMore] = useState(false)
  const [grow, setGrow] = useState(0)
  const known = (sandboxes ?? []).join('|')
  useEffect(() => { setLines(null); setError(null) }, [project])
  // One read at a time: a refresh while one runs queues one more (the scan is a heavy host
  // read and the log grows every second in a run); another project or Sandbox set replaces it.
  const flight = useRef<{ key: string } | null>(null)
  const queued = useRef(false)
  const scope = `${project}\u0000${known}\u0000${sandboxes === undefined}`
  const current = useRef(scope)
  current.current = scope
  useEffect(() => {
    if (sandboxes === undefined) return
    if (flight.current?.key === scope) { queued.current = true; return }
    let live = true
    const token = { key: scope }
    flight.current = token
    const done = () => {
      if (flight.current !== token) return
      flight.current = null
      if (queued.current && live) { queued.current = false; setGrow((n) => n + 1) }
    }
    api.op<LogsProjectAnswer>('logs.project', { project, sandboxes: known ? known.split('|') : [], limit: LIMIT }).finally(done).then((answer) => {
      if (!live) return
      setError(null)
      setHasMore(answer.has_more && answer.lines.length >= LIMIT)
      setLines((had) => {
        // Same lines: keep the array, so the map does not rebuild.
        if (had && had.length === answer.lines.length && had.every((l, i) => keyOf(l) === keyOf(answer.lines[i]))) return had
        return answer.lines
      })
    }, (e) => { if (live) setError(e) })
    // A refresh keeps this read (its answer is still this scope's); another scope or unmount drops it.
    return () => { if (current.current !== token.key) live = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, project, known, tick, grow, sandboxes === undefined])
  useEffect(() => () => { current.current = '' }, [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => { if (!timer) timer = setTimeout(() => { timer = undefined; if (document.visibilityState === 'visible') setGrow((n) => n + 1) }, 3000) }
    const offs = [api.onEvent(LOGS_EVENT, later), api.onEvent('layerfs-checkpoint', later), api.onEvent('connection', later)]
    return () => { offs.forEach((off) => off()); if (timer) clearTimeout(timer) }
  }, [api])
  return { lines, error, hasMore }
}

export function ProjectSandboxes({ api, t: ts, share, project, tick, onDialog }: {
  api: LayerfsApi
  t: StorageT
  share: ProjectMapShare
  project: string
  tick: number
  onDialog: (d: StorageDialog) => void
}): ReactNode {
  const t = share.t
  const [closed, setClosed] = useState(0)
  // The Sandbox list is reread on a refresh, a Close, and when the calls open or close something.
  const [shape, setShape] = useState(0)
  const boxes = useQuery(() => api.call<SandboxInfo[]>('GET', `/api/projects/${enc(project)}/sandboxes`), [api, project, shape], { refresh: [tick, closed], cache: `sandboxes:${project}:${String(shape)}` })
  const names = useMemo(() => boxes.data?.map((b) => b.name), [boxes.data])
  const calls = useProjectCalls(api, project, boxes.data || boxes.error ? names ?? [] : undefined, tick)
  const shapeCount = useMemo(() => calls.lines?.filter((l) => l.outcome === 'ok' && SHAPE.has(opOf(l))).length ?? 0, [calls.lines])
  const lastShape = useRef(shapeCount)
  useEffect(() => { if (lastShape.current !== shapeCount) { lastShape.current = shapeCount; setShape((n) => n + 1) } }, [shapeCount])

  const { byId, title, label } = useSessionRows(share.sessions)
  // The list carries no Workspaces (`unread`): read each open Sandbox's (sandbox.get, cached
  // by the host) once the list is in, so a mounted Workspace is not shown as "No workspaces".
  const [detail, setDetail] = useState<Record<string, SandboxInfo['workspaces']>>({})
  useEffect(() => {
    const unread = boxes.data?.filter((b) => b.unread && b.state !== 'gone') ?? []
    if (!unread.length) return
    let on = true
    void Promise.all(unread.map((b) => api.call<SandboxInfo>('GET', `/api/sandboxes/${enc(b.name)}`)
      .then((r) => [b.name, r.workspaces] as const, () => null)))
      .then((pairs) => { if (on) setDetail(Object.fromEntries(pairs.filter((p) => p !== null))) })
    return () => { on = false }
  }, [api, boxes.data])
  const live = useMemo<LiveSandboxes | undefined>(() => boxes.data && {
    at: Date.now(),
    sandboxes: boxes.data.filter((b) => b.state !== 'gone').map((b) => ({
      name: b.name, machine: b.machine, workspaces: (b.unread ? detail[b.name] ?? [] : b.workspaces).map((w) => ({ id: w.ws, branch: w.branch || undefined })),
    })),
  }, [boxes.data, detail])

  // Agents: each conversation tree that called, newest activity first, then the calls outside conversations.
  const { agents, byAgent } = useMemo(() => {
    const byAgent: Record<string, LabeledLine[]> = {}
    const newest = new Map<string, number>()
    for (const line of calls.lines ?? []) {
      const id = agentOf(line)
      ;(byAgent[id] ??= []).push(line)
      const root = id === HOST || id === OTHER ? id : rootOf(id, byId)
      newest.set(root, Math.max(newest.get(root) ?? 0, line.at))
    }
    for (const [id, row] of Object.entries(byId)) if (row?.running && byAgent[id]) newest.set(rootOf(id, byId), Date.now())
    const roots = [...newest.keys()].filter((id) => id !== HOST && id !== OTHER).sort((a, b) => newest.get(b)! - newest.get(a)!)
    const agents: MapAgent[] = []
    const seen = new Set<string>()
    for (const root of roots) for (const agent of agentTree(root, byId)) if (!seen.has(agent.id)) { seen.add(agent.id); agents.push(agent) }
    // A session that called but is not in DSH's list (removed, or another machine's) stands alone.
    for (const id of Object.keys(byAgent)) if (id !== HOST && id !== OTHER && !seen.has(id)) { seen.add(id); agents.push({ id, depth: 0, running: false }) }
    for (const id of [HOST, OTHER]) if (byAgent[id]) agents.push({ id, depth: 0, running: false, ...(id === OTHER && byAgent[HOST] ? { joins: HOST } : {}) })
    return { agents, byAgent }
  }, [calls.lines, byId])

  const lineTitle = useCallback((id: string) => byAgent[id]?.find((l) => l.dsh?.title)?.dsh?.title, [byAgent])
  const name = useCallback((agent: MapAgent) => agent.id === HOST ? t('hostAgent') : agent.id === OTHER ? t('otherClients')
    : agent.depth === 0 ? t('mainAgent') : label(agent.id) ?? title(agent.id) ?? lineTitle(agent.id) ?? t('subagent', { n: agents.indexOf(agent) }), [t, label, title, lineTitle, agents])
  const groupTitle = useCallback((head: MapAgent) => head.id === HOST || head.id === OTHER ? t('outside')
    : title(head.id) ?? lineTitle(head.id) ?? t('untitled'), [t, title, lineTitle])
  const boxState = useCallback((box: string) => {
    const info = boxes.data?.find((b) => b.name === box)
    return info ? { text: info.op ? `${info.op.name} · ${info.op.phase}` : info.state, live: info.state === 'running' || info.state === 'creating' || info.state === 'closing' } : undefined
  }, [boxes.data])
  const boxActions = useCallback((box: string) => {
    const info = boxes.data?.find((b) => b.name === box)
    if (!info) return null
    return (
      <Button variant="ghost" size="sm" disabled={info.state === 'gone' || info.state === 'closing'} onClick={() => onDialog({
        kind: 'confirm', title: ts('closeSandboxConfirm', { name: box }), body: ts('closeSandboxBody'), action: ts('closeSandbox'),
        force: { label: ts('closeSandboxForce'), action: ts('closeSandboxForceAction') },
        run: (force) => api.call('DELETE', `/api/sandboxes/${enc(box)}${force ? '?force=1' : ''}`).then(() => setClosed((n) => n + 1)),
      })}>{ts('closeSandbox')}</Button>
    )
  }, [boxes.data, api, onDialog, ts])

  const unsupported = !!calls.error && /unknown-op|no dsh-layerfs operation/i.test(String((calls.error as any)?.code ?? '') + String((calls.error as any)?.message ?? ''))
  if (calls.error && !unsupported && !calls.lines) return <LoadError title={ts('projectFailed')} error={calls.error} labels={refusalLabels(ts)} retryLabel={ts('retry')} onRetry={() => setShape((n) => n + 1)} />
  if (!calls.lines && !unsupported) return <Loading label={ts('loading')} />
  const shown = calls.lines?.length ?? 0
  const note = unsupported ? t('projectUnsupported') : shown ? (calls.hasMore ? t('projectCallsOlder', { n: shown }) : t('projectCalls', { n: shown })) : undefined
  return (
    <SandboxMap api={api} t={t} project={project} agents={agents} calls={byAgent} loaded binding={null} live={live}
      startLive name={name} groupTitle={groupTitle} boxState={boxState} boxActions={boxActions} note={note}
      emptyCopy={{ title: t('projectNoActivity'), body: t('projectNoActivityBody') }} />
  )
}
