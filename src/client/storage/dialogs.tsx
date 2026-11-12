/**
 * Storage's dialogs: one small form per action. A PostgreSQL password or a
 * bucket's keys are either a reference (env:… or file:/path) or typed here;
 * a typed secret goes to the host, which keeps it in an owner-only file and
 * gives LayerFS that file's reference.
 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, SegmentedControl, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import { bytes } from '../files/format.ts'
import { useQuery } from '../files/use-query.ts'
import { Field, MenuSelect, Notice, Refusal } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { attachRefusal, inHome, loopbackAlias } from './model.ts'
import { BucketProviderGlyph } from '../machines/icons.tsx'
import { FormModal, refusalLabels, StoreGlyph, TextField, TileChoice } from './parts.tsx'
import type { BackupState, MachinesView, PgAttachment, ProjectInitJob, StorageView, StoreRow } from './types.ts'
import css from './Storage.module.css'

const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/
const REFERENCE = /^(env:LAYERFS_[A-Z0-9_]+|file:\/.+)$/
/** A PostgreSQL password reference: any env: name (the server's environment) or a file. */
const PG_REFERENCE = /^(env:[A-Za-z_][A-Za-z0-9_]*|file:\/.+)$/
/** A PostgreSQL URL that holds a password (user:password@, or a password parameter). */
const PG_URL_PASSWORD = /^postgres(?:ql)?:\/\/[^/@?]*:[^/@?]*@|[?&][^=&]*password=/i

/** Which dialog is open, and on what. */
export type StorageDialog =
  | { kind: 'new-store', postgresql?: boolean }
  | { kind: 'attach', store: string, machine?: string, edit?: PgAttachment }
  | { kind: 'add-project', store: string }
  | { kind: 'push', store: StoreRow }
  | { kind: 'move', store: StoreRow }
  | { kind: 'backup', store: StoreRow }
  | { kind: 'restore', bucket: string, file: string, store?: string | null }
  | { kind: 'bucket' }
  | { kind: 'confirm', title: string, body: string, action: string, name?: string, run: () => Promise<unknown> }

interface DialogsProps {
  api: LayerfsApi
  t: StorageT
  dialog: StorageDialog | null
  view: StorageView | undefined
  onClose: () => void
  /** The view changed: read it again. */
  done: () => void
  /** Opens a Store's page (after a PostgreSQL connect). */
  onOpenStore?: (name: string) => void
}

/** The open dialog, if any. */
export function StorageDialogs({ api, t, dialog, view, onClose, done, onOpenStore }: DialogsProps): ReactNode {
  if (!dialog) return null
  const after = <T,>(p: Promise<T>) => p.then((v) => { done(); return v })
  switch (dialog.kind) {
    case 'new-store': return <NewStoreDialog api={api} t={t} view={view} postgresql={dialog.postgresql === true} onClose={onClose} done={done} onOpenStore={onOpenStore} />
    case 'attach': return <AttachDialog api={api} t={t} view={view} store={dialog.store} machine={dialog.machine} edit={dialog.edit} onClose={onClose} done={done} />
    case 'add-project': return <NewProjectDialog api={api} t={t} store={dialog.store} onClose={onClose} done={done} />
    case 'push':
    case 'move': return <PlaceDialog api={api} t={t} kind={dialog.kind} store={dialog.store} onClose={onClose} done={done} />
    case 'backup': return <BackupDialog api={api} t={t} store={dialog.store} view={view} onClose={onClose} done={done} />
    case 'restore': return <RestoreDialog api={api} t={t} dialog={dialog} view={view} onClose={onClose} done={done} />
    case 'bucket': return <BucketDialog api={api} t={t} onClose={onClose} done={done} />
    case 'confirm': return <ConfirmDialog t={t} title={dialog.title} body={dialog.body} action={dialog.action} name={dialog.name} onClose={onClose} run={() => after(dialog.run())} />
  }
}

// ---------- New Store ----------

type NewPane = 'empty' | 'restore' | 'postgresql'

