/**
 * The add-workspace flow's occupant: instead of a host folder, the operator
 * picks a LayerFS project (or Scratch), or creates one. The project's
 * scratch-folder workspace is prepared on the host and its anchor directory is
 * handed back to ui-workspace as the picked path, which registers (or reuses)
 * the DSH workspace and starts a session there.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, Input, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { Field, MenuSelect } from '../ui/index.tsx'
import type { PickerKey } from './locale.ts'
import css from './picker.module.css'

type Translate = (key: PickerKey, params?: Record<string, string | number>) => string

/** Owner share of ui-workspace's directory-flow holes (`DirectoryFlowOwnerProps`). */
export interface DirectoryFlowOwnerProps {
  open: boolean
  busy: boolean
  onPicked: (path: string) => void
  onCancel: () => void
  onError: (message: string) => void
}

interface ProjectRow { key: string, name?: string, store?: string, machine?: string | null, kind?: string | null }

const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/
const messageOf = (e: unknown) => String((e as any)?.message ?? e)

export function ProjectPicker(props: DirectoryFlowOwnerProps & { api: LayerfsApi, t: Translate }): ReactNode {
  const { open, busy, api, t } = props
  const [rows, setRows] = useState<ProjectRow[] | null>(null)
  const [scratchKey, setScratchKey] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [choosing, setChoosing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(() => {
    setLoadError(null)
    Promise.all([api.call<ProjectRow[]>('GET', '/api/projects'), api.op<any>('runtime.status')]).then(([list, status]) => {
      setScratchKey(status?.scratchProject ?? null)
      setRows(Array.isArray(list) ? list : [])
    }, (e) => setLoadError(messageOf(e)))
  }, [api])

  useEffect(() => {
    if (!open) { setChoosing(null); setError(null); setCreating(false); return }
    load()
  }, [open, load])

  const choose = async (key: string | null) => {
    setChoosing(key ?? 'scratch')
    setError(null)
    try {
      const out = key === null || key === scratchKey
        ? await api.op<{ anchor: string }>('sessions.prepareScratch', { navigate: false })
        : await api.op<{ anchor: string }>('sessions.prepare', { project: key })
      props.onPicked(out.anchor)
    } catch (e) {
      setError(messageOf(e))
      setChoosing(null)
    }
  }

  const pending = busy || choosing !== null
  const projects = (rows ?? []).filter((r) => r.key !== scratchKey)
  return (
    <Modal open={open} onClose={() => { if (!pending) props.onCancel() }} title={creating ? t('newProjectTitle') : t('title')}
      description={creating ? undefined : t('description')} closeLabel={t('close')} className={css.modal}
      footer={creating ? null : (
        <div className={css.footer}>
          <Button variant="outline" disabled={pending} onClick={() => setCreating(true)}>{t('newProject')}</Button>
          <Button variant="ghost" disabled={pending} onClick={props.onCancel}>{t('cancel')}</Button>
        </div>
      )}>
      {creating ? (
        <NewProject api={api} t={t} scratchKey={scratchKey} onBack={() => setCreating(false)} onCreated={(key) => { void choose(key) }} />
      ) : (
        <div className={css.body}>
          <ul className={css.list} aria-label={t('scratch')}>
            <li>
              <button type="button" className={css.row} disabled={pending} onClick={() => { void choose(null) }}>
                <span className={css.rowMain}>
                  <span className={css.rowName}>{t('scratch')}</span>
                  <span className={css.rowMeta}>{t('scratchBody')}</span>
                </span>
                {choosing === 'scratch' ? <StateDot state="ongoing" size={13} /> : null}
              </button>
            </li>
          </ul>
          <div className={css.label}>{t('projects')}</div>
          {loadError ? (
            <div className={css.stack}>
              <div className={css.error} role="alert">{t('loadFailed', { message: loadError })}</div>
              <Button variant="outline" size="sm" className={css.selfStart} onClick={load}>{t('retry')}</Button>
            </div>
          ) : rows === null ? <div className={css.muted}>{t('loading')}</div>
            : projects.length === 0 ? <div className={css.muted}>{t('empty')}</div> : (
              <ul className={css.list} aria-label={t('projects')}>
                {projects.map((p) => {
                  const remote = p.kind !== 'postgresql' && p.machine && p.machine !== 'native' ? p.machine : null
                  return (
                    <li key={p.key}>
                      <button type="button" className={css.row} disabled={pending || !!remote} onClick={() => { void choose(p.key) }}>
                        <span className={css.rowMain}>
                          <span className={css.rowName}>{p.name ?? p.key.split('/')[1]}</span>
                          <span className={css.rowMeta}>{remote ? t('onMachine', { machine: remote }) : p.store ?? p.key.split('/')[0]}</span>
                        </span>
                        {choosing === p.key ? <StateDot state="ongoing" size={13} /> : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          {error ? <div className={css.error} role="alert">{error}</div> : null}
        </div>
      )}
    </Modal>
  )
}

/** Create a project (and a first Store when there is none), then open it. */
function NewProject({ api, t, scratchKey, onBack, onCreated }: { api: LayerfsApi, t: Translate, scratchKey: string | null, onBack: () => void, onCreated: (key: string) => void }): ReactNode {
  const [stores, setStores] = useState<string[] | null>(null)
  const [store, setStore] = useState('')
  const [name, setName] = useState('')
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
  const valid = !!store.trim() && NAME.test(name.trim()) && !storeError && !sourceError && !busy

  const submit = async () => {
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      if (fresh) await api.call('POST', '/api/stores', { name: store.trim() })
      let job = await api.call<any>('POST', '/api/projects', { store: store.trim(), name: name.trim(), ...(source.trim() ? { source: source.trim() } : {}) })
      while (!job.ended) {
        await new Promise((r) => setTimeout(r, 500))
        job = await api.call<any>('GET', `/api/project-inits/${encodeURIComponent(job.id)}`)
      }
      if (job.error) throw new Error(job.error.message ?? String(job.error.code))
      onCreated(`${store.trim()}/${name.trim()}`)
    } catch (e) {
      setError(messageOf(e))
      setBusy(false)
    }
  }

  return (
    <form className={css.body} onSubmit={(e) => { e.preventDefault(); void submit() }}>
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
        <Input value={name} autoComplete="off" spellCheck={false} data-modal-autofocus="" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('source')} hint={t('sourceHint')} error={sourceError}>
        <Input value={source} autoComplete="off" spellCheck={false} className={css.mono} onChange={(e) => setSource(e.target.value)} />
      </Field>
      {error ? <div className={css.error} role="alert">{error}</div> : null}
      <div className={css.footer}>
        <Button variant="ghost" type="button" disabled={busy} onClick={onBack}>{t('back')}</Button>
        <Button variant="primary" type="submit" disabled={!valid} aria-busy={busy} icon={busy ? <StateDot state="ongoing" size={13} /> : undefined}>
          {busy ? t('creating') : t('create')}
        </Button>
      </div>
    </form>
  )
}
