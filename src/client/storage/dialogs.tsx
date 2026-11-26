/**
 * Storage's dialogs: one small form per action. A PostgreSQL password or a
 * bucket's secret key is typed here and goes to LayerFS on stdin through the
 * host, which never keeps or answers it. PostgreSQL's own dialogs (Connect,
 * Edit connection, the attach picker) are in PgDialogs.tsx.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { StatusDot } from '../ui/StatusDot.tsx'
import { enc, type LayerfsApi } from '../api.ts'
import { bytes } from '../files/format.ts'
import { useQuery } from '../files/use-query.ts'
import { ConfirmDialog as SharedConfirmDialog, Contained, Field, MenuSelect, Notice, Refusal } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { backupStateOf, bucketParts, canMove, diskFit, inHome, listStatusWords, reconnectOf, storeStateWords, storeWaitsFor, type BackupState, type Reconnect } from './model.ts'
import { BucketProviderGlyph } from '../machines/icons.tsx'
import { LocationPicker, StartFirst } from '../projects/setup/MachineTiles.tsx'
import { defaultMachine, machinesFor, stoppedOf } from '../projects/setup/model.ts'
import { placeStore, startMachine, waitJob } from '../projects/setup/run.ts'
import { Signal } from './Signal.tsx'
import { FormModal, locationWords, refusalLabels, StoreGlyph, TextField, TileChoice } from './parts.tsx'
import type { MachinesView, ProjectInitJob, StorageJob, StorageView, StoreRow } from './types.ts'
import { AttachPicker, ConnectDialog, EditConnectionDialog } from './PgDialogs.tsx'
import { BackUpDialog, BackupsDialog } from './BackupDialogs.tsx'
import css from './Storage.module.css'

const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/

/** Which dialog is open, and on what. */
export type StorageDialog =
  | { kind: 'new-store', machine?: string | undefined, pane?: 'empty' | 'restore' | undefined }
  /** Connect a database: a new PostgreSQL Store (PgDialogs.tsx). */
  | { kind: 'connect' }
  /** Edit a PostgreSQL Store's saved connection. */
  | { kind: 'pg-edit', store: string }
  /** The attach picker: machines for a Store (`store`), or Stores for a machine (`machine`). */
  | { kind: 'attach', store?: string, machine?: string }
  | { kind: 'add-project', store: string }
  | { kind: 'push', store: StoreRow }
  | { kind: 'to-machine', machine: string }
  | { kind: 'move', store: StoreRow }
  /** `known`: the buckets when Add a bucket left Back up, so it comes back on the new one; `pick`: the bucket it starts on. */
  | { kind: 'backup', store: StoreRow, known?: string[], pick?: string }
  | { kind: 'backups', store: string }
  | { kind: 'restore', bucket: string, file: string, store?: string | null }
  /** `then`: the dialog Add a bucket returns to, closed or saved; `again`: Connect again… on a bucket whose key was refused (its name, and its URL when LayerFS's fix names it). */
  | { kind: 'bucket', then?: StorageDialog, again?: Reconnect }
  /** `plain`: the action removes nothing, so its button is not the danger one (Compact). */
  /** `steps`: what the confirm runs, listed in order (a fix chain); `cancelled`: it was closed without confirming. */
  | { kind: 'confirm', title: string, body: string, action: string, name?: string, force?: ConfirmForce, plain?: boolean, steps?: string[], cancelled?: () => void, run: (force: boolean) => Promise<unknown> }

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
export function StorageDialogs(props: DialogsProps): ReactNode {
  // a press inside the dialog stays there: it never reaches the page row or card under it through the portal (UI pass 3 F6)
  return props.dialog ? <Contained><OpenDialog {...props} /></Contained> : null
}

function OpenDialog({ api, t, dialog, view, onClose, done, onDialog }: DialogsProps): ReactNode {
  if (!dialog) return null
  const after = <T,>(p: Promise<T>) => p.then((v) => { done(); return v })
  switch (dialog.kind) {
    case 'new-store': return <NewStoreDialog api={api} t={t} view={view} opened={dialog.machine} initialPane={dialog.pane} onClose={onClose} done={done} onDialog={onDialog} />
    case 'connect': return <ConnectDialog api={api} t={t} view={view} onClose={onClose} done={done} />
    case 'pg-edit': return <EditConnectionDialog api={api} t={t} view={view} store={dialog.store} onClose={onClose} done={done} />
    case 'attach': return (
      <AttachPicker api={api} t={t} view={view} store={dialog.store} machine={dialog.machine} onClose={onClose} done={done} />
    )
    case 'add-project': return <NewProjectDialog api={api} t={t} store={dialog.store} onClose={onClose} done={done} />
    case 'push':
    case 'move': return <PlaceDialog api={api} t={t} kind={dialog.kind} store={dialog.store} onClose={onClose} done={done} />
    case 'to-machine': return <ToMachineDialog api={api} t={t} view={view} machine={dialog.machine} onClose={onClose} done={done} onDialog={onDialog} />
    case 'backup': return <BackUpDialog api={api} t={t} store={dialog.store} known={dialog.known} pick={dialog.pick} view={view} onClose={onClose} done={done} onDialog={onDialog} />
    case 'backups': return <BackupsDialog api={api} t={t} store={dialog.store} view={view} onClose={onClose} done={done} onDialog={onDialog} />
    case 'restore': return <RestoreDialog api={api} t={t} dialog={dialog} view={view} onClose={onClose} done={done} />
    case 'bucket': return <BucketDialog api={api} t={t} again={dialog.again} onClose={dialog.then && onDialog ? () => onDialog(dialog.then!) : onClose} done={done} />
    case 'confirm': return <ConfirmDialog t={t} title={dialog.title} body={dialog.body} action={dialog.action} name={dialog.name} force={dialog.force} plain={dialog.plain} steps={dialog.steps}
      onClose={() => { dialog.cancelled?.(); onClose() }} run={(force) => after(dialog.run(force))} />
  }
}

