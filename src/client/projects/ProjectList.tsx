/**
 * The LayerFS project tree, shown in the sidebar's LayerFS Projects section
 * and on the Projects page: every project as a compact row (`<project> ·
 * <store>`, readiness, Start or New session) whose conversations fold out
 * under it, grouped into Ready and Unavailable.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { listProjects, type ProjectRow } from '../picker/NewProjectForm.tsx'
import { useQuery } from '../files/use-query.ts'
import { useHostEvents } from '../storage/hooks.ts'
import { Card, Page, PageHead, StateChip } from '../ui/index.tsx'
import { projectAvailability, type ProjectAvailability } from './availability.ts'
import { useProjectMachines, useProjectSessions } from './hooks.ts'
import type { ListT } from './list-locale.ts'
import css from './list.module.css'
import { MachineStatus } from './MachineStatus.tsx'
import { openMachineHome, openProjectHome } from './navigation.ts'
import { ReadDeadlineError, readWithDeadline } from './read-deadline.ts'
import { sidebarStatus, splitByReadiness } from './readiness.ts'
import { visibleProjectSessions } from './session-visibility.ts'

interface SessionSummary { title?: string, blank?: boolean }
/** DSH's session summaries (`sessions.list`), for live titles and unused drafts. */
export interface SessionSource { getSnapshot(): { byId: Record<string, SessionSummary> }, subscribe(fn: () => void): () => void }

const EMPTY = { byId: {} as Record<string, SessionSummary> }
const NO_SOURCE: SessionSource = { getSnapshot: () => EMPTY, subscribe: () => () => {} }

/** A remembered fold; `fallback` applies until the viewer toggles it. */
function useFold(key: string, fallback = true): [boolean, () => void] {
  const [stored, setStored] = useState<boolean | null>(() => { try { const v = localStorage.getItem(key); return v === null ? null : v !== '0' } catch { return null } })
  const open = stored ?? fallback
  return [open, () => setStored(() => { try { localStorage.setItem(key, open ? '0' : '1') } catch {} return !open })]
}

const enc = encodeURIComponent

function Chevron({ open }: { open: boolean }): ReactNode {
  return <IconChevronDownOutlineRegular size={12} className={clsx(css.chevron, open && css.openChevron)} />
}

const errorMessage = (error: unknown, t: ListT) => error instanceof ReadDeadlineError ? t('timedOut') : String((error as Error).message ?? error)