function NewStoreDialog({ api, t, view, postgresql, onClose, done, onOpenStore }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, postgresql: boolean, onClose: () => void, done: () => void, onOpenStore?: ((name: string) => void) | undefined
}): ReactNode {
  const [pane, setPane] = useState<NewPane>(postgresql ? 'postgresql' : 'empty')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const pw = usePgPassword()
  const [sync, setSync] = useState<string>('')
  const buckets = view?.buckets ?? []
  const [bucket, setBucket] = useState(buckets[0]?.name ?? '')
  const [file, setFile] = useState('')
  const [listing, setListing] = useState(false)
  const [listError, setListError] = useState<unknown>(undefined)
  const family = pane === 'postgresql' ? 'postgresql' : 'sqlite'
  const chosen = buckets.find((b) => b.name === bucket)
  const files = chosen?.files ? [...new Set(chosen.files.map((f) => f.file))].map((f) => ({ file: f, bytes: chosen.files!.find((x) => x.file === f)?.bytes ?? null, stores: chosen.files!.filter((x) => x.file === f && x.store).map((x) => x.store!) })) : null
  const taken = !!name.trim() && !!view?.stores.some((s) => s.name === name.trim())
  const list = async () => {
    setListing(true)
    setListError(undefined)
    try { await api.call('GET', `/api/buckets/${enc(bucket)}/files`) } catch (e) { setListError(e) } finally { setListing(false); done() }
  }
  const choose = (f: string) => {
    setFile(f)
    const base = f.replace(/\.[^.]+$/, '')
    setName(view?.stores.some((s) => s.name === base) ? `${base}-restored` : base)
  }
  const nameOk = NAME.test(name.trim()) && !taken
  const missing = [
    !name.trim() && t('name'),
    pane === 'restore' && !bucket && t('bucket'),
    pane === 'restore' && !file && t('storeFile'),
    pane === 'postgresql' && !url.trim() && t('pgUrl'),
    pane === 'postgresql' && pw.missing && t('password'),
  ].filter(Boolean) as string[]
  const urlError = pane === 'postgresql' && PG_URL_PASSWORD.test(url.trim()) ? t('pgPasswordInUrl') : null
  const passwordError = pane === 'postgresql' ? pw.error(t) : null
  const form = {
    empty: { action: t('createStore'), description: t('newStoreEmptyBody'), submit: () => api.call('POST', '/api/stores', { name: name.trim() }) },
    restore: { action: t('restoreStore'), description: t('newStoreRestoreBody'), submit: () => api.call('POST', `/api/buckets/${enc(bucket)}/restore`, { store: name.trim(), file }) },
    postgresql: {
      action: t('connect'), description: t('newStorePgBody'),
      submit: () => api.call('POST', '/api/stores/postgresql', { name: name.trim(), url: url.trim(), ...pw.body(), ...(sync ? { synchronousCommit: sync } : {}) }).then(() => onOpenStore?.(name.trim())),
    },
  }[pane]
  return (
    <FormModal open onClose={onClose} t={t} title={postgresql ? t('connectDatabase') : t('newStore')} description={form.description} action={form.action}
      valid={!missing.length && nameOk && !passwordError && !urlError} hint={missing.length ? t('stillNeeded', { what: missing.join(', ') }) : undefined}
      submit={() => form.submit().then(done)}>
      <TileChoice label={t('kindOfStore')} value={family} onChange={(v) => setPane(v === 'sqlite' ? 'empty' : 'postgresql')}
        options={[{ value: 'sqlite', label: t('sqlite'), icon: <StoreGlyph kind="sqlite" /> }, { value: 'postgresql', label: t('postgresql'), icon: <StoreGlyph kind="postgresql" /> }]} />
      {family === 'sqlite' ? (
        <SegmentedControl<'empty' | 'restore'> id="lfs-new-store-sqlite" className={css.selfStart} value={pane as 'empty' | 'restore'} onChange={setPane} label={t('sqlite')}
          options={[{ value: 'empty', label: t('storeEmpty') }, { value: 'restore', label: t('storeRestore') }]} />
      ) : null}
      {pane === 'restore' ? (
        buckets.length === 0 ? <Notice tone="warning">{t('noBucketForRestore')}</Notice> : (
          <>
            <Field label={t('bucket')}>
              <div className={css.inline}>
                <MenuSelect value={bucket} label={t('bucket')} placeholder={t('chooseBucket')} className={css.grow}
                  options={buckets.map((b) => ({ value: b.name, label: b.name }))} onChange={(v) => { setBucket(v); setFile('') }} />
                <Button variant="outline" size="sm" disabled={!bucket || listing} onClick={() => { void list() }}
                  icon={listing ? <StateDot state="ongoing" size={13} /> : undefined}>{t('listBucket')}</Button>
              </div>
            </Field>
            {listError !== undefined ? <Refusal error={listError} labels={refusalLabels(t)} compact /> : null}
            <div className={css.choiceList} role="radiogroup" aria-label={t('storeFile')}>
              {!files?.length ? <p className={css.choiceEmpty}>{t('noFilesListed')}</p> : files.map((f) => (
                <button key={f.file} type="button" role="radio" aria-checked={file === f.file} className={css.choiceRow} data-checked={file === f.file || undefined} onClick={() => choose(f.file)}>
                  <span className={css.radio} aria-hidden="true" />
                  <span className={css.choiceMain}>{f.file}</span>
                  {f.stores.length ? <span className={css.choiceMeta}>{f.stores.join(', ')}</span> : null}
                  <span className={css.choiceMeta}>{bytes(f.bytes)}</span>
                </button>
              ))}
            </div>
          </>
        )
      ) : null}
      <TextField label={pane === 'restore' ? t('newStoreName') : t('name')} value={name} onChange={setName} mono autoFocus={pane !== 'restore'}
        placeholder={pane === 'postgresql' ? 'team' : 'work'} hint={t('storeNameHint')} error={taken ? t('nameTaken') : null} />
      {pane === 'postgresql' ? (
        <>
          <TextField label={t('pgUrl')} value={url} onChange={setUrl} mono placeholder="postgresql://user@host:5432/db" hint={t('pgUrlHint')} error={urlError} />
          <PgPasswordFields id="lfs-pg-connect" pw={pw} t={t} />
          <Field label={t('syncCommit')}>
            <MenuSelect value={sync} label={t('syncCommit')} placeholder={t('syncCommitDefault')}
              options={[{ value: '', label: t('syncCommitDefault') }, ...['off', 'local', 'remote_write', 'on', 'remote_apply'].map((v) => ({ value: v, label: v }))]} onChange={setSync} />
          </Field>
        </>
      ) : null}
    </FormModal>
  )
}