// ---------- New Store ----------

type NewPane = 'empty' | 'restore'

/** A new SQLite Store, empty or restored from a bucket. PostgreSQL goes on to Connect a database. */
function NewStoreDialog({ api, t, view, opened, initialPane, onClose, done, onDialog }: {
  api: LayerfsApi, t: StorageT, view: StorageView | undefined, onClose: () => void, done: () => void
  /** The machine whose page opened the dialog: the default place when it runs and is not broken. */
  opened?: string | undefined
  initialPane?: NewPane | undefined
  onDialog?: ((dialog: StorageDialog) => void) | undefined
}): ReactNode {
  const [pane, setPane] = useState<NewPane>(initialPane ?? 'empty')
  const [name, setName] = useState('')
  const buckets = view?.buckets ?? []
  const [bucketChoice, setBucket] = useState(buckets[0]?.name ?? '')
  const bucket = bucketChoice && buckets.some((b) => b.name === bucketChoice) ? bucketChoice : (buckets[0]?.name ?? '')
  const [pickedFile, setPickedFile] = useState<{ bucket: string, file: string } | null>(null)
  const file = pickedFile && pickedFile.bucket === bucket ? pickedFile.file : ''
  const [listingBucket, setListingBucket] = useState<string | null>(null)
  const listing = listingBucket === bucket
  const [listError, setListError] = useState<{ bucket: string, code: string, message: string } | null>(null)
  const bucketRef = useRef(bucket)
  bucketRef.current = bucket
  const listSeq = useRef(0)
  const autoListed = useRef(new Set<string>())
  // Where the new Store lives. LayerFS makes it in the home; another machine is a move after.
  const machines = machinesFor(view, 'sqlite')
  // never a broken machine or one Create would start: such a machine is the person's pick, its start named (StartFirst)
  const fallback = defaultMachine(machines, undefined, opened)
  const [placeChoice, setPlace] = useState<string | null>(null)
  const place = placeChoice ?? fallback
  const words = locationWords(t, view)
  const where = place
  /** A Store this dialog made whose move failed: a retry only finishes that. */
  const [made, setMade] = useState<string | null>(null)
  const [stage, setStage] = useState<string | undefined>(undefined)
  const chosen = buckets.find((b) => b.name === bucket)
  const present = chosen?.files ? chosen.files.filter((f) => !f.missing) : null
  const files = present ? [...new Set(present.map((f) => f.file))].map((f) => ({ file: f, bytes: present.find((x) => x.file === f)?.bytes ?? null, stores: present.filter((x) => x.file === f && x.store).map((x) => x.store!) })) : null
  const taken = !!name.trim() && name.trim() !== made && !!view?.stores.some((s) => s.name === name.trim())
  const list = async (targetBucket = bucket) => {
    if (!targetBucket) return
    const seq = ++listSeq.current
    setListingBucket(targetBucket)
    setListError((prev) => (prev?.bucket === targetBucket ? null : prev))
    try {
      const res = await api.call<{ error?: { code?: string, message?: string } | null }>('GET', `/api/buckets/${enc(targetBucket)}/files`)
      if (bucketRef.current === targetBucket && listSeq.current === seq && res?.error) {
        setListError({ bucket: targetBucket, code: res.error.code ?? 'Failed', message: res.error.message ?? res.error.code ?? 'Failed' })
      }
    } catch (e: any) {
      if (bucketRef.current === targetBucket && listSeq.current === seq) {
        setListError({ bucket: targetBucket, code: e?.code ?? 'Failed', message: e?.message ?? String(e) })
      }
    } finally {
      setListingBucket((cur) => (cur === targetBucket ? null : cur))
      done()
    }
  }
  useEffect(() => {
    setPickedFile((prev) => (prev && prev.bucket !== bucket ? null : prev))
    setListError((prev) => (prev && prev.bucket !== bucket ? null : prev))
  }, [bucket])
  useEffect(() => {
    if (pane !== 'restore' || !chosen || chosen.files !== null || chosen.error || listingBucket === chosen.name) return
    if (autoListed.current.has(chosen.name)) return
    autoListed.current.add(chosen.name)
    void list(chosen.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane, chosen?.name, chosen?.files, chosen?.error])
  const choose = (f: string) => {
    setPickedFile({ bucket, file: f })
    const base = f.replace(/\.[^.]+$/, '')
    setName(view?.stores.some((s) => s.name === base) ? `${base}-restored` : base)
  }
  const scopedError = listError && listError.bucket === bucket ? listError : null
  const activeError = scopedError ?? chosen?.error ?? null
  const again = chosen && activeError ? reconnectOf({ ...chosen, error: activeError }) : null
  const nameOk = NAME.test(name.trim()) && !taken
  const missing = [
    !name.trim() && t('name'),
    pane === 'restore' && !bucket && t('bucket'),
    pane === 'restore' && !file && t('storeFile'),
  ].filter(Boolean) as string[]
  /** Make the Store in the home, then (another machine) move the Store there; a stopped machine is started first by its own Start, never here. */
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
    setStage(t('nsPlacing', { store, machine: where }))
    await placeStore(api, store, place, true)
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
  // the machine the Store goes to, when it is not running: started only by its own Start below
  const stopped = stoppedOf([place], view)
  // The name's rule shows only once a typed name breaks it.
  const nameError = taken ? t('nameTaken') : name.trim() && !NAME.test(name.trim()) ? t('storeNameHint') : null
  const noBuckets = pane === 'restore' && buckets.length === 0
  return (
    <FormModal open onClose={onClose} t={t} title={t('newStore')} description={form.description} action={form.action}
      valid={!noBuckets && !missing.length && nameOk && stopped.length === 0} hint={!noBuckets && missing.length ? t('stillNeeded', { what: missing.join(', ') }) : undefined}
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
        noBuckets ? (
          <Notice>
            <span>{t('noBucketForRestore')}</span>
            {onDialog ? (
              <Button type="button" variant="outline" size="sm" className={css.selfStart}
                onClick={() => onDialog({ kind: 'bucket', then: { kind: 'new-store', machine: opened, pane: 'restore' } })}>
                {t('addBucketEllipsis')}
              </Button>
            ) : null}
          </Notice>
        ) : (
          <>
            <Field label={t('bucket')}>
              <div className={css.inline}>
                <MenuSelect value={bucket} label={t('bucket')} placeholder={t('chooseBucket')} className={css.grow}
                  options={buckets.map((b) => ({ value: b.name, label: b.name }))} onChange={(v) => { setBucket(v); setPickedFile(null); setListError(null) }} />
                <Button variant="outline" size="sm" disabled={!bucket || listing} onClick={() => { void list() }}
                  icon={listing ? <StatusDot state="ongoing" size={13} /> : undefined}>{chosen?.files !== null ? t('listAgain') : t('listBucket')}</Button>
              </div>
            </Field>
            {activeError ? (
              <div className={css.bucketStatus} data-tone="danger" role="alert">
                <Signal state="error" size={7} title={listStatusWords(activeError.code, t)} detail={activeError.message} />
                {again && onDialog ? <Button type="button" size="sm" variant="outline" onClick={() => onDialog({ kind: 'bucket', again, then: { kind: 'new-store', machine: opened, pane: 'restore' } })}>{t('connectAgain')}</Button> : null}
              </div>
            ) : null}
            {activeError && chosen?.files === null && !listing ? null : (
              <div className={css.choiceList} role="radiogroup" aria-label={t('storeFile')}>
                {listing && !files?.length
                  ? <p className={css.choiceEmpty}>{t('bucketListingNow', { bucket })}</p>
                  : chosen?.files === null
                    ? <p className={css.choiceEmpty}>{t('bucketNotListedYet', { bucket })}</p>
                    : !files?.length
                      ? <p className={css.choiceEmpty}>{t('noFilesListed', { bucket })}</p>
                      : files.map((f) => (
                        <button key={f.file} type="button" role="radio" aria-checked={file === f.file} className={css.choiceRow} data-checked={file === f.file || undefined} onClick={() => choose(f.file)}>
                          <span className={css.radio} aria-hidden="true" />
                          <span className={css.choiceMain}>{f.file}</span>
                          {f.stores.length ? <span className={css.choiceMeta}>{f.stores.join(', ')}</span> : null}
                          <span className={css.choiceMeta}>{bytes(f.bytes)}</span>
                        </button>
                      ))}
              </div>
            )}
          </>
        )
      ) : null}
      {!noBuckets ? (
        <>
          <TextField label={pane === 'restore' ? t('newStoreName') : t('name')} value={name} onChange={setName} mono autoFocus={pane !== 'restore'} placeholder={pane === 'restore' ? (file ? `${file}-restored` : t('restorePlaceholder')) : 'work'} error={nameError} />
          <Field label={t('nsLocation')} hint={t('nsLocationHint')} group>
            <LocationPicker machines={machines} value={place} onChange={setPlace} words={words} label={t('nsLocation')} fallback={fallback} compact />
          </Field>
          {/* creating starts no machine: a stopped one has its own Start here */}
          <StartFirst names={stopped} start={(m) => startMachine(api, m)} onStarted={done}
            words={{ stopped: (machine) => t('nsStoppedFirst', { machine }), start: (machine) => t('startMachine', { machine }), refused: (machine) => t('nsStartRefused', { machine }) }} />
          {moveOnly ? <p className={css.formNote}>{t('nsMade', { store: made, machine: where })}</p> : null}
        </>
      ) : null}
    </FormModal>
  )
}

