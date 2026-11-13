/**
 * Creating a LayerFS project from the browser: an empty one or one imported
 * from a host folder, into a Store this host can Init into (or a first SQLite
 * Store, `projects`, when there is none). Shared by the add-workspace picker and the New
 * Session project control; the caller decides whether to wait for the Init job.
 */
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { Button, Input, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { Field, MenuSelect } from '../ui/index.tsx'
import type { PickerKey } from './locale.ts'
import { defaultStoreName, lastStore, locationsOf, preferredStore, rememberStore, slugify, type Location } from './location.ts'
import css from './picker.module.css'

type Translate = (key: PickerKey, params?: Record<string, string | number>) => string

/** One `/api/projects` row. */
export interface ProjectRow { projectId?: string, catalogState?: 'available' | 'unavailable' | 'removed' | 'identity-mismatch', catalogError?: string, identity?: { id: string }, key: string, name?: string, store?: string, machine?: string | null, kind?: string | null, created?: number | null, storeState?: string | null }

/** One project Init job (`/api/project-inits/<id>`). */
export interface ProjectInitJob {
  id: string
  name: string
  source: string | null
  started: number
  ended: number | null
  step: string
  progress: { phase: string | null, done: number | null, total: number | null } | null
  error: { code?: string, message?: string } | null
}

export const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/
export const messageOf = (e: unknown) => String((e as any)?.message ?? e)

/** Projects and the Scratch project's key. */
export async function listProjects(api: LayerfsApi): Promise<{ rows: ProjectRow[], scratchKey: string | null }> {
  return api.op<{ rows: ProjectRow[], scratchKey: string | null }>('projects.catalog')
}

/** The machine a project's SQLite Store lives on when it is not this host (its Sandboxes run there), else null. */
export const remoteMachine = (p: ProjectRow): string | null => (p.kind !== 'postgresql' && p.machine && p.machine !== 'native' ? p.machine : null)

/** Poll an Init job until it ends; throws its refusal. */
export async function waitProject(api: LayerfsApi, job: ProjectInitJob, onUpdate?: (job: ProjectInitJob) => void): Promise<ProjectInitJob> {
  let current = job
  while (!current.ended) {
    await new Promise((r) => setTimeout(r, 500))
    current = await api.call<ProjectInitJob>('GET', `/api/project-inits/${encodeURIComponent(current.id)}`)
    onUpdate?.(current)
  }
  if (current.error) throw new Error(current.error.message ?? String(current.error.code))
  return current
}

const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? ''

/**
 * The form (docs/specs/layerfs-workspaces.md §5). The name comes first (after
 * the folder when `withSource`) and is saved as its slug; the Location is one
 * Store this host can Init into, plain text when there is only one, and a
 * note that a first SQLite Store will be made when there is none.
 * `optionalSource` offers a folder last for an otherwise empty project;
 * `initialSource` prefills the folder (a path the caller already picked).
 * `onStarted` receives the running Init job and the project key; a throw shows under the form.
 * With `dialog` the form renders inside a DSH `Modal` whose footer holds Cancel and the submit.
 */
export function NewProjectForm({ api, t, scratchKey, withSource, optionalSource = false, initialSource, onBack, backLabel, onStarted, dialog }: {
  api: LayerfsApi
  t: Translate
  scratchKey: string | null
  withSource: boolean
  optionalSource?: boolean
  initialSource?: string
  onBack: () => void
  backLabel?: string
  onStarted: (job: ProjectInitJob, key: string) => Promise<void> | void
  dialog?: { title: string, closeLabel: string, className?: string }
}): ReactNode {
  const formId = useId()
  const [locations, setLocations] = useState<Location[] | null>(null)
  const [freshStore, setFreshStore] = useState('projects')
  const [storesError, setStoresError] = useState<string | null>(null)
  const [store, setStore] = useState('')
  const [name, setName] = useState(() => (initialSource ? slugify(basename(initialSource)) : ''))
  const [named, setNamed] = useState(false)
  const [source, setSource] = useState(initialSource ?? '')
  const [pickerMissing, setPickerMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scratchStore = scratchKey?.split('/')[0]

  // A failed read is not "no Stores": only a successful empty answer makes a new Store.
  const loadStores = useCallback(() => {
    setLocations(null)
    setStoresError(null)
    api.call<any>('GET', '/api/storage').then((view) => {
      const found = locationsOf(view, scratchStore)
      setLocations(found)
      setFreshStore(defaultStoreName(view))
      setStore((current) => current || preferredStore(found, lastStore()))
    }, (e) => setStoresError(messageOf(e)))
  }, [api, scratchStore])
  useEffect(loadStores, [loadStores])

  const fresh = locations !== null && locations.length === 0
  const target = fresh ? freshStore : store
  const slug = slugify(name)
  const nameError = name.trim() && !NAME.test(slug) ? t('nameInvalid') : null
  const sourceError = source.trim() && !source.trim().startsWith('/') ? t('sourceInvalid') : null
  const valid = locations !== null && !!target && NAME.test(slug) && !sourceError && (!withSource || !!source.trim()) && !busy
  const chosen = locations?.find((l) => l.store === store) ?? null
  const machineLabel = (m: string) => (m === 'native' ? t('home') : m)
  const locationLabel = (l: Location) => `${l.store} · ${l.kind === 'postgresql' ? (l.server ?? 'PostgreSQL') : t('home')}`

  const changeSource = (value: string) => { setSource(value); if (!named) setName(slugify(basename(value))) }
  const browse = async () => {
    setError(null)
    try {
      const picked = await api.pickDirectory()
      if (picked) changeSource(picked)
    } catch (e) {
      // Hosts without a native directory dialog keep the typed path only.
      if ((e as { code?: string })?.code === 'no-picker') setPickerMissing(true)
      else setError(messageOf(e))
    }
  }

  const submit = async () => {
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      if (fresh) await api.call('POST', '/api/stores', { name: target })
      const job = await api.call<ProjectInitJob>('POST', '/api/projects', { store: target, name: slug, ...(source.trim() ? { source: source.trim() } : {}) })
      rememberStore(target)
      await onStarted(job, `${target}/${slug}`)
    } catch (e) {
      setError(messageOf(e))
      setBusy(false)
    }
  }

  const sourceField = (
    <Field label={withSource ? t('sourceRequired') : t('source')} hint={withSource ? (initialSource ? undefined : t('sourceRequiredHint')) : t('sourceHint')} error={sourceError}>
      <span className={css.sourceRow}>
        <Input value={source} autoComplete="off" spellCheck={false} className={css.mono} data-modal-autofocus={withSource && !initialSource ? '' : undefined}
          onChange={(e) => changeSource(e.target.value)} />
        {pickerMissing ? null : <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => void browse()}>{t('browse')}</Button>}
      </span>
    </Field>
  )
  const location = storesError ? (
    <div className={css.notice} role="alert">
      <span className={css.error}>{t('storesFailed', { message: storesError })}</span>
      <Button variant="outline" size="sm" type="button" onClick={loadStores}>{t('retry')}</Button>
    </div>
  ) : (
    <Field label={t('location')}>
      {locations === null ? <span className={css.locationText}>…</span>
        : fresh ? <span className={css.locationText} data-layerfs-location="new">{t('locationNew', { store: freshStore })}</span>
          : locations.length === 1 ? <span className={css.locationText} data-layerfs-location={locations[0]!.store}>{locationLabel(locations[0]!)}</span>
            : <MenuSelect value={store} label={t('location')} placeholder={t('storeChoose')}
              options={locations.map((l) => ({ value: l.store, label: locationLabel(l) }))} onChange={setStore} />}
      {chosen?.kind === 'postgresql' && chosen.runsOn ? <span className={css.locationHint}>{t('runsOn', { machine: machineLabel(chosen.runsOn) })}</span> : null}
    </Field>
  )
  const back = <Button variant={dialog ? 'outline' : 'ghost'} type="button" disabled={busy} onClick={onBack}>{backLabel ?? t('back')}</Button>
  const create = (
    <Button variant="primary" type="submit" form={formId} disabled={!valid} aria-busy={busy} icon={busy ? <StateDot state="ongoing" size={13} /> : undefined}>
      {busy ? t('creating') : withSource ? t('import') : t('create')}
    </Button>
  )
  const form = (
    <form id={formId} className={css.body} onSubmit={(e) => { e.preventDefault(); void submit() }}>
      {withSource ? sourceField : null}
      <Field label={t('name')} error={nameError} hint={!nameError && slug && slug !== name.trim() ? t('savedAs', { slug }) : undefined}>
        <Input value={name} autoComplete="off" spellCheck={false} data-modal-autofocus={withSource && !initialSource ? undefined : ''} onChange={(e) => { setName(e.target.value); setNamed(true) }} />
      </Field>
      {location}
      {!withSource && optionalSource ? sourceField : null}
      {error ? <div className={css.error} role="alert">{error}</div> : null}
      {dialog ? null : <div className={css.footer}>{back}{create}</div>}
    </form>
  )
  if (!dialog) return form
  return (
    <Modal open onClose={onBack} title={dialog.title} closeLabel={dialog.closeLabel} className={dialog.className} footer={<>{back}{create}</>}>
      {form}
    </Modal>
  )
}
