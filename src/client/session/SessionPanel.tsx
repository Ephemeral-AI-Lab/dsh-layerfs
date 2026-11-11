/**
 * The per-session LayerFS panel (right sidebar tab): where this session's
 * project files are (branch, Workspace mount, scratch folder), what is unsaved,
 * the trajectory checkpoints with their changes, and restore / branch actions.
 * A session outside a LayerFS workspace offers to start one.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, RiskConfirmation, StateDot, Tag, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { CommitDiff } from '../files/index.ts'
import css from './session.module.css'

type Translate = (key: string, params?: Record<string, string | number>) => string

interface Checkpoint {
  kind: 'base' | 'turn' | 'manual' | 'restore' | 'idle'
  turn: number
  seq: number
  endSeq?: number
  commit: string | null
  branch: string | null
  changed: number
  message: string
  at: number
  error?: { code: string, message: string }
}

interface Binding {
  sessionId: string
  kind: 'project' | 'scratch' | 'shared'
  project?: string
  branch?: string
  sandbox?: string
  mount?: string
  scratch: string
  anchor: string
  state: 'bound' | 'closed' | 'failed'
  error?: string
  from?: { session?: string, commit?: string | null, turn?: number }
}

interface SessionView {
  sessionId: string
  binding: Binding | null
  checkpoints: Checkpoint[]
  project: string | null
  status: { overlay?: { entries?: number }, error?: { message: string } } | null
  sessionStore: 'layerfs' | 'local'
  mirror: { count: number, error?: string, updatedAt: number } | null
}

export interface SessionPanelProps {
  sessionId: string
  api: LayerfsApi
  t: Translate
}

const short = (id: string | null | undefined) => (id ? id.slice(0, 10) : '—')

function ago(at: number, now: number, t: Translate): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return t('justNow')
  if (s < 3600) return t('minutesAgo', { n: Math.round(s / 60) })
  if (s < 86400) return t('hoursAgo', { n: Math.round(s / 3600) })
  return t('daysAgo', { n: Math.round(s / 86400) })
}

function kindLabel(c: Checkpoint, t: Translate): string {
  switch (c.kind) {
    case 'base': return t('kindBase')
    case 'turn': return t('kindTurn', { n: c.turn })
    case 'manual': return t('kindManual')
    case 'restore': return t('kindRestore')
    default: return t('kindIdle')
  }
}

function useSessionView(api: LayerfsApi, sessionId: string) {
  const [view, setView] = useState<SessionView | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])
  useEffect(() => {
    let live = true
    api.op<SessionView>('session.state', { sessionId }).then((v) => { if (live) { setView(v); setError(null) } }, (e) => { if (live) setError(e) })
    return () => { live = false }
  }, [api, sessionId, tick])
  useEffect(() => {
    const mine = (e: { data?: any }) => { if (!e.data?.sessionId || e.data.sessionId === sessionId) reload() }
    const offs = [api.onEvent('layerfs-session', mine), api.onEvent('layerfs-checkpoint', mine), api.onEvent('connection', reload)]
    // Unsaved-change counts move while the agent works; refresh quietly.
    const timer = setInterval(reload, 5000)
    return () => { offs.forEach((off) => off()); clearInterval(timer) }
  }, [api, sessionId, reload])
  return { view, error, reload }
}

function Field({ label, children, hint }: { label: string, children: ReactNode, hint?: string }): ReactNode {
  return (
    <div className={css.field}>
      <div className={css.fieldLabel}>{label}</div>
      <div className={css.fieldValue}>{children}</div>
      {hint ? <div className={css.fieldHint}>{hint}</div> : null}
    </div>
  )
}

function Path({ path }: { path: string }): ReactNode {
  return <code className={css.path} title={path}>{path}</code>
}

function StartSession({ api, t }: { api: LayerfsApi, t: Translate }): ReactNode {
  const [projects, setProjects] = useState<{ key: string, name?: string, store?: string }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.call<any[]>('GET', '/api/projects').then((rows) => { if (live) setProjects(Array.isArray(rows) ? rows : []) }, () => { if (live) setProjects([]) })
    return () => { live = false }
  }, [api])
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMessage(null)
    try { await fn() } catch (e: any) { setMessage(String(e?.message ?? e)) } finally { setBusy(false) }
  }
  return (
    <div className={css.empty}>
      <div className={css.emptyTitle}>{t('notLayerfsTitle')}</div>
      <p className={css.emptyBody}>{t('notLayerfsBody')}</p>
      <div className={css.sectionLabel}>{t('chooseProject')}</div>
      {projects === null ? <div className={css.muted}>{t('loading')}</div>
        : projects.length === 0 ? (
          <div className={css.stack}>
            <div className={css.muted}>{t('noProjects')}</div>
            <Button variant="outline" size="sm" onClick={() => api.openPanel('layerfs-storage')}>{t('openStoragePage')}</Button>
          </div>
        ) : (
          <ul className={css.projectList}>
            {projects.map((p) => (
              <li key={p.key}>
                <button type="button" className={css.projectRow} disabled={busy} onClick={() => run(() => api.op('sessions.create', { project: p.key }))}>
                  <span className={css.projectName}>{p.name ?? p.key.split('/')[1]}</span>
                  <span className={css.projectStore}>{p.store ?? p.key.split('/')[0]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      <div className={css.actions}>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => api.op('sessions.prepareScratch'))}>{t('startScratch')}</Button>
      </div>
      {message ? <div className={css.error}>{message}</div> : null}
    </div>
  )
}

export function SessionPanel({ sessionId, api, t }: SessionPanelProps): ReactNode {
  const { view, error, reload } = useSessionView(api, sessionId)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<Checkpoint | null>(null)
  const [ack, setAck] = useState(false)
  const now = Date.now()

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setMessage(null)
    try { await fn(); reload() } catch (e: any) { setMessage(t('actionFailed', { message: String(e?.message ?? e) })) } finally { setBusy(null) }
  }

  const saved = useMemo(() => (view?.checkpoints ?? []).filter((c) => c.commit || c.error).slice().reverse(), [view])

  if (!view && !error) return <div className={css.pad}><div className={css.muted}>{t('loading')}</div></div>
  if (error && !view) {
    return (
      <div className={css.pad}>
        <div className={css.error}>{String((error as any)?.message ?? error)}</div>
        <Button variant="outline" size="sm" onClick={reload}>{t('retry')}</Button>
      </div>
    )
  }
  const b = view!.binding
  if (!b) return <div className={css.pad}><StartSession api={api} t={t} /></div>

  if (b.kind === 'scratch') {
    return (
      <div className={css.pad}>
        <div className={css.head}>
          <StateDot state="idle" />
          <span className={css.headTitle}>{t('scratchTitle')}</span>
        </div>
        <p className={css.emptyBody}>{t('scratchBody')}</p>
        <Field label={t('scratch')} hint={t('scratchHint')}><Path path={b.scratch} /></Field>
      </div>
    )
  }

  const dot: StateDotState = b.state === 'bound' ? 'done' : b.state === 'failed' ? 'error' : 'idle'
  const pending = Number(view!.status?.overlay?.entries ?? 0)
  const store = view!.sessionStore === 'local'
    ? t('storeLocal')
    : view!.mirror?.error ? t('storeError', { message: view!.mirror.error }) : view!.mirror ? t('storeLayerfs') : t('storeLayerfsPending')

  return (
    <div className={css.pad}>
      <div className={css.head}>
        <StateDot state={dot} />
        <span className={css.headTitle}>{b.project}</span>
        <Tag tone={b.state === 'bound' ? 'success' : b.state === 'failed' ? 'danger' : 'neutral'}>
          {t(b.state === 'bound' ? 'stateBound' : b.state === 'failed' ? 'stateFailed' : 'stateClosed')}
        </Tag>
      </div>
      {b.error ? <div className={css.error}>{b.error}</div> : null}
      {b.from ? <div className={css.muted}>{b.from.turn ? t('forkedFrom', { n: b.from.turn }) : t('forkedFromStart')}</div> : null}

      <div className={css.card}>
        <Field label={t('branch')}><code className={css.path}>{b.branch}</code></Field>
        {b.mount ? <Field label={t('workingDirectory')}><Path path={b.mount} /></Field> : null}
        <Field label={t('scratch')} hint={t('scratchHint')}><Path path={b.scratch} /></Field>
        <div className={css.statusRow}>
          <span className={clsx(css.muted, pending > 0 && css.warn)}>{b.state === 'bound' ? (pending > 0 ? t('pending', { n: pending }) : t('pendingNone')) : ''}</span>
          <span className={clsx(css.muted, view!.mirror?.error && css.warn)}>{store}</span>
        </div>
        <div className={css.actions}>
          <Button variant="outline" size="sm" disabled={b.state !== 'bound' || busy !== null} onClick={() => act('cp', () => api.op('checkpoints.create', { sessionId: b.sessionId, message: 'Manual checkpoint' }))}>{t('checkpointNow')}</Button>
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => api.openPanel('layerfs-storage')}>{t('openStorage')}</Button>
          {b.state === 'bound' ? <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => act('close', () => api.op('sessions.close', { sessionId: b.sessionId }))}>{t('closeSandbox')}</Button> : null}
        </div>
      </div>
      {message ? <div className={css.error}>{message}</div> : null}

      <div className={css.sectionLabel}>{t('checkpoints')}</div>
      {saved.length === 0 ? <div className={css.muted}>{t('checkpointsEmpty')}</div> : (
        <ol className={css.timeline}>
          {saved.map((c, i) => {
            const key = `${c.kind}:${c.turn}:${c.commit ?? c.at}`
            const previous = saved.slice(i + 1).find((p) => p.commit)
            const expanded = open === key
            return (
              <li key={key} className={css.point}>
                <div className={css.pointHead}>
                  <span className={clsx(css.marker, c.kind === 'base' && css.markerBase, c.error && css.markerError)} aria-hidden />
                  <span className={css.pointTitle}>{kindLabel(c, t)}</span>
                  <span className={css.muted}>{ago(c.at, now, t)}</span>
                  <code className={css.commit}>{short(c.commit)}</code>
                </div>
                {c.error ? <div className={css.error}>{t('failedSave', { message: c.error.message })}</div>
                  : <div className={css.pointMeta}>{c.message}</div>}
                {c.commit ? (
                  <div className={css.pointActions}>
                    {c.kind !== 'base' && c.branch ? (
                      <Button variant="ghost" size="sm" onClick={() => setOpen(expanded ? null : key)}>{expanded ? t('hideChanges') : t('viewChanges')}</Button>
                    ) : null}
                    <Button variant="ghost" size="sm" disabled={busy !== null || b.state === 'failed'} onClick={() => { setAck(false); setRestoring(c) }}>{t('restore')}</Button>
                    {c.kind === 'turn' || c.kind === 'base' ? (
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => act(`branch:${key}`, () => api.op('checkpoints.branch', { sessionId: b.sessionId, commit: c.commit, turn: c.turn }))}>{t('branchHere')}</Button>
                    ) : null}
                  </div>
                ) : null}
                {expanded && c.commit && c.branch ? (
                  <div className={css.diff}>
                    <CommitDiff api={api} project={b.project!} branch={c.branch} commit={c.commit} from={previous?.commit ?? undefined} t={t} />
                  </div>
                ) : null}
              </li>
            )
          })}
        </ol>
      )}

      <RiskConfirmation
        open={restoring !== null}
        title={t('restoreTitle')}
        description={t('restoreDescription')}
        acknowledgeLabel={t('restoreAck')}
        cancelLabel={t('cancel')}
        closeLabel={t('close')}
        confirmLabel={t('restoreConfirm')}
        acknowledged={ack}
        disabled={busy !== null}
        onAcknowledgedChange={setAck}
        onCancel={() => setRestoring(null)}
        onConfirm={() => {
          const target = restoring
          setRestoring(null)
          if (target?.commit) void act('restore', () => api.op('checkpoints.restore', { sessionId: b.sessionId, commit: target.commit }))
        }}
      />
    </div>
  )
}
