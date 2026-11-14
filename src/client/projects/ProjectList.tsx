/**
 * The sidebar's LayerFS project list (docs/specs/layerfs-workspaces.md §4):
 * projects with sessions on this DSH, newest first. A row has the LayerFS mark
 * and the name, no status light (a few words when it can't run), folds its
 * sessions out, and on hover shows ⚙ (the project dialog) and + (new session;
 * Start while its machine is stopped). Also the project data the dialog's
 * picker reads (`useProjectData`, `useRecent`).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconPlusOutlineRegular, IconSettingsOutlineRegular, IconTriangleRightFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { listProjects, type ProjectRow } from '../picker/NewProjectForm.tsx'
import { useQuery } from '../files/use-query.ts'
import { useHostEvents } from '../storage/hooks.ts'
import type { StorageView, StoreRow } from '../storage/types.ts'
import { projectAvailability, type ProjectAvailability } from './availability.ts'
import { EVENT_COALESCE_MS, SIDEBAR_POLL_MS, useProjectMachines, useProjectSessions } from './hooks.ts'
import type { ListT } from './list-locale.ts'
import css from './list.module.css'
import { openMachineHome } from './navigation.ts'
import { projectDialog } from './dialog.ts'
import { ReadDeadlineError, readWithDeadline, steadyRead } from './read-deadline.ts'
import { sidebarStatus } from './readiness.ts'
import { sidebarHidden, sidebarProjects, type RecentProject } from './recent.ts'
import { visibleProjectSessions } from './session-visibility.ts'
import { primaryMachine, runsOn } from './setup/model.ts'

interface SessionSummary { title?: string, blank?: boolean }
/** DSH's session summaries (`sessions.list`), for live titles and unused drafts. */
export interface SessionSource { getSnapshot(): { byId: Record<string, SessionSummary> }, subscribe(fn: () => void): () => void }

const EMPTY = { byId: {} as Record<string, SessionSummary> }
const NO_SOURCE: SessionSource = { getSnapshot: () => EMPTY, subscribe: () => () => {} }

const enc = encodeURIComponent
const nameOf = (p: ProjectRow) => p.name ?? p.key.split('/')[1] ?? p.key
const storeOf = (p: ProjectRow) => p.store ?? p.key.split('/')[0] ?? ''
const idOf = (p: ProjectRow) => p.projectId ?? p.key
const errorMessage = (error: unknown, t: ListT) => error instanceof ReadDeadlineError ? t('timedOut') : String((error as Error).message ?? error)

/**
 * The row's one leading slot, as in DSH's own Workspaces list: the LayerFS mark at
 * rest, the fold arrow while the row is hovered or focused (right closed, down open).
 */
function LeadingSlot({ open }: { open: boolean }): ReactNode {
  return <span className={css.slot} aria-hidden="true">
    <span className={css.mark}><LayerfsGlyph size={16} /></span>
    <span className={css.fold}><IconTriangleRightFillRegular size={12} className={clsx(css.arrow, open && css.arrowOpen)} /></span>
  </span>
}

function useSummaries(sessionSource?: SessionSource) {
  const source = sessionSource ?? NO_SOURCE
  return useSyncExternalStore(source.subscribe.bind(source), source.getSnapshot.bind(source))
}

/**
 * A read kept on screen while a refresh runs, reloaded on `events` (coalesced) and by
 * the slow poll while visible. The sidebar shows it on every page, so each poll costs
 * every open tab a catalog, Store and machine read (Quarry v2 FIX-LOG F22).
 */
function useSteady<T>(api: LayerfsApi, load: () => Promise<T>, events: readonly string[]) {
  const last = useRef<{ value: T, failures: number } | null>(null)
  const read = useQuery(() => steadyRead(last, () => readWithDeadline(load())), [api])
  useHostEvents(api, events, read.reload, { coalesceMs: EVENT_COALESCE_MS })
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') read.reload() }, SIDEBAR_POLL_MS)
    return () => clearInterval(timer)
  }, [read.reload])
  return read
}

/** One project with its Store, where it runs and whether it can run now. */
export interface ProjectItem { row: ProjectRow, store: StoreRow | undefined, runsOn: string[], availability: ProjectAvailability }

