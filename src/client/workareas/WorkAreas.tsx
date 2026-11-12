import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Button, IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { listProjects, type ProjectRow } from '../picker/NewProjectForm.tsx'
import { useQuery } from '../files/use-query.ts'
import { ReadDeadlineError, readWithDeadline } from '../projects/read-deadline.ts'
import { useHostEvents } from '../storage/hooks.ts'
import type { Translate } from './locale.ts'
import css from './workareas.module.css'
import { projectAvailability, type ProjectAvailability } from '../projects/availability.ts'
import { useProjectMachines, useProjectSessions } from '../projects/hooks.ts'
import { MachineStatus } from '../projects/MachineStatus.tsx'
import { openProjectHome } from '../projects/navigation.ts'
import { visibleProjectSessions } from './session-visibility.ts'

interface Workspace { workspaceId: string, path: string }
interface WorkspaceSource { getSnapshot(): { items: Workspace[] }, subscribe(fn: () => void): () => void }
interface Session { sessionId: string, title: string | null }
interface SessionSummary { title?: string, blank?: boolean }
interface SessionSource { getSnapshot(): { byId: Record<string, SessionSummary> }, subscribe(fn: () => void): () => void }

function useFold(key: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) !== '0' } catch { return true } })
  return [open, () => setOpen((value) => { try { localStorage.setItem(key, value ? '0' : '1') } catch {} return !value })]
}

function Chevron({ open }: { open: boolean }): ReactNode {
  return <IconChevronDownOutlineRegular size={12} className={clsx(css.chevron, open && css.openChevron)} />
}

const errorMessage = (error: unknown, t: Translate) => error instanceof ReadDeadlineError ? t('timedOut') : String((error as Error).message ?? error)

function Project({ project, api, titles, t, availability }: { project: ProjectRow, api: LayerfsApi, titles: Record<string, SessionSummary>, t: Translate, availability: ProjectAvailability }): ReactNode {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const label = `${project.name ?? project.key.split('/')[1]} · ${project.store ?? project.key.split('/')[0]}`
  const read = useProjectSessions(api, project.key, open, project.projectId)
  const sessions = visibleProjectSessions(read.sessions, titles)
  const create = async () => {
    setBusy(true); setError(null)
    try { await api.openProjectSession(project.key, undefined, project.projectId); setOpen(true); read.reload() }
    catch (e) { setError(String((e as Error).message ?? e)) }
    finally { setBusy(false) }
  }
  const resume = async (sessionId: string) => {
    setError(null)
    try { await api.op('sessions.open', { sessionId, project: project.key }) }
    catch (e) { setError(String((e as Error).message ?? e)) }
  }
  return <li data-layerfs-project={project.projectId ?? project.key}>
    <div className={css.line}>
      <button className={css.foldProject} type="button" aria-expanded={open} aria-label={t('expandProject', { project: label })} onClick={() => setOpen(!open)}><Chevron open={open} /></button>
      <button className={css.projectLink} type="button" title={label} onClick={() => openProjectHome(api, project.projectId ?? project.key)}>
        <IconFolderOpenOutlineRegular size={16} /><span className={css.projectText}><span className={css.label}>{label}</span><MachineStatus value={availability} t={t} /></span>
      </button>
      <Button className={css.action} variant="ghost" size="sm" disabled={busy || !availability.canRun} icon={<IconPlusOutlineRegular size={14} />} aria-label={t('newSession', { project: label })} onClick={() => void create()} />
    </div>
    {error ? <div className={clsx(css.notice, css.error)}>
      <span role="alert">{t('actionFailed')}</span>
      <Button variant="ghost" size="sm" onClick={() => api.openPanel('layerfs-machines')}>{t('machines')}</Button>
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
        </button>
      </li>) : !read.error && !read.loading ? <li className={css.notice}>{t('noSessions')}</li> : null}
    </ul> : null}
  </li>
}

/** The native workspace browser remains mounted, including its menus and search.
 * Only our portal host and exact presentation markers are added to its public
 * slot anchor; native React nodes are never moved or replaced. */
