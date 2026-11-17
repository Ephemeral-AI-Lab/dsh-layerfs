/**
 * Storage's dialogs: one small form per action. A PostgreSQL password or a
 * bucket's keys are either a reference (env:… or file:/path) or typed here;
 * a typed secret goes to the host, which keeps it in an owner-only file and
 * gives LayerFS that file's reference.
 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Checkbox, SegmentedControl, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import { bytes } from '../files/format.ts'
import { useQuery } from '../files/use-query.ts'
import { Field, MenuSelect, Notice, Refusal } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { canMove, inHome, runsOnOf } from './model.ts'
import { BucketProviderGlyph } from '../machines/icons.tsx'
import { LocationPicker, placeName, stoppedPicked } from '../projects/setup/MachineTiles.tsx'
import { defaultMachine, isRunning, machinesFor } from '../projects/setup/model.ts'
import { placeStore, startMachine, waitJob } from '../projects/setup/run.ts'
import { FormModal, locationWords, refusalLabels, StoreGlyph, TextField, TileChoice } from './parts.tsx'
import type { BackupState, MachinesView, ProjectInitJob, StorageJob, StorageView, StoreRow } from './types.ts'
import { ConnectDatabaseDialog } from './ConnectDatabase.tsx'
import { PG_URL_PASSWORD, PgPasswordFields, usePgPassword } from './pg-fields.tsx'
import { BackUpDialog, BackupsDialog } from './BackupDialogs.tsx'
import css from './Storage.module.css'

const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/
const REFERENCE = /^(env:LAYERFS_[A-Z0-9_]+|file:\/.+)$/

/** Which dialog is open, and on what. */
export type StorageDialog =
  | { kind: 'new-store' }
  /**
   * Connect a database (ConnectDatabase.tsx), the one PostgreSQL connect dialog. `machine`: a machine page's
   * (new databases run on it); `server`: open on a new database on that server (`host:port`); `check`: open
   * on the check of a Store from a machine (where it runs unless named).
   */
  | { kind: 'connect', machine?: string, server?: string, check?: { store: string, machine?: string } }
  /** Edit a PostgreSQL Store's connection, or (`machine`) that machine's own. */
  | { kind: 'pg-edit', store: string, machine?: string }
  /** Choose the machine a PostgreSQL Store's sessions run on. */
  | { kind: 'pg-runs-on', store: string }
  | { kind: 'add-project', store: string }
  | { kind: 'push', store: StoreRow }
  | { kind: 'to-machine', machine: string }
  | { kind: 'move', store: StoreRow }
  /** `known`: the buckets when Add a bucket left Back up, so it comes back on the new one; `pick`: the bucket it starts on. */
  | { kind: 'backup', store: StoreRow, known?: string[], pick?: string }
  | { kind: 'backups', store: string }
  | { kind: 'restore', bucket: string, file: string, store?: string | null }
  /** `then`: the dialog Add a bucket returns to, closed or saved. */
  | { kind: 'bucket', then?: StorageDialog }
  | { kind: 'confirm', title: string, body: string, action: string, name?: string, force?: ConfirmForce, run: (force: boolean) => Promise<unknown> }

/** An optional Force checkbox on a confirm: checked, the action runs with force and reads `action`. */
export interface ConfirmForce { label: string, action: string }

interface DialogsProps {
  api: LayerfsApi
  t: StorageT
  dialog: StorageDialog | null
  view: StorageView | undefined
  onClose: () => void
  /** The view changed: read it again. */
  done: () => void
  /** Swaps this dialog for another (Add Store's New Store and Connect a database). */
  onDialog?: (dialog: StorageDialog) => void
}