/** Catalog, machines and Stores, joined per project (§8: readiness follows the machine it runs on). */
export function useProjectData(api: LayerfsApi) {
  const machines = useProjectMachines(api)
  const catalog = useSteady(api, () => listProjects(api), ['storage', 'layerfs-availability', 'layerfs-workspaces-changed', 'machine-progress', 'connection'])
  const storage = useSteady(api, () => api.call<StorageView>('GET', '/api/storage'), ['storage', 'storage-job', 'machine-progress', 'connection'])
  const item = (row: ProjectRow): ProjectItem => {
    const store = storage.data?.stores.find((s) => s.name === storeOf(row))
    const machine = primaryMachine(store) ?? row.machine ?? null
    return { row, store, runsOn: store ? runsOn(store) : row.machine ? [row.machine] : [], availability: projectAvailability({ ...row, machine }, machines.data, machines.error) }
  }
  return {
    catalog, item,
    /** A machine's platform (docker, lima, …) for its mark. */
    platformOf: (machine: string) => storage.data?.machines.find((m) => m.name === machine)?.platform ?? machine,
    liveStores: storage.data ? new Set(storage.data.stores.map((x) => x.name)) : undefined,
    scratchKey: catalog.data?.scratchKey ?? null,
    reload: () => { catalog.reload(); storage.reload(); machines.reload() },
  }
}

export function useRecent(api: LayerfsApi) {
  return useSteady(api, () => api.op<{ projects: RecentProject[] }>('projects.recent'), ['layerfs-session', 'layerfs-workspaces-changed', 'connection'])
}

/** Start a project's machine, or open a session in it. */
function useActions(api: LayerfsApi, onDone: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ kind: 'open' | 'start', message: string } | null>(null)
  const go = async (kind: 'open' | 'start', work: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await work(); onDone() } catch (e) { setError({ kind, message: String((e as Error).message ?? e) }) } finally { setBusy(false) }
  }
  return {
    busy, error,
    create: (p: ProjectRow) => go('open', () => api.openProjectSession(p.key, undefined, p.projectId)),
    start: (machine: string) => go('start', () => api.call('POST', `/api/machines/${enc(machine)}/start`)),
  }
}

function ActionError({ api, t, error }: { api: LayerfsApi, t: ListT, error: { kind: 'open' | 'start', message: string } | null }): ReactNode {
  if (!error) return null
  return <div className={clsx(css.notice, css.error)}>
    <span role="alert">{t(error.kind === 'start' ? 'startFailed' : 'actionFailed')}</span>
    <Button variant="ghost" size="sm" onClick={() => openMachineHome(api, null)}>{t('machines')}</Button>
    <details><summary>{t('details')}</summary><div className={css.errorDetails}>{error.message}</div></details>
  </div>
}