export function WorkAreas({ wide, api, source, sessionSource, t }: { wide: boolean, api: LayerfsApi, source: WorkspaceSource, sessionSource: SessionSource, t: Translate }): ReactNode {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const [layerfsOpen, toggleLayerfs] = useFold('dsh-layerfs:workareas-layerfs')
  const [dshOpen, toggleDsh] = useFold('dsh-layerfs:workareas-dsh')
  const workspaces = useSyncExternalStore(source.subscribe.bind(source), source.getSnapshot.bind(source))
  const summaries = useSyncExternalStore(sessionSource.subscribe.bind(sessionSource), sessionSource.getSnapshot.bind(sessionSource))
  const machines = useProjectMachines(api)
  const runtime = useQuery(() => api.op<{ root: string }>('runtime.status'), [api])
  const read = useQuery(() => readWithDeadline(listProjects(api)), [api])
  useHostEvents(api, ['storage', 'layerfs-workspaces-changed', 'machine-progress', 'connection'], read.reload)
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') read.reload() }, 15_000)
    return () => clearInterval(timer)
  }, [read.reload])
  const current = useRef({ workspaces, runtime: runtime.data, dshOpen, t })
  current.current = { workspaces, runtime: runtime.data, dshOpen, t }
  const refresh = useRef<(() => void) | undefined>(undefined)
  useEffect(() => { refresh.current?.() }, [workspaces.items, runtime.data?.root, dshOpen, t])

  useEffect(() => {
    if (!wide) { setTarget(null); return }
    let host: HTMLElement | undefined
    let area: HTMLElement | undefined
    let frame = 0
    const marked = new Set<HTMLElement>()
    const labels = new Map<HTMLElement, string>()
    const scan = () => {
      const { workspaces, runtime, dshOpen, t } = current.current
      const legacy = new Set(workspaces.items.filter((w) => runtime && (w.path === `${runtime.root}/projects` || w.path.startsWith(`${runtime.root}/projects/`))).map((w) => `workspace:${w.workspaceId}`))
      const anchor = document.querySelector('[data-slot="sidebar.workspaces"]')
      // Released DSH builds predate the named data markers. Keep the fallback
      // scoped to the public slot and its semantic CSS-module class suffix.
      const found = anchor?.querySelector<HTMLElement>('[data-sidebar-list-area], [class*="_listArea"]')
      if (!found) return
      if (area !== found || !host?.isConnected) {
        host?.remove()
        area?.removeAttribute('data-layerfs-work-areas'); area?.removeAttribute('data-dsh-folded')
        area = found
        host = document.createElement('div'); host.dataset.layerfsWorkspaceMount = ''
        area.prepend(host); setTarget(host)
      }
      if (area.firstElementChild !== host) area.prepend(host!)
      area.setAttribute('data-layerfs-work-areas', '')
      area.toggleAttribute('data-dsh-folded', !dshOpen)
      const label = anchor?.querySelector<HTMLElement>('[data-sidebar-workspace-header] > span, [class*="_sectionHeader"] > [class*="_sectionLabel"]')
      if (label) {
        if (!labels.has(label)) labels.set(label, label.textContent ?? '')
        if (label.textContent !== t('title')) label.textContent = t('title')
      }
      for (const row of area.querySelectorAll<HTMLElement>('[data-row-key]')) {
        if (!legacy.has(row.dataset.rowKey ?? '')) continue
        const group = row.closest<HTMLElement>('[style*="--dsh-workspace-indent"]')
        if (group && !group.hasAttribute('data-layerfs-legacy-workspace')) { group.setAttribute('data-layerfs-legacy-workspace', ''); marked.add(group) }
      }
    }
    refresh.current = scan
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; scan() }) })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    scan()
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame)
      refresh.current = undefined
      host?.remove(); area?.removeAttribute('data-layerfs-work-areas'); area?.removeAttribute('data-dsh-folded')
      for (const node of marked) node.removeAttribute('data-layerfs-legacy-workspace')
      for (const [node, original] of labels) node.textContent = original
    }
  }, [wide])

  if (!wide || !target) return null
  const projects = read.data?.rows.filter((p) => p.key !== read.data?.scratchKey) ?? []
  return createPortal(<div className={css.groups}>
    <section aria-label={t('layerfs')}>
      <div className={css.line}>
        <button className={css.toggle} type="button" aria-expanded={layerfsOpen} onClick={toggleLayerfs}><Chevron open={layerfsOpen} /><LayerfsGlyph size={16} /><span className={css.label}>{t('layerfs')}</span></button>
        <Button variant="ghost" size="sm" icon={<IconFolderOpenOutlineRegular size={14} />} aria-label={t('manage')} onClick={() => openProjectHome(api, null)} />
      </div>
      {layerfsOpen ? read.error ? <div className={css.notice} role="alert">{t('failed', { message: errorMessage(read.error, t) })}<Button variant="ghost" size="sm" onClick={read.reload}>{t('retry')}</Button></div>
        : !read.data ? <div className={css.notice}>{t('loading')}</div>
          : projects.length ? <ul className={css.projects}>{projects.map((project) => {
            const availability = projectAvailability(project, machines.data, machines.error)
            return <Project key={project.projectId ?? project.key} project={project} api={api} titles={summaries.byId} t={t} availability={{ ...availability, canRun: !machines.loading && availability.canRun }} />
          })}</ul> : <div className={css.notice}>{t('empty')}</div> : null}
    </section>
    <button className={css.toggle} type="button" aria-expanded={dshOpen} onClick={toggleDsh}><Chevron open={dshOpen} /><IconFolderOpenOutlineRegular size={16} /><span className={css.label}>{t('dsh')}</span></button>
  </div>, target)
}