// ---------- PostgreSQL password and Attach ----------

/** A PostgreSQL password: typed (the host keeps it in an owner-only file) or a reference. */
function usePgPassword(initial: 'entered' | 'reference' = 'entered', reference = '') {
  const [how, setHow] = useState<'entered' | 'reference'>(initial)
  const [value, setValue] = useState('')
  const [ref, setRef] = useState(reference)
  return {
    how, setHow, value, setValue, ref, setRef,
    /** Nothing given yet. */
    missing: how === 'entered' ? !value : !ref.trim(),
    error: (t: StorageT) => (how === 'reference' && ref.trim() && !PG_REFERENCE.test(ref.trim()) ? t('passwordInvalid') : null),
    /** The route's body fields. */
    body: (): { passwordValue: string } | { password: string } => (how === 'entered' ? { passwordValue: value } : { password: ref.trim() }),
  }
}

function PgPasswordFields({ id, pw, t }: { id: string, pw: ReturnType<typeof usePgPassword>, t: StorageT }): ReactNode {
  return (
    <>
      <Field label={t('pgPasswordHow')}>
        <SegmentedControl<'entered' | 'reference'> id={id} className={css.selfStart} value={pw.how} onChange={pw.setHow} label={t('pgPasswordHow')}
          options={[{ value: 'entered', label: t('pgPasswordEntered') }, { value: 'reference', label: t('pgPasswordReference') }]} />
      </Field>
      {pw.how === 'entered' ? (
        <>
          <TextField label={t('pgPasswordValue')} value={pw.value} onChange={pw.setValue} mono type="password" />
          <p className={css.formNote}>{t('pgPasswordNote')}</p>
        </>
      ) : (
        <TextField label={t('pgPasswordReferenceLabel')} value={pw.ref} onChange={pw.setRef} mono placeholder="env:LAYERFS_PG_PASSWORD" hint={t('pgEnvHint')} error={pw.error(t)} />
      )}
    </>
  )
}