// ---------- PostgreSQL: edit a connection, choose where it runs ----------

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
          <StatusDot state="ongoing" size={13} />
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
  const view = machines.data?.available ? machines.data : null
  const targets = (view?.machines ?? []).filter((m) => m.name !== 'native' && m.name !== s.machine && (!m.supports || m.supports.includes('sqlite')))
  const chosen = targets.find((m) => m.name === target)
  const free = chosen ? view?.live[chosen.name]?.freeDisk ?? null : null
  const fit = chosen ? diskFit(free, s.size?.bytes ?? null) : null
  const sandboxes = (view?.sandboxes ?? []).filter((b) => b.project?.startsWith(`${s.name}/`) && b.state !== 'gone')
  const push = kind === 'push'
  const stopped = chosen?.state === 'stopped' ? [chosen.name] : []
  const targetNotReady = !!chosen && chosen.state !== 'ready'
  const held = sandboxes.length > 0
  const tooLarge = fit?.state === 'full'
  const valid = !!chosen && !targetNotReady && !tooLarge && !held
  const hint = held ? t('pushHintHeld')
    : stopped.length ? t('compactNeedsMachine', { machine: chosen!.name })
      : targetNotReady ? t('pushHintMachineNotReady', { machine: chosen!.name, state: storeStateWords(chosen!.state, t) })
        : tooLarge ? t('pushHintNoSpace', { machine: chosen!.name })
          : undefined
  return (
    <FormModal open onClose={onClose} t={t} title={push ? t('pushTitle', { store: s.name }) : t('moveTitle', { store: s.name })}
      description={push ? t('pushBody', { n: s.projects.length }) : t('moveBody')} action={push ? t('push') : t('move')} valid={valid} hint={hint}
      submit={() => api.call('POST', `/api/stores/${enc(s.name)}/${kind}`, { machine: target }).then(done)}>
      <Field label={t('machine')} hint={machines.loading && !view ? t('readingMachines') : targets.length ? undefined : t('noTargets')}>
        <MenuSelect value={target} label={t('machine')} placeholder={t('chooseMachine')} onChange={setTarget}
          options={targets.map((m) => ({ value: m.name, label: `${m.name} · ${m.platform} · ${storeStateWords(m.state ?? 'unknown', t)}` }))} />
      </Field>
      {machines.error ? <Refusal error={machines.error} labels={refusalLabels(t)} compact /> : null}
      {chosen && fit?.state === 'full' ? (
        <Notice tone="danger" role="alert">
          <strong>{t('diskNotEnoughTitle', { machine: chosen.name })}</strong>
          <span>{t('diskNotEnoughBody', { free: bytes(fit.free), store: s.name, size: bytes(fit.need), short: bytes(fit.shortBy) })}</span>
        </Notice>
      ) : chosen && fit?.state === 'tight' ? (
        <Notice tone="warning">
          <strong>{t('diskTightTitle', { machine: chosen.name })}</strong>
          <span>{t('diskTightBody', { free: bytes(fit.free), size: bytes(fit.need) })}</span>
        </Notice>
      ) : chosen ? (
        <p className={css.formNote}>
          {free !== null ? t('freeDisk', { free: bytes(free), machine: chosen.name, size: bytes(s.size?.bytes ?? null) }) : t('freeUnknown', { machine: chosen.name })}
        </p>
      ) : null}
      {stopped.length ? (
        <StartFirst names={stopped} start={(m) => startMachine(api, m)} onStarted={() => { machines.reload(); done() }}
          words={{ stopped: (machine) => t('nsStoppedFirst', { machine }), start: (machine) => t('startMachine', { machine }), refused: (machine) => t('nsStartRefused', { machine }) }} />
      ) : targetNotReady ? (
        <Notice tone="danger" role="alert">{t('notRunning', { machine: chosen!.name, state: storeStateWords(chosen!.state, t) })}</Notice>
      ) : null}
      {held ? (
        <Notice tone="warning">
          <strong>{t('heldNow')}</strong>
          <span>{sandboxes.map((b) => t('heldSandbox', { name: b.name })).join(' · ')}</span>
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
  const machines = useQuery(() => api.call<MachinesView>('GET', '/api/machines'), [api])
  const liveView = machines.data?.available ? machines.data : null
  const liveMachine = liveView?.machines.find((x) => x.name === machine)
  const viewMachine = view?.machines.find((x) => x.name === machine)
  const m = liveMachine ?? viewMachine
  const supports = (cap: string) =>
    (!viewMachine?.supports || viewMachine.supports.includes(cap)) &&
    (!liveMachine?.supports || liveMachine.supports.includes(cap))
  const noSqlite = !supports('sqlite') ? t('msNoSqlite') : null
  const noPg = !supports('postgresql_sandbox') ? t('msNoPostgresql') : null
  const [chosen, setChosen] = useState('')
  if (!view) return null
  const placeName = (name: string | null) => name ?? ''
  const rows = view.stores
    .filter((s) => s.kind === 'sqlite' && s.machine !== machine)
    .map((s) => ({ s, why: noSqlite ?? (canMove(s) ? null : (storeWaitsFor(s, t) ?? t('storeBusyNow'))) }))
    .sort((a, b) => Number(!!a.why) - Number(!!b.why) || a.s.name.localeCompare(b.s.name))
  const pick = rows.find((r) => r.s.name === chosen && !r.why)
  const free = liveView?.live[machine]?.freeDisk ?? null
  const fit = pick ? diskFit(free, pick.s.size?.bytes ?? null) : null
  const sandboxes = pick ? (liveView?.sandboxes ?? []).filter((b) => b.project?.startsWith(`${pick.s.name}/`) && b.state !== 'gone') : []
  const mState = m?.state ?? 'ready'
  const stopped = machine !== 'native' && mState === 'stopped' ? [machine] : []
  const targetNotReady = machine !== 'native' && mState !== 'ready'
  const held = sandboxes.length > 0
  const tooLarge = fit?.state === 'full'
  const crossMachine = !!pick && pick.s.machine !== 'native' && machine !== 'native'
  const valid = !!pick && !targetNotReady && !tooLarge && !held
  const hint = held ? t('pushHintHeld')
    : stopped.length ? t('compactNeedsMachine', { machine: placeName(machine) })
      : targetNotReady ? t('pushHintMachineNotReady', { machine: placeName(machine), state: storeStateWords(mState, t) })
        : tooLarge ? t('pushHintNoSpace', { machine: placeName(machine) })
          : noSqlite ?? undefined
  const swap = (next: StorageDialog) => { onClose(); onDialog?.(next) }
  return (
    <FormModal open onClose={onClose} t={t} title={t('addStoreTitle', { machine: placeName(machine) })}
      description={t('addSqliteBody')} action={t('moveHere')} valid={valid} hint={hint}
      busyHint={pick ? t('movingFrom', { store: pick.s.name, from: placeName(pick.s.machine) }) : undefined}
      submit={async () => {
        if (!pick) return
        await api.call('POST', `/api/machines/${enc(machine)}/stores`, { store: pick.s.name })
        done()
      }}>
      {onDialog ? (
        <TileChoice label={t('kindOfStore')} value="sqlite" onChange={(v) => { if (v === 'postgresql') swap({ kind: 'attach', machine }) }}
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
            <span className={css.choiceMeta}>
              {why ?? [s.size ? bytes(s.size.bytes) : null, t('fromPlace', { place: placeName(s.machine) })].filter(Boolean).join(' · ')}
            </span>
          </button>
        )) : <p className={css.choiceEmpty}>{t('addSqliteNone', { machine: placeName(machine) })}</p>}
      </div>
      {machines.error ? <Refusal error={machines.error} labels={refusalLabels(t)} compact /> : null}
      {pick && fit?.state === 'full' ? (
        <Notice tone="danger" role="alert">
          <strong>{t('diskNotEnoughTitle', { machine: placeName(machine) })}</strong>
          <span>{t('diskNotEnoughBody', { free: bytes(fit.free), store: pick.s.name, size: bytes(fit.need), short: bytes(fit.shortBy) })}</span>
        </Notice>
      ) : pick && fit?.state === 'tight' ? (
        <Notice tone="warning">
          <strong>{t('diskTightTitle', { machine: placeName(machine) })}</strong>
          <span>{t('diskTightBody', { free: bytes(fit.free), size: bytes(fit.need) })}</span>
        </Notice>
      ) : pick && free !== null ? (
        <p className={css.formNote}>{t('freeDisk', { free: bytes(free), machine: placeName(machine), size: bytes(pick.s.size?.bytes ?? null) })}</p>
      ) : pick && machine !== 'native' && !stopped.length && machines.data ? (
        <p className={css.formNote}>{t('freeUnknown', { machine: placeName(machine) })}</p>
      ) : null}
      {crossMachine ? <p className={css.formNote}>{t('moveBody')}</p> : null}
      {stopped.length ? (
        <StartFirst names={stopped} start={(name) => startMachine(api, name)} onStarted={() => { machines.reload(); done() }}
          words={{ stopped: (name) => t('nsStoppedFirst', { machine: name }), start: (name) => t('startMachine', { machine: name }), refused: (name) => t('nsStartRefused', { machine: name }) }} />
      ) : targetNotReady ? (
        <Notice tone="danger" role="alert">{t('notRunning', { machine: placeName(machine), state: storeStateWords(mState, t) })}</Notice>
      ) : null}
      {held ? (
        <Notice tone="warning">
          <strong>{t('heldNow')}</strong>
          <span>{sandboxes.map((b) => t('heldSandbox', { name: b.name })).join(' · ')}</span>
        </Notice>
      ) : null}
      {onDialog && machine === 'native' ? (
        <p className={css.formNote}>
          {t('addStoreOrNew')}{' '}
          <button type="button" className={css.textLink} onClick={() => swap({ kind: 'new-store', machine })}>{t('newStore')}</button>
        </p>
      ) : null}
    </FormModal>
  )
}

// ---------- Restore ----------

export interface ReplaceContext {
  listed: boolean
  bucketError?: { code: string, message: string } | null | undefined
  file?: string | undefined
  heldBy?: readonly string[] | undefined
}

/** Why backup.restore would refuse replacing `s` with the bucket's file, or null. */
export function replaceRefusal(
  s: StoreRow,
  state: BackupState | undefined,
  bucket: string,
  t: StorageT,
  ctx: ReplaceContext = { listed: state !== undefined },
): string | null {
  if (!inHome(s)) return t('replaceNotHome', { store: s.name, machine: s.machine ?? '?' })
  if (s.state !== 'ready' || s.job) {
    if (s.state === 'busy' || s.job) return t('replaceBusy', { store: s.name })
    const why = storeWaitsFor(s, t)
    return why ? t('replaceNotIdle', { store: s.name, why }) : t('replaceBusy', { store: s.name })
  }
  if (ctx.heldBy?.length) {
    return t('replaceInUse', { store: s.name, sandboxes: ctx.heldBy.map((name) => t('heldSandbox', { name })).join(' · ') })
  }
  if (!s.links.some((l) => l.bucket === bucket)) return t('replaceNoLink', { store: s.name, bucket })
  if (ctx.bucketError) return t('replaceListFailed', { bucket, status: listStatusWords(ctx.bucketError.code, t), store: s.name })
  if (!ctx.listed) return t('replaceNotListed', { bucket, store: s.name })
  if (state === 'missing') return t('replaceMissing', { bucket, file: ctx.file ?? s.name })
  if (state === 'unknown' || state === undefined) return t('replaceUnknown', { store: s.name })
  if (state === 'store_changed' || state === 'both_changed') return t('replaceChanged', { store: s.name, bucket })
  return null
}

function RestoreDialog({ api, t, dialog, view, onClose, done }: { api: LayerfsApi, t: StorageT, dialog: Extract<StorageDialog, { kind: 'restore' }>, view: StorageView | undefined, onClose: () => void, done: () => void }): ReactNode {
  const machines = useQuery(() => api.call<MachinesView>('GET', '/api/machines'), [api], { cache: 'GET /api/machines' })
  const linked = dialog.store ? view?.stores.find((s) => s.name === dialog.store && s.kind === 'sqlite') : undefined
  const bucketRow = view?.buckets.find((b) => b.name === dialog.bucket)
  const listed = bucketRow?.files !== null && bucketRow?.files !== undefined
  const entry = bucketRow?.files?.find((f) => f.file === dialog.file && f.store === dialog.store)
  const state = backupStateOf(entry) ?? undefined
  const fleet = machines.data?.available ? machines.data : null
  const heldBy = linked
    ? (fleet?.sandboxes ?? []).filter((b) => b.project?.startsWith(`${linked.name}/`) && b.state !== 'gone').map((b) => b.name)
    : []
  const refusal = linked ? replaceRefusal(linked, state, dialog.bucket, t, { listed, bucketError: bucketRow?.error, file: dialog.file, heldBy }) : null
  const [mode, setMode] = useState<'new' | 'replace'>(linked && !refusal && state === 'bucket_changed' ? 'replace' : 'new')
  const [name, setName] = useState('')
  const [listing, setListing] = useState(false)
  const taken = !!name.trim() && !!view?.stores.some((s) => s.name === name.trim())
  const nameError = taken ? t('nameTaken') : name.trim() && !NAME.test(name.trim()) ? t('storeNameHint') : null
  const replacing = mode === 'replace' && !!linked && !refusal
  const listNow = async () => {
    setListing(true)
    try { await api.call('GET', `/api/buckets/${enc(dialog.bucket)}/files`) } finally { setListing(false); done() }
  }
  return (
    <FormModal open onClose={onClose} t={t} title={t('restoreTitle', { bucket: dialog.bucket, file: dialog.file })} description={t('restoreBody')}
      action={replacing ? t('restoreReplace', { store: linked!.name }) : t('restoreStore')}
      valid={replacing ? !refusal : NAME.test(name.trim()) && !taken}
      hint={!replacing && !name.trim() ? t('stillNeeded', { what: t('newStoreName') }) : undefined}
      submit={() => api.call('POST', `/api/buckets/${enc(dialog.bucket)}/restore`, { store: replacing ? linked!.name : name.trim(), file: dialog.file }).then(done)}>
      {linked ? (
        <TileChoice label={t('restore')} value={replacing ? 'replace' : 'new'} onChange={setMode} options={[
          { value: 'new', label: t('restoreAsNew'), body: t('restoreAsNewBody') },
          { value: 'replace', label: t('restoreReplace', { store: linked.name }), body: t('restoreReplaceBody', { store: linked.name }), disabled: refusal },
        ]} />
      ) : null}
      {linked && (!listed || !!bucketRow?.error) ? (
        <Button type="button" variant="outline" size="sm" className={css.selfStart} disabled={listing}
          icon={listing ? <StatusDot state="ongoing" size={12} /> : undefined} onClick={() => { void listNow() }}>
          {bucketRow?.error ? t('listAgain') : t('listBucket')}
        </Button>
      ) : null}
      {replacing
        ? <Notice tone="warning">{t('restoreReplaceWarn', { store: linked!.name })}</Notice>
        : <TextField label={t('newStoreName')} value={name} onChange={setName} mono autoFocus placeholder={`${dialog.file}-restored`} error={nameError} />}
    </FormModal>
  )
}

// ---------- Add bucket ----------

const ACCOUNT = /^[0-9a-f]{32}$/

/** The Connect dialog's first values: empty, or (Connect again…) the bucket's name and the parts of the URL LayerFS's fix names. */
export function bucketDraft(again?: Reconnect): { provider: 'minio' | 'r2', values: Record<string, string> } {
  const blank = { endpoint: 'http://localhost:9000', prefix: 'layerfs', jurisdiction: '' }
  if (!again) return { provider: 'minio', values: blank }
  const parts = bucketParts(again.url)
  const provider = parts?.provider ?? (again.provider === 'r2' ? 'r2' : 'minio')
  if (!parts) return { provider, values: { ...blank, ...(provider === 'r2' ? { endpoint: '' } : {}), name: again.bucket } }
  return {
    provider,
    values: { name: again.bucket, bucket: parts.bucket, prefix: parts.prefix, jurisdiction: parts.jurisdiction ?? '', endpoint: parts.endpoint ?? '', account: parts.account ?? '' },
  }
}

/** What a bucket connect did, from LayerFS's long form: `rotated` (the same name and URL: key replaced, links kept), else null. */
export function connectOutcome(answer: unknown): 'rotated' | null {
  return (answer as { outcome?: unknown } | null)?.outcome === 'rotated' ? 'rotated' : null
}

/** Add a bucket, or connect one again (the same URL replaces its key, spec v21; connecting again is a change, so it is listed once more). */
function BucketDialog({ api, t, again, onClose, done }: { api: LayerfsApi, t: StorageT, again?: Reconnect | undefined, onClose: () => void, done: () => void }): ReactNode {
  const [draft] = useState(() => bucketDraft(again))
  /** LayerFS answered `rotated`: the dialog stays to say so, and its action closes it. */
  const [rotated, setRotated] = useState(false)
  const [provider, setProvider] = useState<'minio' | 'r2'>(draft.provider)
  const [v, setV] = useState<Record<string, string>>(draft.values)
  const set = (k: string) => (value: string) => setV((x) => ({ ...x, [k]: value }))
  const trimmedName = v.name?.trim() ?? ''
  const nameError = !again && trimmedName && !NAME.test(trimmedName) ? t('bucketNameHint') : null
  const endpointError = provider === 'minio' && v.endpoint?.trim() && !/^https?:\/\//.test(v.endpoint.trim()) ? t('endpointInvalid') : null
  const accountError = provider === 'r2' && v.account && !ACCOUNT.test(v.account.trim().toLowerCase()) ? t('accountInvalid') : null
  const accessError = v.accessKey?.trim() && /\s/.test(v.accessKey.trim()) ? t('keysNoSpaces') : null
  const secretError = v.secretKey && /\s/.test(v.secretKey.trim()) ? t('keysNoSpaces') : null
  const fieldError = nameError || endpointError || accountError || accessError || secretError
  const cleanPrefix = (v.prefix ?? '').trim().replace(/^\/+|\/+$/g, '')
  const hasAddress = !!again && !!(provider === 'minio' ? v.endpoint?.trim() && v.bucket?.trim() : v.account?.trim() && v.bucket?.trim())
  const missing = [
    !trimmedName && t('name'),
    provider === 'minio' && !v.endpoint?.trim() && t('endpoint'),
    provider === 'r2' && !v.account?.trim() && t('account'),
    !v.bucket?.trim() && t('bucketName'),
    !v.accessKey?.trim() && t('accessKey'),
    !v.secretKey && t('secretKey'),
  ].filter(Boolean) as string[]
  const body = () => ({
    name: again ? again.bucket : trimmedName,
    provider,
    ...(provider === 'minio' ? { endpoint: v.endpoint!.trim() } : { account: v.account!.trim().toLowerCase(), ...(v.jurisdiction ? { jurisdiction: v.jurisdiction } : {}) }),
    bucket: v.bucket!.trim(),
    ...(cleanPrefix ? { prefix: cleanPrefix } : {}),
    accessKey: v.accessKey!.trim(), secretKey: v.secretKey!,
  })
  return (
    <FormModal open onClose={onClose} t={t} title={again ? t('reconnectTitle', { bucket: again.bucket }) : t('bucketTitle')} description={again ? t('reconnectBody') : t('bucketBody')}
      action={rotated ? t('close') : again ? t('reconnectAction') : t('connectBucket')} keepOpen hideCancel={rotated}
      valid={rotated || (!missing.length && !fieldError)} hint={!rotated && missing.length ? t('stillNeeded', { what: missing.join(', ') }) : undefined}
      submit={async () => {
        if (rotated) { onClose(); return }
        const payload = body()
        const answer = await api.call<{ outcome?: unknown }>('POST', '/api/buckets', payload)
        if (again || connectOutcome(answer) === 'rotated') await api.call('GET', `/api/buckets/${enc(payload.name)}/files`).catch(() => null)
        done()
        if (connectOutcome(answer) === 'rotated') setRotated(true)
        else onClose()
      }}>
      {rotated ? (
        <div className={css.bucketStatus} data-tone="ok" data-rotated role="status">
          <div className={css.bucketStatusStack}>
            <Signal state="ok" size={7} title={t('keyRotated')} detail={t('keyRotatedTip')} />
            <span className={css.bucketStatusDetailWrap}>{t('keyRotatedTip')}</span>
          </div>
        </div>
      ) : (
        <>
          <TileChoice label={t('provider')} value={provider} onChange={setProvider}
            options={[{ value: 'minio', label: t('minio'), icon: <BucketProviderGlyph provider="minio" size={18} /> }, { value: 'r2', label: t('r2'), icon: <BucketProviderGlyph provider="r2" size={18} /> }]} />
          <div className={css.fieldRow}>
            <TextField label={t('name')} value={v.name ?? ''} onChange={set('name')} mono autoFocus={!again} disabled={!!again} placeholder="backups" error={nameError} />
            <TextField label={t('bucketName')} value={v.bucket ?? ''} onChange={set('bucket')} mono autoFocus={!!again && !hasAddress} placeholder="layerfs-backups" />
          </div>
          {provider === 'minio'
            ? <TextField label={t('endpoint')} value={v.endpoint ?? ''} onChange={set('endpoint')} mono placeholder="http://localhost:9000" error={endpointError} />
            : (
              <div className={css.fieldRow}>
                <TextField label={t('account')} value={v.account ?? ''} onChange={set('account')} mono placeholder={t('accountPlaceholder')} error={accountError} />
                <Field label={t('jurisdiction')} className={css.fieldNarrow}>
                  <MenuSelect value={v.jurisdiction ?? ''} label={t('jurisdiction')} onChange={set('jurisdiction')}
                    options={[{ value: '', label: t('jurisdictionNone') }, { value: 'eu', label: 'EU' }, { value: 'fedramp', label: 'FedRAMP' }]} />
                </Field>
              </div>
            )}
          <TextField label={t('prefix')} value={v.prefix ?? ''} onChange={set('prefix')} mono hint={t('objectNote', { prefix: cleanPrefix ? `${cleanPrefix}/` : '' })} />
          <div className={css.fieldRow}>
            <TextField label={t('accessKey')} value={v.accessKey ?? ''} onChange={set('accessKey')} mono autoFocus={hasAddress} error={accessError} />
            <TextField label={t('secretKey')} value={v.secretKey ?? ''} onChange={set('secretKey')} mono type="password" error={secretError} />
          </div>
          <p className={css.formNote}>{t('keysNote')}</p>
        </>
      )}
    </FormModal>
  )
}

// ---------- Confirm ----------

/** A destructive confirmation; with `name`, the name is typed to confirm. */
function ConfirmDialog({ t, title, body, action, name, force, plain, steps, onClose, run }: {
  t: StorageT, title: string, body: string, action: string, name?: string | undefined, force?: ConfirmForce | undefined, plain?: boolean | undefined, steps?: string[] | undefined, onClose: () => void, run: (force: boolean) => Promise<unknown>
}): ReactNode {
  return (
    <SharedConfirmDialog
      onClose={onClose}
      title={title}
      body={body}
      action={action}
      name={name}
      force={force}
      plain={plain}
      steps={steps}
      labels={{ cancel: t('cancel'), close: t('close'), typeToConfirm: name ? t('typeToConfirm', { name }) : undefined, refusal: refusalLabels(t) }}
      run={run}
    />
  )
}

