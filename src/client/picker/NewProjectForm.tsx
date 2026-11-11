/**
 * Creating a LayerFS project from the browser: an empty one or one imported
 * from a host folder, into an existing Store on this host (or a first SQLite
 * Store when there is none). Shared by the add-workspace picker and the New
 * Session project control; the caller decides whether to wait for the Init job.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { Field, MenuSelect } from '../ui/index.tsx'
import type { PickerKey } from './locale.ts'
import css from './picker.module.css'

type Translate = (key: PickerKey, params?: Record<string, string | number>) => string

/** One `/api/projects` row. */
export interface ProjectRow { key: string, name?: string, store?: string, machine?: string | null, kind?: string | null }

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
  const [list, status] = await Promise.all([api.call<ProjectRow[]>('GET', '/api/projects'), api.op<any>('runtime.status')])
  return { rows: Array.isArray(list) ? list : [], scratchKey: status?.scratchProject ?? null }
}

/** A project on another machine cannot hold session Workspaces here: its machine, else null. */
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
const suggestName = (path: string) => basename(path).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').slice(0, 63)

/**
 * The form. `withSource` asks for the folder first and suggests the name from it;
 * `optionalSource` offers it last for an otherwise empty project.
 * `onStarted` receives the running Init job and the project key; a throw shows under the form.
 */
export function NewProjectForm({ api, t, scratchKey, withSource, optionalSource = false, onBack, backLabel, onStarted }: {
  api: LayerfsApi
  t: Translate
  scratchKey: string | null
  withSource: boolean
  optionalSource?: boolean
  onBack: () => void
  backLabel?: string
  onStarted: (job: ProjectInitJob, key: string) => Promise<void> | void
}): ReactNode {
  const [stores, setStores] = useState<string[] | null>(null)
  const [store, setStore] = useState('')
  const [name, setName] = useState('')
  const [named, setNamed] = useState(false)
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scratchStore = scratchKey?.split('/')[0]

  useEffect(() => {
    api.call<any>('GET', '/api/storage').then((view) => {
      const usable = (s: any) => s.name !== scratchStore && (s.kind === 'postgresql' || (s.machine ?? 'native') === 'native')
      const names = (view?.stores ?? []).filter(usable).map((s: any) => String(s.name))
      setStores(names)
      setStore((current) => current || names[0] || '')
    }, (e) => { setStores([]); setError(messageOf(e)) })
  }, [api, scratchStore])

  const fresh = stores !== null && stores.length === 0
  const nameError = name.trim() && !NAME.test(name.trim()) ? t('nameInvalid') : null
  const storeError = fresh && store.trim() && !NAME.test(store.trim()) ? t('nameInvalid') : null
  const sourceError = source.trim() && !source.trim().startsWith('/') ? t('sourceInvalid') : null
  const valid = !!store.trim() && NAME.test(name.trim()) && !storeError && !sourceError && (!withSource || !!source.trim()) && !busy

  const submit = async () => {
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      if (fresh) await api.call('POST', '/api/stores', { name: store.trim() })
      const job = await api.call<ProjectInitJob>('POST', '/api/projects', { store: store.trim(), name: name.trim(), ...(source.trim() ? { source: source.trim() } : {}) })
      await onStarted(job, `${store.trim()}/${name.trim()}`)
    } catch (e) {
      setError(messageOf(e))
      setBusy(false)
    }
  }

  const sourceField = (
    <Field label={withSource ? t('sourceRequired') : t('source')} hint={withSource ? t('sourceRequiredHint') : t('sourceHint')} error={sourceError}>
      <Input value={source} autoComplete="off" spellCheck={false} className={css.mono} data-modal-autofocus={withSource ? '' : undefined}
        onChange={(e) => { setSource(e.target.value); if (!named) setName(suggestName(e.target.value)) }} />
    </Field>
  )
  return (
    <form className={css.body} onSubmit={(e) => { e.preventDefault(); void submit() }}>
      {withSource ? sourceField : null}
      {fresh ? (
        <Field label={t('newStore')} hint={t('newStoreHint')} error={storeError}>
          <Input value={store} autoComplete="off" spellCheck={false} onChange={(e) => setStore(e.target.value)} />
        </Field>
      ) : (
        <Field label={t('store')}>
          <MenuSelect value={store} label={t('store')} placeholder={t('storeChoose')} disabled={stores === null}
            options={(stores ?? []).map((s) => ({ value: s, label: s }))} onChange={setStore} />
        </Field>
      )}
      <Field label={t('name')} error={nameError}>
        <Input value={name} autoComplete="off" spellCheck={false} data-modal-autofocus={withSource ? undefined : ''} onChange={(e) => { setName(e.target.value); setNamed(true) }} />
      </Field>
      {!withSource && optionalSource ? sourceField : null}
      {error ? <div className={css.error} role="alert">{error}</div> : null}
      <div className={css.footer}>
        <Button variant="ghost" type="button" disabled={busy} onClick={onBack}>{backLabel ?? t('back')}</Button>
        <Button variant="primary" type="submit" disabled={!valid} aria-busy={busy} icon={busy ? <StateDot state="ongoing" size={13} /> : undefined}>
          {busy ? t('creating') : withSource ? t('import') : t('create')}
        </Button>
      </div>
    </form>
  )
}