/** Is the URL's host this host's loopback? */
const loopback = (target: string | null | undefined) => /@?(localhost|127\.[0-9.]+|\[::1\])(:|\/|$)/.test(target ?? '')

/**
 * Attach a PostgreSQL Store to a machine (store.attach): with the Store's
 * connection, or one of the machine's own. LayerFS checks it from the
 * machine before it records anything; a refusal stays under the form.
 */
function AttachDialog({ api, t, view, store, machine: fixed, edit, onClose, done }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, store: string, machine?: string | undefined, edit?: PgAttachment | undefined
  onClose: () => void, done: () => void
}): ReactNode {
  const s = view?.stores.find((x) => x.name === store)
  const [machine, setMachine] = useState(fixed ?? edit?.machine ?? '')
  const [mode, setMode] = useState<'host' | 'own'>(edit?.own ? 'own' : 'host')
  const [url, setUrl] = useState(edit?.url ?? '')
  // a reference given before is shown again; a typed one stays in its file unless a new one is typed
  const givenRef = edit?.password && !edit.saved ? edit.password : ''
  const pw = usePgPassword(givenRef ? 'reference' : 'entered', givenRef)
  if (!s || !view) return null
  // a machine fixed by the caller (a drop, Edit or Re-check) is not chosen again
  const machines = [...view.machines].sort((a, b) => (a.name === 'native' ? -1 : b.name === 'native' ? 1 : a.name.localeCompare(b.name)))
  const chosen = view.machines.find((m) => m.name === machine)
  const alias = chosen ? loopbackAlias(chosen.platform) : null
  const urlError = mode === 'own' && PG_URL_PASSWORD.test(url.trim()) ? t('pgPasswordInUrl') : null
  // an own connection keeps the password it has (Edit) unless another is given
  const keeps = mode === 'own' && !!edit?.password && pw.missing
  const missing = [
    !machine && t('machine'),
    // an own connection names its URL, its password, or both
    mode === 'own' && !url.trim() && pw.missing && !keeps && t('pgUrl'),
  ].filter(Boolean) as string[]
  const placeName = (m: string) => (m === 'native' ? t('layerfsHome') : m)
  const body = () => ({
    machine,
    ...(mode === 'own' ? { ...(url.trim() ? { url: url.trim() } : {}), ...(keeps ? { password: edit!.password! } : pw.missing ? {} : pw.body()) } : {}),
  })
  return (
    <FormModal open onClose={onClose} t={t} title={t('attachTitle', { store })} description={t('attachBody')} action={t('attachAndCheck')}
      valid={!missing.length && !urlError && !(mode === 'own' && pw.error(t))}
      hint={missing.length ? t('stillNeeded', { what: missing.join(', ') }) : undefined}
      busyHint={machine ? t('checkingFrom', { machine: placeName(machine) }) : undefined}
      submit={() => api.call('POST', `/api/stores/${enc(store)}/attach`, body()).then(done)}>
      {fixed || edit ? (
        <Field label={t('machine')}><span className={css.mono}>{placeName(machine)}</span></Field>
      ) : (
        <Field label={t('machine')}>
          <div className={css.choiceList} role="radiogroup" aria-label={t('machine')}>
            {machines.map((m) => {
              const why = attachRefusal(view, s, m.name, t)
              return (
                <button key={m.name} type="button" role="radio" aria-checked={machine === m.name} disabled={!!why} className={css.choiceRow}
                  data-checked={machine === m.name || undefined} onClick={() => setMachine(m.name)}>
                  <span className={css.radio} aria-hidden="true" />
                  <span className={css.choiceMain}>{placeName(m.name)}</span>
                  <span className={css.choiceMeta}>{why ?? m.platform}</span>
                </button>
              )
            })}
          </div>
        </Field>
      )}
      <Field label={t('connection')}>
        <SegmentedControl<'host' | 'own'> id="lfs-pg-attach-mode" className={css.selfStart} value={mode} onChange={setMode} label={t('connection')}
          options={[{ value: 'host', label: t('sameAsHost') }, { value: 'own', label: t('ownConnection') }]} />
      </Field>
      {mode === 'host' ? (
        <p className={css.formNote}>
          {alias && loopback(s.postgresql?.target) ? t('sameAsHostNote', { alias }) : t('sameAsHostNoteRemote')}
          {s.postgresql?.target ? <> <span className={css.mono}>{s.postgresql.target}</span></> : null}
        </p>
      ) : (
        <>
          <TextField label={t('pgUrl')} value={url} onChange={setUrl} mono placeholder="postgresql://user@host:5432/db" hint={t('pgUrlHint')} error={urlError} autoFocus />
          <PgPasswordFields id="lfs-pg-attach-password" pw={pw} t={t} />
        </>
      )}
    </FormModal>
  )
}