/** The open dialog, if any. */
export function StorageDialogs({ api, t, dialog, view, onClose, done, onDialog }: DialogsProps): ReactNode {
  if (!dialog) return null
  const after = <T,>(p: Promise<T>) => p.then((v) => { done(); return v })
  switch (dialog.kind) {
    case 'new-store': return <NewStoreDialog api={api} t={t} view={view} onClose={onClose} done={done} onDialog={onDialog} />
    case 'connect': return <ConnectDatabaseDialog api={api} t={t} view={view} machine={dialog.machine} server={dialog.server} check={dialog.check} onClose={onClose} done={done} />
    case 'pg-edit': return <EditConnectionDialog api={api} t={t} view={view} store={dialog.store} machine={dialog.machine} onClose={onClose} done={done} />
    case 'pg-runs-on': return <RunsOnDialog api={api} t={t} view={view} store={dialog.store} onClose={onClose} done={done} />
    case 'add-project': return <NewProjectDialog api={api} t={t} store={dialog.store} onClose={onClose} done={done} />
    case 'push':
    case 'move': return <PlaceDialog api={api} t={t} kind={dialog.kind} store={dialog.store} onClose={onClose} done={done} />
    case 'to-machine': return <ToMachineDialog api={api} t={t} view={view} machine={dialog.machine} onClose={onClose} done={done} onDialog={onDialog} />
    case 'backup': return <BackUpDialog api={api} t={t} store={dialog.store} known={dialog.known} pick={dialog.pick} view={view} onClose={onClose} done={done} onDialog={onDialog} />
    case 'backups': return <BackupsDialog api={api} t={t} store={dialog.store} view={view} onClose={onClose} done={done} onDialog={onDialog} />
    case 'restore': return <RestoreDialog api={api} t={t} dialog={dialog} view={view} onClose={onClose} done={done} />
    case 'bucket': return <BucketDialog api={api} t={t} onClose={dialog.then && onDialog ? () => onDialog(dialog.then!) : onClose} done={done} />
    case 'confirm': return <ConfirmDialog t={t} title={dialog.title} body={dialog.body} action={dialog.action} name={dialog.name} force={dialog.force} onClose={onClose} run={(force) => after(dialog.run(force))} />
  }
}

// ---------- New Store ----------

type NewPane = 'empty' | 'restore'