function Project({ project, api, titles, t, availability, onStarted }: { project: ProjectRow, api: LayerfsApi, titles: Record<string, SessionSummary>, t: ListT, availability: ProjectAvailability, onStarted: () => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState<'open' | 'start'>('open')
  const [busy, setBusy] = useState(false)
  const label = `${project.name ?? project.key.split('/')[1]} · ${project.store ?? project.key.split('/')[0]}`
  const read = useProjectSessions(api, project.key, open, project.projectId)
  const sessions = visibleProjectSessions(read.sessions, titles)
  const create = async () => {
    setBusy(true); setError(null)
    try { await api.openProjectSession(project.key, undefined, project.projectId); setOpen(true); read.reload() }
    catch (e) { setFailed('open'); setError(String((e as Error).message ?? e)) }
    finally { setBusy(false) }
  }
  const start = async () => {
    setBusy(true); setError(null)
    try { await api.call('POST', `/api/machines/${enc(availability.machine!)}/start`); onStarted() }
    catch (e) { setFailed('start'); setError(String((e as Error).message ?? e)) }
    finally { setBusy(false) }
  }
  const resume = async (sessionId: string) => {
    setError(null)
    try { await api.op('sessions.open', { sessionId, project: project.key }) }
    catch (e) { setFailed('open'); setError(String((e as Error).message ?? e)) }
  }
  const status = sidebarStatus(project, availability)
  return <li data-layerfs-project={project.projectId ?? project.key} data-ready={availability.canRun || undefined}>
    <div className={css.line}>
      <button className={css.foldProject} type="button" aria-expanded={open} aria-label={t('expandProject', { project: label })} onClick={() => setOpen(!open)}><Chevron open={open} /></button>
      <button className={clsx(css.projectLink, !availability.canRun && css.inactive)} type="button" title={label} onClick={() => openProjectHome(api, project.projectId ?? project.key)}>
        <IconFolderOpenOutlineRegular size={16} /><span className={css.projectText}><span className={css.label}>{label}</span>
          {availability.canRun ? <MachineStatus value={availability} t={t} /> : <StateChip tone={status.tone} label={t(status.key)} live={status.live} title={availability.reason ?? project.catalogError ?? undefined} />}</span>
      </button>
      {availability.canStart
        ? <Button className={css.action} variant="ghost" size="sm" disabled={busy} aria-label={t('startMachineFor', { machine: availability.machine ?? '', project: label })} onClick={() => void start()}>{t('start')}</Button>
        : <Button className={css.action} variant="ghost" size="sm" disabled={busy || !availability.canRun} icon={<IconPlusOutlineRegular size={14} />} aria-label={t('newSession', { project: label })} onClick={() => void create()} />}
    </div>
    {error ? <div className={clsx(css.notice, css.error)}>
      <span role="alert">{t(failed === 'start' ? 'startFailed' : 'actionFailed')}</span>
      <Button variant="ghost" size="sm" onClick={() => openMachineHome(api, null)}>{t('machines')}</Button>
      <details><summary>{t('details')}</summary><div className={css.errorDetails}>{error}</div></details>
    </div> : null}
    {open ? <ul className={css.sessions}>
      {read.error ? <li className={css.notice}>
        <span role="alert">{t('archiveFailed', { message: errorMessage(read.error, t) })}</span>
        <Button variant="ghost" size="sm" onClick={read.reload}>{t('retry')}</Button>
      </li> : read.loading ? <li className={css.notice}>{t('archiveLoading')}</li> : null}
      {sessions.length ? sessions.map((session) => <li key={session.sessionId}>
        <button type="button" className={css.session} data-selected={api.selectedSessionId() === session.sessionId || undefined} onClick={() => void resume(session.sessionId)}>
          <span className={css.label}>{titles[session.sessionId]?.title || session.title || t('untitled')}</span>
          {session.executionState === 'interrupted' ? <span className={css.interrupted} title={session.error ?? t('interruptedHint')}>{t('interrupted')}</span> : null}
        </button>
      </li>) : !read.error && !read.loading ? <li className={css.notice}>{t('noSessions')}</li> : null}
    </ul> : null}
  </li>
}

/** One readiness group. Unavailable starts folded while any project is ready; Ready starts open. */
function Bucket({ storageKey, fallback, label, children }: { storageKey: string, fallback: boolean, label: string, children: ReactNode }): ReactNode {
  const [open, toggle] = useFold(storageKey, fallback)
  return <>
    <button className={css.bucket} type="button" aria-expanded={open} onClick={toggle}><Chevron open={open} /><span className={css.label}>{label}</span></button>
    {open ? children : null}
  </>
}

/** The project tree: Ready and Unavailable groups of project rows. `compact` is the sidebar's variant. */
export function ProjectTree({ api, t, sessionSource, compact }: { api: LayerfsApi, t: ListT, sessionSource?: SessionSource | undefined, compact?: boolean }): ReactNode {
  const source = sessionSource ?? NO_SOURCE
  const summaries = useSyncExternalStore(source.subscribe.bind(source), source.getSnapshot.bind(source))
  const machines = useProjectMachines(api)
  const read = useQuery(() => readWithDeadline(listProjects(api)), [api])
  useHostEvents(api, ['storage', 'layerfs-availability', 'layerfs-workspaces-changed', 'machine-progress', 'connection'], read.reload)
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') read.reload() }, 15_000)
    return () => clearInterval(timer)
  }, [read.reload])

  const projects = read.data?.rows.filter((p) => p.key !== read.data?.scratchKey) ?? []
  // Bucket by the observed availability itself (not the reload-masked one) so rows do not jump during refreshes.
  const rated = projects.map((project) => ({ project, availability: projectAvailability(project, machines.data, machines.error) }))
  const { ready, inactive } = splitByReadiness(rated, !!machines.data || !!machines.error)
  const row = ({ project, availability }: typeof rated[number]) => <Project key={project.projectId ?? project.key} project={project} api={api} titles={summaries.byId} t={t}
    availability={{ ...availability, canRun: !machines.loading && availability.canRun }} onStarted={() => { machines.reload(); read.reload() }} />
  const prefix = compact ? 'dsh-layerfs:sidebar-projects' : 'dsh-layerfs:projects'
  return <div className={clsx(css.tree, compact && css.compact)}>
    {read.error ? <div className={css.notice} role="alert">{t('failed', { message: errorMessage(read.error, t) })}<Button variant="ghost" size="sm" onClick={read.reload}>{t('retry')}</Button></div>
      : !read.data ? <div className={css.notice}>{t('loading')}</div>
        : !projects.length ? <div className={css.notice}>{t('empty')}</div>
          : !inactive.length ? <ul className={css.projects}>{ready.map(row)}</ul>
            : <>
              {ready.length ? <Bucket storageKey={`${prefix}-ready`} fallback label={t('readyGroup', { n: ready.length })}>
                <ul className={css.projects}>{ready.map(row)}</ul>
              </Bucket> : null}
              <Bucket storageKey={`${prefix}-unavailable`} fallback={!ready.length} label={t('unavailableGroup', { n: inactive.length })}>
                <ul className={css.projects}>{inactive.map(row)}</ul>
              </Bucket>
            </>}
  </div>
}

/** The Projects page: the same tree in a card, opened from the sidebar section's manage button. */
export function ProjectList({ api, t, sessionSource }: { api: LayerfsApi, t: ListT, sessionSource?: SessionSource | undefined }): ReactNode {
  return <Page label={t('layerfs')}>
    <PageHead title={t('layerfs')}
      actions={<Button variant="outline" size="sm" onClick={() => api.openPanel('layerfs-storage')}>{t('openStorage')}</Button>} />
    <Card className={css.card}><ProjectTree api={api} t={t} sessionSource={sessionSource} /></Card>
  </Page>
}
