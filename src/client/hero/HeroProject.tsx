/**
 * The New Session row's LayerFS project control (`conversation.hero.options`):
 * shows the project the new session will work in, or "No project" for a plain
 * workspace session, and switches it — another project, a new empty project,
 * or a project imported from a host folder. Project ownership and the selected
 * local scratch folder are independent. While an import runs, the control shows its
 * progress.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular, IconPlusOutlineRegular, IconSettingsOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { listProjects, messageOf, type ProjectInitJob, type ProjectRow } from '../picker/NewProjectForm.tsx'
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

export function HeroProject({ sessionId, api, t, imports }: HeroProjectProps): ReactNode {
  const root = useRef<HTMLSpanElement>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const [place, setPlace] = useState<Place | null>(null)
  const [rows, setRows] = useState<ProjectRow[] | null>(null)
  const [scratchKey, setScratchKey] = useState<string | null>(null)
  const [storage, setStorage] = useState<StorageView | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const running = useSyncExternalStore(imports.subscribe, imports.get)
  const [, tick] = useState(0)

  useEffect(() => {
    let live = true
    const load = () => api.op<{ place: Place | null }>('session.place', { sessionId }).then((v) => { if (live) setPlace(v.place) }, () => {})
    void load()
    const off = api.onEvent('layerfs-session', (e) => { if (!e.data?.sessionId || e.data.sessionId === sessionId) void load() })
    return () => { live = false; off() }
  }, [api, sessionId])

  const loadProjects = () => {
    setLoadError(false)
    listProjects(api).then(({ rows: list, scratchKey: key }) => { setRows(list); setScratchKey(key) }, () => setLoadError(true))
    // Where each project runs (its SQLite Store's machine, or its PostgreSQL Store's attached machines).
    api.call<StorageView>('GET', '/api/storage').then(setStorage, () => {})
  }
  useEffect(loadProjects, [api])
  // Store health and project changes reach an open picker too (it never polls).
  useEffect(() => {
    const offs = ['layerfs-availability', 'layerfs-workspaces-changed', 'storage'].map((type) => api.onEvent(type, () => loadProjects()))
    return () => offs.forEach((off) => off())
  }, [api])

  useEffect(() => {
    if (!running || running.error) return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [running])

  /** Place this session in a LayerFS project (or back in a plain folder). */
  const switchTo = async (key: string | null) => {
    setError(null)
    setSwitching(true)
    try {
      const row = rows?.find((p) => (p.projectId ?? p.key) === key)
      await api.op('sessions.choose', { sessionId, project: row?.key ?? key, projectId: row?.projectId })
    } catch (e) {
      setError(t('switchFailed', { message: messageOf(e) }))
    } finally {
      setSwitching(false)
    }
  }

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

  const current = place?.projectId ?? place?.project ?? null
  const label = place === null ? '' : place.project ? nameOf(place.project) : t('noProject')
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
      const note = runsOn(storage?.stores.find((s) => s.name === store)).join(', ') || (p.machine ?? '')
      const configure = t('configure', { project: name })
      return {
        id: p.projectId ?? p.key,
        icon: <LayerfsGlyph size={14} />,
        label: <span className={css.option} title={`${name} · ${store}${note ? ` · ${note}` : ''}`}>
          <span className={css.optionName}>{name}</span><span className={css.optionNote}>{note}</span>
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
      <Menu open={open && !switching} onClose={() => setOpen(false)} portal align="start" items={items} selectedId={current ?? NONE} dense
        onSelect={(id) => {
          setOpen(false)
          if (id === NEW) projectDialog.open({ mode: 'new' })
          else if (id === IMPORT) projectDialog.open({ mode: 'import' })
          else if (id !== (current ?? NONE)) void switchTo(id === NONE ? null : id)
        }}
        anchor={(
          <button ref={anchor} type="button" className={css.chip} aria-label={t('chipAria', { project: label })} aria-haspopup="menu" aria-expanded={open}
            disabled={switching} aria-busy={switching || undefined}
            onClick={() => { if (!open) loadProjects(); setOpen((v) => !v) }}>
            <LayerfsGlyph size={14} />
            <span className={css.label}>{label}</span>
            <IconChevronDownOutlineRegular size={12} aria-hidden="true" />
          </button>
        )} />
      {error ? <span className={css.error} role="alert">{error}</span> : null}
      <ProjectDialogMount />
    </span>
  )
}
