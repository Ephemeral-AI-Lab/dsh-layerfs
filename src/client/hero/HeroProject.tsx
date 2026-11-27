/**
 * The New Session row's LayerFS project control (`conversation.hero.options`):
 * shows the project the new session will work in, or "No project" for a plain
 * workspace session, and switches it — another project, a new empty project,
 * or a project imported from a host folder. Project ownership and the selected
 * local scratch folder are independent, and ownership comes from the one store
 * (`../session/ownership.ts`): a failed read is its own visible state with a
 * Retry, never a false "No project". While an import runs, the control shows its
 * progress.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular, IconCheckOutlineRegular, IconPlusOutlineRegular, IconSettingsOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { ownershipStore, useOwnership, type OwnershipEntry } from '../session/ownership.ts'
import { listProjects, messageOf, type ProjectInitJob, type ProjectRow } from '../picker/NewProjectForm.tsx'
import { keepPrefetched } from '../ui/use-query.ts'
import { ProjectDialogMount, projectDialog } from '../projects/dialog.ts'
import { runsOn } from '../projects/setup/model.ts'
import type { StorageView } from '../storage/types.ts'
import type { PickerKey } from '../picker/locale.ts'
import type { HeroKey } from './locale.ts'
import { ScratchPicker } from './ScratchPicker.tsx'
import css from './hero.module.css'

type Translate<K extends string> = (key: K, params?: Record<string, string | number>) => string

/** The import the control is following (one at a time, shared by every New Session row). */
export interface ImportState {
  readonly key: string
  readonly job: ProjectInitJob
  readonly error: string | null
}

/** A tiny external store for {@link ImportState}. */
export class Imports {
  private state: ImportState | null = null
  private readonly listeners = new Set<() => void>()
  get = (): ImportState | null => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  set(next: ImportState | null): void { this.state = next; for (const l of this.listeners) l() }
}

interface Place { projectId?: string, project: string | null, scratch?: string }

/**
 * A new session's default place that names a project the catalog lists as
 * removed (or replaced): it is not offered as the default (B2 #7); the session
 * starts with no project, and the person picks one.
 */
export function staleDefault(place: Pick<Place, 'project'> | null, rows: readonly Pick<ProjectRow, 'key' | 'catalogState'>[] | null): boolean {
  if (!place?.project || !rows) return false
  const row = rows.find((r) => r.key === place.project)
  return row?.catalogState === 'removed' || row?.catalogState === 'identity-mismatch'
}

const NONE = '@none'
const NEW = '@new'
const IMPORT = '@import'
const nameOf = (key: string) => key.split('/')[1] ?? key

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function phaseLabel(job: ProjectInitJob, t: Translate<HeroKey>): string {
  switch (job.step) {
    case 'scan': return t('phaseScan')
    case 'check': return t('phaseCheck')
    case 'send': return t('phaseSend')
    case 'install': return t('phaseInstall')
    case 'record': return t('phaseRecord')
    case 'done': return t('phaseDone')
    default: return job.step
  }
}

export interface HeroProjectProps {
  sessionId: string
  api: LayerfsApi
  t: Translate<HeroKey>
  tp: Translate<PickerKey>
  imports: Imports
}

export function HeroProject(props: HeroProjectProps): ReactNode {
  const ownership = useOwnership(props.api, props.sessionId)
  return <HeroProjectControl {...props} ownership={ownership} retry={() => ownershipStore(props.api).retry(props.sessionId)} />
}

export interface HeroProjectControlProps extends HeroProjectProps {
  /** The store's entry for this session (a test renders a fake one). */
  ownership: OwnershipEntry
  /** Read this session's place again (the Retry action). */
  retry: () => void
}