/** One sidebar row (§4). */
function SidebarRow({ item, showStore, api, titles, t, onChanged }: { item: ProjectItem, showStore: boolean, api: LayerfsApi, titles: Record<string, SessionSummary>, t: ListT, onChanged: () => void }): ReactNode {
  const { row: project, availability } = item
  const [open, setOpen] = useState(false)
  const actions = useActions(api, onChanged)
  // A name two listed projects share carries its Store, on screen and in every accessible name.
  const label = showStore ? `${nameOf(project)} · ${storeOf(project)}` : nameOf(project)
  const read = useProjectSessions(api, project.key, open, project.projectId)
  const selected = api.selectedSessionId()
  const sessions = visibleProjectSessions(read.sessions, titles, selected)
  const status = sidebarStatus(project, availability)
  const resume = (sessionId: string) => { void api.op('sessions.open', { sessionId, project: project.key }).catch(() => {}) }
  const where = item.runsOn.join(', ')
  return <li data-layerfs-project={idOf(project)} data-ready={availability.canRun || undefined} className={css.projectItem}>
    <div className={clsx(css.projectRow, !availability.canRun && css.inactive)} data-open={open || undefined} data-actions={availability.canStart ? 1 : 2}>
      <button className={css.projectToggle} type="button"
        title={`${nameOf(project)} · ${storeOf(project)}${where ? ` · ${where}` : ''}`} aria-expanded={open} aria-label={t('expandProject', { project: label })} onClick={() => setOpen(!open)}>
        <LeadingSlot open={open} />
        <span className={css.title}>{nameOf(project)}{showStore ? <span className={css.store}> · {storeOf(project)}</span> : null}</span>
        {!availability.canRun && availability.state !== 'checking' ? <span className={css.why}>{t(status.key)}</span> : null}
      </button>
      <span className={css.rowActions}>
        <Button className={css.iconButton} variant="ghost" size="sm" icon={<IconSettingsOutlineRegular size={14} />} aria-label={t('configure', { project: label })} title={t('configure', { project: label })}
          onClick={() => projectDialog.open({ mode: 'configure', project: { key: project.key, projectId: project.projectId, name: nameOf(project), store: storeOf(project) } })} />
        {availability.canStart ? null : <Button className={css.iconButton} variant="ghost" size="sm" disabled={actions.busy || !availability.canRun} icon={<IconPlusOutlineRegular size={14} />}
          aria-label={t('newSession', { project: label })} title={availability.canRun ? t('newSession', { project: label }) : t('cannotRun', { reason: t(status.key) })}
          onClick={() => { setOpen(true); void actions.create(project) }} />}
        {availability.canStart
          ? <Button className={css.start} variant="ghost" size="sm" disabled={actions.busy} aria-label={t('startMachineFor', { machine: availability.machine ?? '', project: label })} onClick={() => void actions.start(availability.machine!)}>{t('start')}</Button>
          : null}
      </span>
    </div>
    <ActionError api={api} t={t} error={actions.error} />
    {open ? <ul className={css.sessions}>
      {read.error ? <li className={css.notice}>
        <span role="alert">{t('archiveFailed', { message: errorMessage(read.error, t) })}</span>
        <Button variant="ghost" size="sm" onClick={read.reload}>{t('retry')}</Button>
      </li> : read.loading ? <li className={css.notice}>{t('archiveLoading')}</li> : null}
      {sessions.length ? sessions.map((session) => <li key={session.sessionId}>
        <button type="button" className={css.session} data-selected={selected === session.sessionId || undefined} onClick={() => resume(session.sessionId)}>
          <span className={css.slot} aria-hidden="true" />
          <span className={css.title}>{titles[session.sessionId]?.title || session.title || t('untitled')}</span>
          {session.executionState === 'interrupted' ? <span className={css.interrupted} title={session.error ?? t('interruptedHint')}>{t('interrupted')}</span> : null}
        </button>
      </li>) : !read.error && !read.loading ? <li className={css.notice}>{t('noSessions')}</li> : null}
    </ul> : null}
  </li>
}

/** The sidebar's projects with their Store, machine and availability, and the catalog's size. */
export function useSidebarProjects(api: LayerfsApi, sessionSource?: SessionSource) {
  const summaries = useSummaries(sessionSource)
  const hidden = useSyncExternalStore(sidebarHidden.subscribe, sidebarHidden.get)
  const data = useProjectData(api)
  const recent = useRecent(api)
  const rows = recent.data ? sidebarProjects(recent.data.projects, data.catalog.data ? data.catalog.data.rows : null, hidden, data.liveStores) : null
  // A project with sessions the catalog doesn't list yet (just created): read the catalog again.
  const missing = rows?.some((r) => !r.row.catalogState && !data.catalog.data?.rows.some((p) => p.key === r.row.key)) ?? false
  useEffect(() => { if (missing) data.catalog.reload() }, [missing, recent.data])
  return {
    items: rows?.map((r) => ({ ...data.item(r.row), showStore: r.showStore, hideKey: r.hideKey })) ?? null,
    scratchKey: data.scratchKey,
    error: recent.error,
    titles: summaries.byId,
    reload: () => { recent.reload(); data.reload() },
  }
}
export type SidebarData = ReturnType<typeof useSidebarProjects>

/** The sidebar's LayerFS list (§4): project rows. */
export function SidebarProjects({ api, t, data }: { api: LayerfsApi, t: ListT, data: SidebarData }): ReactNode {
  const { items } = data
  return <div className={css.tree}>
    {data.error && !items ? <div className={css.notice} role="alert">{t('failed', { message: errorMessage(data.error, t) })}<Button variant="ghost" size="sm" onClick={data.reload}>{t('retry')}</Button></div>
      : !items ? <div className={css.notice}>{t('loading')}</div>
        : !items.length ? <div className={css.empty}>
          <div className={css.notice}>{t('emptyRecent')}</div>
          <div className={css.emptyActions}>
            <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={14} />} onClick={() => projectDialog.open({ mode: 'new' })}>{t('newProject')}</Button>
          </div>
        </div>
          : <ul className={css.projects}>{items.map((item) => <SidebarRow key={idOf(item.row)} item={item} showStore={item.showStore} api={api} titles={data.titles} t={t} onChanged={data.reload} />)}</ul>}
  </div>
}