/** A new SQLite Store, empty or restored from a bucket. PostgreSQL goes on to Connect a database. */
function NewStoreDialog({ api, t, view, onClose, done, onDialog }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, onClose: () => void, done: () => void
  onDialog?: ((dialog: StorageDialog) => void) | undefined
}): ReactNode {
  const [pane, setPane] = useState<NewPane>('empty')
  const [name, setName] = useState('')
  const buckets = view?.buckets ?? []
  const [bucket, setBucket] = useState(buckets[0]?.name ?? '')
  const [file, setFile] = useState('')
  const [listing, setListing] = useState(false)
  const [listError, setListError] = useState<unknown>(undefined)
  // Where the new Store lives. LayerFS makes it in the home; another machine is a move after.
  const machines = machinesFor(view, 'sqlite')
  const fallback = defaultMachine(machines)
  const [placeChoice, setPlace] = useState<string | null>(null)
  const place = placeChoice ?? fallback
  const words = locationWords(t, view)
  const where = placeName(place, words)
  /** A Store this dialog made whose move failed: a retry only finishes that. */
  const [made, setMade] = useState<string | null>(null)
  const [stage, setStage] = useState<string | undefined>(undefined)
  const chosen = buckets.find((b) => b.name === bucket)
  const files = chosen?.files ? [...new Set(chosen.files.map((f) => f.file))].map((f) => ({ file: f, bytes: chosen.files!.find((x) => x.file === f)?.bytes ?? null, stores: chosen.files!.filter((x) => x.file === f && x.store).map((x) => x.store!) })) : null
  const taken = !!name.trim() && name.trim() !== made && !!view?.stores.some((s) => s.name === name.trim())
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
  ].filter(Boolean) as string[]
  /** Make the Store in the home, then (another machine) start it if stopped and move the Store there. */
  const placed = async (make: () => Promise<unknown>, making: string) => {
    const store = name.trim()
    if (made !== store) {
      setStage(making)
      const result = await make()
      if (place === 'native') return
      // a restore is a job: the Store is there once it ends
      if (result && typeof result === 'object' && 'id' in result && 'ended' in result) await waitJob(api, result as StorageJob)
      setMade(store)
      done()
    }
    if (!isRunning(view?.machines.find((m) => m.name === place))) {
      setStage(t('nsStarting', { machine: where }))
      await startMachine(api, place)
    }
    setStage(t('nsPlacing', { store, machine: where }))
    await placeStore(api, store, place)
    setMade(null)
  }
  const moveOnly = made !== null && made === name.trim() && place !== 'native'
  const form = {
    empty: {
      action: moveOnly ? t('nsMoveTo', { machine: where }) : t('createStore'), description: t('newStoreEmptyBody'),
      submit: () => placed(() => api.call('POST', '/api/stores', { name: name.trim() }), t('nsCreating', { store: name.trim() })),
    },
    restore: {
      action: moveOnly ? t('nsMoveTo', { machine: where }) : t('restoreStore'), description: t('newStoreRestoreBody'),
      submit: () => placed(() => api.call('POST', `/api/buckets/${enc(bucket)}/restore`, { store: name.trim(), file }), t('nsRestoring', { store: name.trim() })),
    },
  }[pane]
  // The name's rule shows only once a typed name breaks it.
  const nameError = taken ? t('nameTaken') : name.trim() && !NAME.test(name.trim()) ? t('storeNameHint') : null
  return (
    <FormModal open onClose={onClose} t={t} title={t('newStore')} description={form.description} action={form.action}
      valid={!missing.length && nameOk} hint={missing.length ? t('stillNeeded', { what: missing.join(', ') }) : undefined}
      busyHint={stage}
      submit={() => form.submit().then(done)}>
      {/* a PostgreSQL Store is connected, not made: its tile opens Connect a database */}
      {onDialog ? (
        <TileChoice label={t('kindOfStore')} value="sqlite" onChange={(v) => { if (v === 'postgresql') { onClose(); onDialog({ kind: 'connect' }) } }}
          options={[{ value: 'sqlite', label: t('sqlite'), icon: <StoreGlyph kind="sqlite" /> }, { value: 'postgresql', label: t('postgresql'), icon: <StoreGlyph kind="postgresql" /> }]} />
      ) : null}
      <SegmentedControl<NewPane> id="lfs-new-store-sqlite" className={css.selfStart} value={pane} onChange={setPane} label={t('sqlite')}
        options={[{ value: 'empty', label: t('storeEmpty') }, { value: 'restore', label: t('storeRestore') }]} />
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
      <TextField label={pane === 'restore' ? t('newStoreName') : t('name')} value={name} onChange={setName} mono autoFocus={pane !== 'restore'} placeholder="work" error={nameError} />
      <Field label={t('nsLocation')} hint={t('nsLocationHint')} group>
        <LocationPicker machines={machines} value={place} onChange={setPlace} words={words} label={t('nsLocation')} fallback={fallback} compact />
      </Field>
      {stoppedPicked([place], machines).map((m) => <p key={m} className={css.formNote}>{t('nsStartsOnCreate', { machine: m })}</p>)}
      {moveOnly ? <p className={css.formNote}>{t('nsMade', { store: made, machine: where })}</p> : null}
    </FormModal>
  )
}

// ---------- PostgreSQL: edit a connection, choose where it runs ----------

/**
 * Edit a PostgreSQL Store's connection (store.update): its URL, its password
 * and its synchronous_commit. With `machine`, that machine's own connection
 * instead (a URL, a password, or both), which LayerFS checks from the machine
 * before it saves anything. Only what changed is sent; a password not given
 * again stays as it is. A refusal stays under the form.
 */