/** The control itself; exported so tests can render a fake ownership state. */
export function HeroProjectControl({ sessionId, api, t, imports, ownership, retry }: HeroProjectControlProps): ReactNode {
  const root = useRef<HTMLSpanElement>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const [rows, setRows] = useState<ProjectRow[] | null>(null)
  const [scratchKey, setScratchKey] = useState<string | null>(null)
  const [storage, setStorage] = useState<StorageView | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const running = useSyncExternalStore(imports.subscribe, imports.get)
  const [, tick] = useState(0)

  const loadProjects = () => {
    setLoadError(false)
    // The New Session surface is often mounted before Center is opened: hand its
    // two answers to Home's first render (a paint hint; Center reads on mount).
    const started = Date.now()
    listProjects(api, { share: true }).then((catalog) => {
      const { rows: list, scratchKey: key } = catalog
      setRows(list); setScratchKey(key)
      keepPrefetched('projects.catalog', catalog, started)
    }, () => setLoadError(true))
    // Where each project runs (its SQLite Store's machine, or the machine its PostgreSQL Store's sessions run on).
    api.call<StorageView>('GET', '/api/storage', undefined, { share: true }).then((view) => {
      setStorage(view)
      keepPrefetched('GET /api/storage', view, started)
    }, () => {})
  }
  useEffect(loadProjects, [api])
  // Store health and project changes reach an open picker too (it never polls).
  useEffect(() => {
    // These come in bursts during a run: read once per burst (2 s), not once per event.
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => { if (!timer) timer = setTimeout(() => { timer = undefined; loadProjects() }, 2000) }
    const offs = ['layerfs-availability', 'layerfs-workspaces-changed', 'storage'].map((type) => api.onEvent(type, later))
    return () => { offs.forEach((off) => off()); if (timer) clearTimeout(timer) }
  }, [api])

  useEffect(() => {
    if (!running || running.error) return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [running])

  // The three states, mapped onto the control: a known project (or none), and
  // an unknown read that keeps the menu but never reads as "No project".
  const failed = ownership.state === 'unknown' && ownership.error !== undefined
  const place: Place | null = ownership.state === 'notProject' ? { project: null }
    : ownership.state === 'project' && ownership.project
      ? {
          project: ownership.project,
          ...(ownership.projectId ? { projectId: ownership.projectId } : {}),
          ...(ownership.scratch ? { scratch: ownership.scratch } : {}),
        }
      : null

  /** Place this session in a LayerFS project (or back in a plain folder). */
  const switchTo = async (key: string | null) => {
    setError(null)
    setSwitching(true)
    try {
      const row = rows?.find((p) => (p.projectId ?? p.key) === key)
      await api.op('sessions.choose', { sessionId, project: row?.key ?? key, projectId: row?.projectId })
      // The host event is coalesced; the person's own choice updates at once.
      retry()
    } catch (e) {
      setError(t('switchFailed', { message: messageOf(e) }))
    } finally {
      setSwitching(false)
    }
  }

  // the composer's default never pre-selects a removed project: once per session, its place goes back to no project
  const dropped = useRef(false)
  useEffect(() => {
    if (dropped.current || switching || !staleDefault(place, rows)) return
    dropped.current = true
    void switchTo(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place, rows, switching])

  const project = !!place?.project
  useEffect(() => {
    // DSH's order in both modes, the project control right after the preset:
    // folder · preset · project (hero.module.css). Native folder selection
    // navigates to another blank, so in project mode our scratch selector takes
    // the folder chip's place: it preserves this session and changes only its
    // local folder.
    for (let row = root.current?.parentElement, depth = 0; row && depth < 6; row = row.parentElement, depth++) {
      if (!row.querySelector(':scope > [data-slot="conversation.hero.workspace"]') || !row.querySelector(':scope > button[aria-haspopup="menu"]')) continue
      const options = [...row.children].find((child) => child.contains(root.current))
      row.setAttribute('data-layerfs-hero-row', sessionId)
      options?.setAttribute('data-layerfs-hero-options', '')
      // The hero's title above the row is DSH's own, outside our slot, and has no
      // public hook: it keeps DSH's look on a phone (no walking up from the
      // brand-mark slot to restyle it).
      if (project) row.setAttribute('data-layerfs-scratch-picker', sessionId)
      return () => {
        if (row.getAttribute('data-layerfs-hero-row') === sessionId) { row.removeAttribute('data-layerfs-hero-row'); options?.removeAttribute('data-layerfs-hero-options') }
        if (row.getAttribute('data-layerfs-scratch-picker') === sessionId) row.removeAttribute('data-layerfs-scratch-picker')
      }
    }
  }, [project, sessionId])

  if (running) {
    const name = nameOf(running.key)
    const { done, total } = running.job.progress ?? { done: null, total: null }
    const share = done !== null && total ? Math.min(1, done / total) : null
    return (
      <Menu open={open} onClose={() => setOpen(false)} portal align="start"
        anchor={(
          <button ref={anchor} type="button" className={css.chip} data-state={running.error ? 'failed' : 'running'} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <LayerfsGlyph size={14} />
            <span className={css.label}>{running.error ? t('importFailed') : t('importing', { name })}</span>
            <IconChevronDownOutlineRegular size={12} aria-hidden="true" />
          </button>
        )}>
        <div className={css.progress} role="status">
          <div className={css.progressTitle}>{running.error ? t('importFailedTitle', { name }) : t('importingTitle', { name })}</div>
          {running.error ? (
            <>
              <div className={css.error}>{running.error}</div>
              <Button variant="outline" size="sm" className={css.selfStart} onClick={() => { setOpen(false); imports.set(null) }}>{t('dismiss')}</Button>
            </>
          ) : (
            <>
              <div className={css.bar} data-indeterminate={share === null ? '' : undefined}><span className={css.barFill} style={share === null ? undefined : { width: `${share * 100}%` }} /></div>
              <div className={css.muted}>{phaseLabel(running.job, t)} · {elapsed(Date.now() - running.job.started)}</div>
            </>
          )}
        </div>
      </Menu>
    )
  }

  // A failed read keeps the last known project as the menu's selection, while the
  // chip says the read failed (never "No project").
  const current = place?.projectId ?? place?.project ?? (ownership.state === 'unknown' ? ownership.projectId ?? ownership.project ?? null : null)
  const label = failed ? t('placeUnknown') : place === null ? '' : place.project ? nameOf(place.project) : t('noProject')
  const projects = (rows ?? []).filter((r) => r.key !== scratchKey && (!r.catalogState || r.catalogState === 'available'))
  const items: MenuEntry[] = [
    { id: NONE, label: t('noProject'), icon: <IconFolderOpenOutlineRegular size={14} /> },
    { type: 'separator', id: 'none' },
    ...(rows === null && !loadError ? [{ type: 'label' as const, id: 'loading', text: t('loading') }] : []),
    ...(loadError ? [{ type: 'label' as const, id: 'failed', text: t('loadFailed') }] : []),
    ...projects.map((p) => {
      const store = p.key.split('/')[0] ?? ''
      const name = p.name ?? nameOf(p.key)
      // The note says where it runs (docs/specs/layerfs-workspaces.md §5); the Store is in the tooltip.
      const where = runsOn(storage?.stores.find((s) => s.name === store))
      const note = (where.length ? where : [p.machine ?? '']).filter(Boolean).join(', ')
      const configure = t('configure', { project: name })
      const id = p.projectId ?? p.key
      const isCurrent = id === current
      return {
        id,
        icon: <LayerfsGlyph size={14} />,
        label: <span className={css.option} title={`${name} · ${store}${note ? ` · ${note}` : ''}`}>
          <span className={css.optionName}>{name}</span><span className={css.optionNote}>{note}</span>
          {/* The selected mark sits with the name, before the settings action;
              these rows are never the Menu's selectedId, so DSH draws no
              trailing check after the gear. */}
          {isCurrent ? <span className={css.optionCheck} aria-hidden="true"><IconCheckOutlineRegular size={14} /></span> : null}
          <span role="button" className={css.optionGear} aria-label={configure} title={configure} data-layerfs-configure=""
            onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); projectDialog.open({ mode: 'configure', project: { key: p.key, projectId: p.projectId, name, store } }) }}>
            <IconSettingsOutlineRegular size={13} />
          </span>
        </span>,
      }
    }),
    { type: 'separator', id: 'actions' },
    { id: NEW, label: t('newEmpty'), icon: <IconPlusOutlineRegular size={14} /> },
    { id: IMPORT, label: t('importProject'), icon: <IconFolderOpenOutlineRegular size={14} /> },
  ]
  return (
    <span ref={root} className={css.root} data-layerfs-hero="">
      {place?.project ? <span className={css.scratchSlot} data-layerfs-scratch=""><ScratchPicker sessionId={sessionId} scratch={place.scratch} api={api} t={t} /></span> : null}
      <Menu open={open && !switching} onClose={() => setOpen(false)} portal align="start" items={items} selectedId={current === null ? NONE : undefined} dense listClassName={css.projectMenu}
        onSelect={(id) => {
          setOpen(false)
          if (id === NEW) projectDialog.open({ mode: 'new' })
          else if (id === IMPORT) projectDialog.open({ mode: 'import' })
          else if (id !== (current ?? NONE)) void switchTo(id === NONE ? null : id)
        }}
        anchor={(
          <button ref={anchor} type="button" className={css.chip} data-state={failed ? 'unknown' : undefined}
            aria-label={failed ? t('placeUnknown') : t('chipAria', { project: label })} aria-haspopup="menu" aria-expanded={open}
            disabled={switching} aria-busy={switching || undefined}
            onClick={() => { if (!open) loadProjects(); setOpen((v) => !v) }}>
            <LayerfsGlyph size={14} />
            <span className={css.label}>{label}</span>
            <IconChevronDownOutlineRegular size={12} aria-hidden="true" />
          </button>
        )} />
      {failed ? <button type="button" className={css.retry} onClick={retry}>{t('retry')}</button> : null}
      {error ? <span className={css.error} role="alert">{error}</span> : null}
      <ProjectDialogMount />
    </span>
  )
}