// ---------- Add project ----------

function NewProjectDialog({ api, t, store, onClose, done }: { api: LayerfsApi, t: StorageT, store: string, onClose: () => void, done: () => void }): ReactNode {
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [job, setJob] = useState<ProjectInitJob | null>(null)
  const sourceError = source.trim() && !source.trim().startsWith('/') ? t('sourceInvalid') : null
  const submit = async () => {
    let current = job && !job.ended ? await api.call<ProjectInitJob>('GET', `/api/project-inits/${enc(job.id)}`)
      : await api.call<ProjectInitJob>('POST', '/api/projects', { name: name.trim(), store, ...(source.trim() ? { source: source.trim() } : {}) })
    setJob(current)
    const deadline = Date.now() + 120_000
    while (!current.ended) {
      if (Date.now() > deadline) throw new Error(t('creationRunning'))
      await new Promise((r) => setTimeout(r, 500))
      current = await api.call<ProjectInitJob>('GET', `/api/project-inits/${enc(current.id)}`)
      setJob(current)
    }
    done()
    if (current.error) throw Object.assign(new Error(current.error.message), current.error)
  }
  const running = job && !job.ended
  return (
    <FormModal open onClose={onClose} t={t} title={t('addProjectTitle', { store })} description={t('addProjectBody')}
      action={running ? t('checkCreation') : t('createProject')} valid={!!running || (NAME.test(name.trim()) && !sourceError)} submit={submit}>
      <TextField label={t('projectName')} value={name} onChange={setName} mono autoFocus placeholder="my-project" hint={t('projectNameHint')} />
      <TextField label={t('sourceFolder')} value={source} onChange={setSource} mono placeholder="/Users/me/code/my-project" hint={t('sourceFolderHint')} error={sourceError} />
      {job && !job.ended ? (
        <p className={css.progressLine} role="status">
          <StateDot state="ongoing" size={13} />
          {t('creating', { name: job.name, step: job.step })}
          {job.progress?.files != null ? ` · ${t('creatingCounts', { files: job.progress.files, bytes: bytes(job.progress.bytes ?? null) })}` : ''}
        </p>
      ) : null}
    </FormModal>
  )
}

// ---------- Push / Move ----------