function EditConnectionDialog({ api, t, view, store, machine, onClose, done }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, store: string, machine?: string | undefined, onClose: () => void, done: () => void
}): ReactNode {
  const s = view?.stores.find((x) => x.name === store)
  const own = machine ? s?.ownConnections?.find((c) => c.machine === machine) : undefined
  const before = machine ? own?.url ?? '' : s?.postgresql?.url ?? ''
  const [url, setUrl] = useState(before)
  // a reference given before is shown again; a typed one stays in its file unless a new one is typed
  const givenRef = (machine ? own?.password : s?.postgresql?.password) ?? ''
  const pw = usePgPassword(givenRef ? 'reference' : 'entered', givenRef)
  const syncBefore = s?.postgresql?.synchronousCommit ?? ''
  const [sync, setSync] = useState(syncBefore)
  if (!s || !view) return null
  const place = machine === 'native' ? t('layerfsHome') : machine
  const urlChanged = url.trim() !== before && !!url.trim()
  const pwChanged = !pw.missing && !(pw.how === 'reference' && pw.ref.trim() === givenRef)
  const syncChanged = !machine && !!sync && sync !== syncBefore
  const urlError = PG_URL_PASSWORD.test(url.trim()) ? t('pgPasswordInUrl') : null
  const body = () => ({
    ...(machine ? { machine } : {}), ...(urlChanged ? { url: url.trim() } : {}), ...(pwChanged ? pw.body() : {}), ...(syncChanged ? { synchronousCommit: sync } : {}),
  })
  return (
    <FormModal open onClose={onClose} t={t} title={machine ? t('pgEditOwnTitle', { store, machine: place ?? '' }) : t('pgEditTitle', { store })}
      description={machine ? t('pgEditOwnBody', { machine: place ?? '' }) : t('pgEditBody')} action={machine ? t('cdSaveAndCheck') : t('save')}
      valid={(urlChanged || pwChanged || syncChanged) && !urlError && !pw.error(t) && (!!machine || !!url.trim())}
      hint={!urlChanged && !pwChanged && !syncChanged ? t('pgEditNothing') : undefined}
      busyHint={machine ? t('checkingFrom', { machine: place ?? '' }) : undefined}
      submit={() => api.call('POST', `/api/stores/${enc(store)}/connection`, body()).then(done)}>
      {machine ? <p className={css.formNote}>{t('pgOwnNote', { machine: place ?? '', target: s.postgresql?.target ?? '' })}</p> : null}
      <TextField label={machine ? t('cdOwnUrl', { machine: place ?? '' }) : t('pgUrl')} value={url} onChange={setUrl} mono placeholder="postgresql://user@host:5432/db"
        hint={machine ? t('pgUrlHint') : undefined} error={urlError} autoFocus />
      <PgPasswordFields id="lfs-pg-edit-password" pw={pw} t={t} />
      {(machine ? own?.saved : s.postgresql?.saved) && pw.missing ? <p className={css.formNote}>{t('pgPasswordKept')}</p> : null}
      {machine ? null : (
        <Field label={t('syncCommit')}>
          <MenuSelect value={sync} label={t('syncCommit')} placeholder={t('syncCommitDefault')}
            options={['off', 'local', 'remote_write', 'on', 'remote_apply'].map((v) => ({ value: v, label: v }))} onChange={setSync} />
        </Field>
      )}
    </FormModal>
  )
}

