/**
 * The New Session row's LayerFS project control (`conversation.hero.options`):
 * shows the project the new session will work in, and switches it — another
 * project, Scratch, a new empty project, or a project imported from a host
 * folder. Switching opens a new session in that project's workspace. While an
 * import runs, the control shows its progress.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular, IconPlusOutlineRegular, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { listProjects, messageOf, NewProjectForm, remoteMachine, waitProject, type ProjectInitJob, type ProjectRow } from '../picker/NewProjectForm.tsx'
import type { PickerKey } from '../picker/locale.ts'
import type { HeroKey } from './locale.ts'
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

interface Place { project: string | null, scratch: boolean, legacy: boolean }

const SCRATCH = '@scratch'
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

export function HeroProject({ sessionId, api, t, tp, imports }: HeroProjectProps): ReactNode {
  const anchor = useRef<HTMLButtonElement>(null)
  const [place, setPlace] = useState<Place | null>(null)
  const [rows, setRows] = useState<ProjectRow[] | null>(null)
  const [scratchKey, setScratchKey] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<'empty' | 'import' | null>(null)
  const [error, setError] = useState<string | null>(null)
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
  }
  useEffect(loadProjects, [api])

  useEffect(() => {
    if (!running || running.error) return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [running])

  /** Open a new session in a project's workspace (null: the Scratch workspace). */
  const switchTo = async (key: string | null) => {
    setError(null)
    try {
      if (key === null || key === scratchKey) await api.op('sessions.prepareScratch')
      else await api.op('sessions.create', { project: key })
    } catch (e) {
      setError(t('switchFailed', { message: messageOf(e) }))
    }
  }

  /** Follow an Init job in the control, then open the new project. */
  const follow = (job: ProjectInitJob, key: string) => {
    setDialog(null)
    imports.set({ key, job, error: null })
    void waitProject(api, job, (next) => imports.set({ key, job: next, error: null })).then(
      async () => {
        imports.set(null)
        loadProjects()
        await switchTo(key)
      },
      (e) => imports.set({ key, job, error: messageOf(e) }),
    )
  }

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

  const current = place?.legacy ? null : place?.scratch ? SCRATCH : place?.project ?? null
  const label = place === null ? '' : place.legacy ? t('hostFolder') : place.scratch ? t('scratch') : nameOf(place.project ?? '')
  const projects = (rows ?? []).filter((r) => r.key !== scratchKey)
  const items: MenuEntry[] = [
    ...(rows === null && !loadError ? [{ type: 'label' as const, id: 'loading', text: t('loading') }] : []),
    ...(loadError ? [{ type: 'label' as const, id: 'failed', text: t('loadFailed') }] : []),
    ...projects.map((p) => {
      const remote = remoteMachine(p)
      return {
        id: p.key,
        icon: <LayerfsGlyph size={14} />,
        disabled: !!remote,
        label: remote ? <span className={css.option}><span>{p.name ?? nameOf(p.key)}</span><span className={css.optionNote}>{t('onMachine', { machine: remote })}</span></span> : (p.name ?? nameOf(p.key)),
      }
    }),
    { id: SCRATCH, label: t('noProject') },
    { type: 'separator', id: 'actions' },
    { id: NEW, label: t('newEmpty'), icon: <IconPlusOutlineRegular size={14} /> },
    { id: IMPORT, label: t('importProject'), icon: <IconFolderOpenOutlineRegular size={14} /> },
  ]
  return (
    <span className={css.root} data-layerfs-hero="">
      <Menu open={open} onClose={() => setOpen(false)} portal align="start" items={items} selectedId={current ?? undefined} dense
        onSelect={(id) => {
          setOpen(false)
          if (id === NEW) setDialog('empty')
          else if (id === IMPORT) setDialog('import')
          else if (id !== current) void switchTo(id === SCRATCH ? null : id)
        }}
        anchor={(
          <button ref={anchor} type="button" className={css.chip} aria-label={t('chipAria', { project: label })} aria-haspopup="menu" aria-expanded={open}
            onClick={() => { if (!open) loadProjects(); setOpen((v) => !v) }}>
            <LayerfsGlyph size={14} />
            <span className={css.label}>{label}</span>
            <IconChevronDownOutlineRegular size={12} aria-hidden="true" />
          </button>
        )} />
      {error ? <span className={css.error} role="alert" title={error}>{error}</span> : null}
      <Modal open={dialog !== null} onClose={() => setDialog(null)} title={dialog === 'import' ? t('importTitle') : t('newEmptyTitle')} closeLabel={t('close')} className={css.modal}>
        {dialog !== null ? (
          <NewProjectForm api={api} t={tp} scratchKey={scratchKey} withSource={dialog === 'import'} backLabel={t('cancel')}
            onBack={() => setDialog(null)} onStarted={follow} />
        ) : null}
      </Modal>
    </span>
  )
}