function PlaceDialog({ api, t, kind, store: s, onClose, done }: { api: LayerfsApi, t: StorageT, kind: 'push' | 'move', store: StoreRow, onClose: () => void, done: () => void }): ReactNode {
  const machines = useQuery(() => api.call<MachinesView>('GET', '/api/machines'), [api])
  const [target, setTarget] = useState('')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<unknown>(undefined)
  const view = machines.data?.available ? machines.data : null
  const targets = (view?.machines ?? []).filter((m) => m.name !== 'native' && m.name !== s.machine && m.supports?.sqlite !== false)
  const chosen = targets.find((m) => m.name === target)
  const free = chosen ? view?.status[chosen.name]?.freeDisk ?? null : null
  const sandboxes = (view?.sandboxes ?? []).filter((b) => b.project?.startsWith(`${s.name}/`) && b.state !== 'gone')
  const push = kind === 'push'
  return (
    <FormModal open onClose={onClose} t={t} title={push ? t('pushTitle', { store: s.name }) : t('moveTitle', { store: s.name })}
      description={push ? t('pushBody', { n: s.projects.length }) : t('moveBody')} action={push ? t('push') : t('move')} valid={!!target}
      submit={() => api.call('POST', `/api/stores/${enc(s.name)}/${kind}`, { machine: target }).then(done)}>
      <Field label={t('machine')} hint={machines.loading && !view ? t('readingMachines') : targets.length ? undefined : t('noTargets')}>
        <MenuSelect value={target} label={t('machine')} placeholder={t('chooseMachine')} onChange={setTarget}
          options={targets.map((m) => ({ value: m.name, label: `${m.name} · ${m.platform} · ${m.state}` }))} />
      </Field>
      {machines.error ? <Refusal error={machines.error} labels={refusalLabels(t)} compact /> : null}
      {chosen ? (
        <p className={css.formNote}>
          {free !== null ? t('freeDisk', { free: bytes(free), machine: chosen.name, size: bytes(s.size?.bytes ?? null) }) : t('freeUnknown', { machine: chosen.name })}
          {chosen.state !== 'running' ? ` ${t('notRunning', { machine: chosen.name, state: chosen.state })}` : ''}
        </p>
      ) : null}
      {chosen?.state === 'stopped' ? (
        <Button variant="outline" size="sm" className={css.selfStart} disabled={starting} icon={starting ? <StateDot state="ongoing" size={13} /> : undefined}
          onClick={() => { setStarting(true); api.call('POST', `/api/machines/${enc(chosen.name)}/start`).then(machines.reload, setStartError).finally(() => setStarting(false)) }}>
          {t('startMachine', { machine: chosen.name })}
        </Button>
      ) : null}
      {startError !== undefined ? <Refusal error={startError} labels={refusalLabels(t)} compact /> : null}
      {s.holders > 0 || sandboxes.length > 0 ? (
        <Notice tone="warning">
          <strong>{t('heldNow')}</strong>
          <span>{[s.holders > 0 && t('heldProcesses', { n: s.holders }), ...sandboxes.map((b) => t('heldSandbox', { name: b.name }))].filter(Boolean).join(' · ')}</span>
        </Notice>
      ) : null}
    </FormModal>
  )
}

// ---------- Back up ----------

function BackupDialog({ api, t, store: s, view, onClose, done }: { api: LayerfsApi, t: StorageT, store: StoreRow, view: StorageView | undefined, onClose: () => void, done: () => void }): ReactNode {
  const buckets = (view?.buckets ?? []).map((b) => b.name)
  const [bucket, setBucket] = useState(s.links[0]?.bucket ?? buckets[0] ?? '')
  const [file, setFile] = useState('')
  return (
    <FormModal open onClose={onClose} t={t} title={t('backupTitle', { store: s.name })} description={t('backupBody')} action={t('backup')} valid={!!bucket}
      submit={() => api.call('POST', `/api/stores/${enc(s.name)}/backup`, { bucket, ...(file.trim() ? { file: file.trim() } : {}) }).then(done)}>
      <Field label={t('bucket')} hint={buckets.length ? undefined : t('noBucketForRestore')}>
        <MenuSelect value={bucket} label={t('bucket')} placeholder={t('chooseBucket')} onChange={setBucket} options={buckets.map((n) => ({ value: n, label: n }))} />
      </Field>
      <TextField label={t('fileName')} value={file} onChange={setFile} mono placeholder={s.links.find((l) => l.bucket === bucket)?.file ?? s.name} hint={t('fileNameHint')} />
    </FormModal>
  )
}

// ---------- Restore ----------

/** Why backup.restore would refuse replacing `s` with the bucket's file, or null. */
function replaceRefusal(s: StoreRow, state: BackupState | undefined, bucket: string, t: StorageT): string | null {
  if (!inHome(s)) return t('replaceNotHome', { store: s.name, machine: s.machine ?? '?' })
  if (s.state !== 'idle' || s.job) return t('replaceNotIdle', { store: s.name })
  if (s.holders > 0) return t('replaceHeld', { store: s.name })
  if (!s.links.some((l) => l.bucket === bucket)) return t('replaceNoLink', { store: s.name, bucket })
  if (state === 'store_changed' || state === 'both_changed') return t('replaceChanged', { store: s.name, bucket })
  return null
}