/** Where a PostgreSQL Store's sessions run: one machine, the plugin's own choice (LayerFS records none). */
function RunsOnDialog({ api, t, view, store, onClose, done }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, store: string, onClose: () => void, done: () => void
}): ReactNode {
  const s = view?.stores.find((x) => x.name === store)
  const current = s ? runsOnOf(s) : 'native'
  const [picked, setPicked] = useState<string | null>(null)
  if (!s || !view) return null
  const machines = machinesFor(view, 'postgresql')
  const chosen = picked ?? current
  const words = locationWords(t, view)
  return (
    <FormModal open onClose={onClose} t={t} title={t('pgRunsOnTitle', { store })} description={t('pgRunsOnBody')}
      action={t('pgRunsOnSave', { machine: placeName(chosen, words) })} valid={chosen !== current}
      submit={() => api.call('POST', `/api/stores/${enc(store)}/runs-on`, { machine: chosen }).then(done)}>
      <Field label={t('pgRunsOnLabel')} hint={t('pgRunsOnHint')} group>
        <LocationPicker machines={machines} value={chosen} onChange={setPicked} words={words} label={t('pgRunsOnLabel')} current={current} compact />
      </Field>
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

// ---------- Add a Store to a machine ----------

/**
 * A machine's Add Store. A SQLite Store lives on one machine, so adding one
 * here moves it from where it is (the host's place: push, pull or move, as a
 * drop on the machine does); the home also offers a new one. A PostgreSQL
 * Store is on no machine: its tile goes on to Connect a database, where one
 * is connected, or one already connected is set to run here.
 */
function ToMachineDialog({ api, t, view, machine, onClose, done, onDialog }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, machine: string
  onClose: () => void, done: () => void, onDialog?: ((dialog: StorageDialog) => void) | undefined
}): ReactNode {
  const m = view?.machines.find((x) => x.name === machine)
  const noSqlite = m?.supports && m.supports.sqlite === false ? m.supports.reason || t('noStoresHere') : null
  const noPg = m?.supports && !m.supports.postgresql_sandbox ? m.supports.reason || t('postgresql') : null
  const [chosen, setChosen] = useState('')
  if (!view) return null
  const placeName = (name: string | null) => (name === 'native' ? t('layerfsHome') : name ?? '')
  const rows = view.stores
    .filter((s) => s.kind === 'sqlite' && s.machine !== machine)
    .map((s) => ({ s, why: noSqlite ?? (canMove(s) ? null : t('storeBusyNow')) }))
    .sort((a, b) => Number(!!a.why) - Number(!!b.why) || a.s.name.localeCompare(b.s.name))
  const pick = rows.find((r) => r.s.name === chosen && !r.why)
  const swap = (next: StorageDialog) => { onClose(); onDialog?.(next) }
  return (
    <FormModal open onClose={onClose} t={t} title={t('addStoreTitle', { machine: placeName(machine) })}
      description={t('addSqliteBody')} action={t('moveHere')} valid={!!pick}
      busyHint={pick ? t('movingFrom', { store: pick.s.name, from: placeName(pick.s.machine) }) : undefined}
      submit={async () => {
        if (!pick) return
        await api.call('POST', `/api/machines/${enc(machine)}/stores`, { store: pick.s.name })
        done()
      }}>
      {onDialog ? (
        <TileChoice label={t('kindOfStore')} value="sqlite" onChange={(v) => { if (v === 'postgresql') swap({ kind: 'connect', machine }) }}
          options={[
            { value: 'sqlite', label: t('sqlite'), body: t('addSqliteTile'), icon: <StoreGlyph kind="sqlite" />, disabled: noSqlite },
            { value: 'postgresql', label: t('postgresql'), body: t('addPgTile'), icon: <StoreGlyph kind="postgresql" />, disabled: noPg },
          ]} />
      ) : null}
      <div className={css.choiceList} role="radiogroup" aria-label={t('sqlite')}>
        {rows.length ? rows.map(({ s, why }) => (
          <button key={s.name} type="button" role="radio" aria-checked={chosen === s.name} disabled={!!why} className={css.choiceRow}
            data-checked={chosen === s.name || undefined} onClick={() => setChosen(s.name)} title={why ?? undefined}>
            <span className={css.radio} aria-hidden="true" />
            <span className={css.choiceMain}>{s.name}</span>
            <span className={css.choiceMeta}>{why ?? t('fromPlace', { place: placeName(s.machine) })}</span>
          </button>
        )) : <p className={css.choiceEmpty}>{t('addSqliteNone', { machine: placeName(machine) })}</p>}
      </div>
      {pick && m?.state && m.state !== 'running' ? <p className={css.formNote}>{t('notRunning', { machine: placeName(machine), state: m.state })}</p> : null}
      {onDialog && machine === 'native' ? (
        <p className={css.formNote}>
          <button type="button" className={css.textLink} onClick={() => swap({ kind: 'new-store' })}>{t('newStore')}</button>
        </p>
      ) : null}
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
function ConfirmDialog({ t, title, body, action, name, force, onClose, run }: {
  t: StorageT, title: string, body: string, action: string, name?: string | undefined, force?: ConfirmForce | undefined, onClose: () => void, run: (force: boolean) => Promise<unknown>
}): ReactNode {
  const [typed, setTyped] = useState('')
  const [forced, setForced] = useState(false)
  const on = !!force && forced
  return (
    <FormModal open onClose={onClose} t={t} title={title} description={body} action={on ? force.action : action} danger valid={!name || typed === name} submit={() => run(on)}>
      {name ? <TextField label={t('typeToConfirm', { name })} value={typed} onChange={setTyped} mono autoFocus placeholder={name} /> : null}
      {force ? <Checkbox checked={forced} onChange={setForced} label={force.label} /> : null}
      {!name && !force ? <span className={clsx(css.hidden)} /> : null}
    </FormModal>
  )
}