function RestoreDialog({ api, t, dialog, view, onClose, done }: { api: LayerfsApi, t: StorageT, dialog: Extract<StorageDialog, { kind: 'restore' }>, view: StorageView | undefined, onClose: () => void, done: () => void }): ReactNode {
  const linked = dialog.store ? view?.stores.find((s) => s.name === dialog.store && s.kind === 'sqlite') : undefined
  const state = view?.buckets.find((b) => b.name === dialog.bucket)?.files?.find((f) => f.file === dialog.file && f.store === dialog.store)?.state
  const refusal = linked ? replaceRefusal(linked, state, dialog.bucket, t) : null
  const [mode, setMode] = useState<'new' | 'replace'>(linked && !refusal && state === 'bucket_changed' ? 'replace' : 'new')
  const [name, setName] = useState('')
  const taken = !!name.trim() && !!view?.stores.some((s) => s.name === name.trim())
  const replacing = mode === 'replace' && !!linked
  return (
    <FormModal open onClose={onClose} t={t} title={t('restoreTitle', { bucket: dialog.bucket, file: dialog.file })} description={t('restoreBody')}
      action={replacing ? t('restoreReplace', { store: linked!.name }) : t('restoreStore')}
      valid={replacing ? !refusal : NAME.test(name.trim()) && !taken}
      submit={() => api.call('POST', `/api/buckets/${enc(dialog.bucket)}/restore`, { store: replacing ? linked!.name : name.trim(), file: dialog.file }).then(done)}>
      {linked ? (
        <TileChoice label={t('restore')} value={mode} onChange={setMode} options={[
          { value: 'new', label: t('restoreAsNew'), body: t('restoreAsNewBody') },
          { value: 'replace', label: t('restoreReplace', { store: linked.name }), body: t('restoreReplaceBody', { store: linked.name }), disabled: refusal },
        ]} />
      ) : null}
      {replacing
        ? <Notice tone="warning">{t('restoreReplaceWarn', { store: linked!.name })}</Notice>
        : <TextField label={t('newStoreName')} value={name} onChange={setName} mono autoFocus placeholder={`${dialog.file}-restored`} error={taken ? t('nameTaken') : null} />}
    </FormModal>
  )
}

// ---------- Add bucket ----------

const ACCOUNT = /^[0-9a-f]{32}$/

function BucketDialog({ api, t, onClose, done }: { api: LayerfsApi, t: StorageT, onClose: () => void, done: () => void }): ReactNode {
  const [provider, setProvider] = useState<'minio' | 'r2'>('minio')
  const [v, setV] = useState<Record<string, string>>({ endpoint: 'http://localhost:9000', prefix: 'layerfs', jurisdiction: '' })
  const [keys, setKeys] = useState<'entered' | 'reference'>('entered')
  const set = (k: string) => (value: string) => setV((x) => ({ ...x, [k]: value }))
  const accountError = provider === 'r2' && v.account && !ACCOUNT.test(v.account.trim().toLowerCase()) ? t('accountInvalid') : null
  const keyError = keys === 'reference' && v.key && !REFERENCE.test(v.key.trim()) ? t('passwordInvalid') : null
  const missing = [
    !v.name?.trim() && t('name'),
    provider === 'minio' && !v.endpoint?.trim() && t('endpoint'),
    provider === 'r2' && !v.account?.trim() && t('account'),
    !v.bucket?.trim() && t('bucketName'),
    keys === 'reference' && !v.key?.trim() && t('keyReference'),
    keys === 'entered' && !v.accessKey?.trim() && t('accessKey'),
    keys === 'entered' && !v.secretKey && t('secretKey'),
  ].filter(Boolean) as string[]
  const body = () => ({
    name: v.name!.trim(),
    provider,
    ...(provider === 'minio' ? { endpoint: v.endpoint!.trim() } : { account: v.account!.trim().toLowerCase(), ...(v.jurisdiction ? { jurisdiction: v.jurisdiction } : {}) }),
    bucket: v.bucket!.trim(),
    ...(v.prefix?.trim() ? { prefix: v.prefix.trim() } : {}),
    ...(v.region?.trim() ? { region: v.region.trim() } : {}),
    ...(keys === 'reference' ? { key: v.key!.trim() } : { accessKey: v.accessKey!.trim(), secretKey: v.secretKey! }),
  })
  return (
    <FormModal open onClose={onClose} t={t} title={t('bucketTitle')} description={t('bucketBody')} action={t('connectBucket')}
      valid={!missing.length && !accountError && !keyError} hint={missing.length ? t('stillNeeded', { what: missing.join(', ') }) : undefined}
      submit={() => api.call('POST', '/api/buckets', body()).then(done)}>
      <TileChoice label={t('provider')} value={provider} onChange={setProvider}
        options={[{ value: 'minio', label: t('minio'), icon: <BucketProviderGlyph provider="minio" size={18} /> }, { value: 'r2', label: t('r2'), icon: <BucketProviderGlyph provider="r2" size={18} /> }]} />
      <div className={css.fieldRow}>
        <TextField label={t('name')} value={v.name ?? ''} onChange={set('name')} mono autoFocus placeholder="backups" />
        <TextField label={t('bucketName')} value={v.bucket ?? ''} onChange={set('bucket')} mono placeholder="layerfs-backups" />
      </div>
      {provider === 'minio'
        ? <TextField label={t('endpoint')} value={v.endpoint ?? ''} onChange={set('endpoint')} mono />
        : (
          <div className={css.fieldRow}>
            <TextField label={t('account')} value={v.account ?? ''} onChange={set('account')} mono error={accountError} />
            <Field label={t('jurisdiction')} className={css.fieldNarrow}>
              <MenuSelect value={v.jurisdiction ?? ''} label={t('jurisdiction')} onChange={set('jurisdiction')}
                options={[{ value: '', label: t('jurisdictionNone') }, { value: 'eu', label: 'EU' }, { value: 'fedramp', label: 'FedRAMP' }]} />
            </Field>
          </div>
        )}
      <div className={css.fieldRow}>
        <TextField label={t('prefix')} value={v.prefix ?? ''} onChange={set('prefix')} mono hint={t('objectNote', { prefix: v.prefix ? `${v.prefix}/` : '' })} />
        <TextField label={t('region')} value={v.region ?? ''} onChange={set('region')} mono />
      </div>
      <Field label={t('keysHow')}>
        <SegmentedControl<'entered' | 'reference'> id="lfs-bucket-keys" className={css.selfStart} value={keys} onChange={setKeys} label={t('keysHow')}
          options={[{ value: 'entered', label: t('keysEntered') }, { value: 'reference', label: t('keysReference') }]} />
      </Field>
      {keys === 'reference'
        ? <TextField label={t('keyReference')} value={v.key ?? ''} onChange={set('key')} mono placeholder="file:/Users/me/.config/layerfs/backups.keys" hint={t('keyReferenceHint')} error={keyError} />
        : (
          <>
            <div className={css.fieldRow}>
              <TextField label={t('accessKey')} value={v.accessKey ?? ''} onChange={set('accessKey')} mono />
              <TextField label={t('secretKey')} value={v.secretKey ?? ''} onChange={set('secretKey')} mono type="password" />
            </div>
            <p className={css.formNote}>{t('keysNote')}</p>
          </>
        )}
    </FormModal>
  )
}

// ---------- Confirm ----------

/** A destructive confirmation; with `name`, the name is typed to confirm. */
function ConfirmDialog({ t, title, body, action, name, onClose, run }: { t: StorageT, title: string, body: string, action: string, name?: string | undefined, onClose: () => void, run: () => Promise<unknown> }): ReactNode {
  const [typed, setTyped] = useState('')
  return (
    <FormModal open onClose={onClose} t={t} title={title} description={body} action={action} danger valid={!name || typed === name} submit={run}>
      {name ? <TextField label={t('typeToConfirm', { name })} value={typed} onChange={setTyped} mono autoFocus placeholder={name} /> : <span className={clsx(css.hidden)} />}
    </FormModal>
  )
}

