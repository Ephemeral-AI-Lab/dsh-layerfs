/** Storage's pure rules: placement, attention, backup coverage and job words. No React. */
import type { Tone } from '../ui/index.tsx'
import type { BackupState, BucketRow, JobKind, PgAttachment, StorageJob, StorageView, StoreBackupLink, StoreRow } from './types.ts'
import type { StorageT } from './locale.ts'

/** A sqlite Store saved under the LayerFS home (`native`). */
export const inHome = (s: StoreRow): boolean => s.kind === 'sqlite' && s.machine === 'native'

/** project.init goes into a Store on any machine, not while it is down or busy. */
export const canAddProject = (s: StoreRow): boolean => s.kind === 'postgresql' || (s.state !== 'down' && s.state !== 'busy')

const byName = (a: StoreRow, b: StoreRow) => a.name.localeCompare(b.name)

/** The board's order: the home's Stores, those on machines (by machine), then PostgreSQL. */
export function orderStores(stores: readonly StoreRow[]): StoreRow[] {
  const sqlite = stores.filter((s) => s.kind === 'sqlite').sort(byName)
  return [
    ...sqlite.filter(inHome),
    ...sqlite.filter((s) => !inHome(s)).sort((a, b) => (a.machine ?? '').localeCompare(b.machine ?? '') || byName(a, b)),
    ...stores.filter((s) => s.kind === 'postgresql').sort(byName),
  ]
}

/** Which group of the board a Store belongs to. */
export const groupOf = (s: StoreRow): 'home' | 'machines' | 'postgresql' => s.kind === 'postgresql' ? 'postgresql' : inHome(s) ? 'home' : 'machines'

/** The machines a sqlite Store can live on (native is the home), by name. */
export function machinePlaces(view: StorageView): StorageView['machines'] {
  return view.machines
    .filter((m) => m.name !== 'native' && m.supports?.sqlite !== false)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** A Store the explorer lets you drag to another place (the Store menu's move gating). */
export const canMove = (s: StoreRow): boolean =>
  s.kind === 'sqlite' && !s.job && (inHome(s) ? s.state === 'idle' : s.state !== 'busy')

/** A link's file as its bucket's last listing has it. */
export const listedOf = (s: StoreRow, bucket: string, file: string, buckets: readonly BucketRow[]) =>
  buckets.find((b) => b.name === bucket)?.files?.find((f) => f.file === file && f.store === s.name)

/** A link's last listed state, when its bucket was listed. */
export const linkState = (s: StoreRow, bucket: string, file: string, buckets: readonly BucketRow[]): BackupState | undefined => listedOf(s, bucket, file, buckets)?.state

/** A tree row's status dot and the words that explain it. */
export interface RowSignal { state: 'error' | 'warning' | 'ongoing', reason: string }

const SIGNAL_RANK: Record<RowSignal['state'], number> = { ongoing: 1, warning: 2, error: 3 }

/** The most urgent of some rows' signals: what a collapsed parent shows. */
export function worstSignal(signals: readonly (RowSignal | null | undefined)[]): RowSignal | null {
  return signals.reduce<RowSignal | null>((w, s) => (s && (!w || SIGNAL_RANK[s.state] > SIGNAL_RANK[w.state]) ? s : w), null)
}

/** How much a Store needs you, and why: its running or failed job first, then its own state, its backups, its machine. */
export function storeSignal(s: StoreRow, job: StorageJob | undefined, machineState: string | null | undefined, buckets: readonly BucketRow[], t: StorageT): RowSignal | null {
  if (job && !job.ended) return { state: 'ongoing', reason: doingWords(job, t) }
  if (job?.error) return { state: 'error', reason: endedWords(job, t) }
  if (s.state === 'down') return { state: 'error', reason: s.down ? `${t('stateDown')}: ${s.down}` : t('stateDown') }
  if (s.state === 'unresolved') return { state: 'error', reason: t('unresolved') }
  if (s.postgresql?.reachable === false) return { state: 'error', reason: s.postgresql.error ?? t('unreachable') }
  const links = s.links.map((l) => ({ l, state: linkState(s, l.bucket, l.file, buckets) }))
  const linkReason = (x: typeof links[number]) => `${x.l.bucket}/${x.l.file}: ${backupChip(x.state, t).label}`
  const broken = links.find((x) => x.state === 'both_changed' || x.state === 'missing')
  if (broken) return { state: 'error', reason: linkReason(broken) }
  const drifted = links.find((x) => x.state === 'store_changed' || x.state === 'bucket_changed')
  if (drifted) return { state: 'warning', reason: linkReason(drifted) }
  if (machineState === 'stopped' && s.machine) return { state: 'warning', reason: t('machineStopped', { machine: s.machine }) }
  return null
}

/** A bucket's signal: the most urgent state among its listed files. */
export function bucketSignal(rows: readonly BucketFileRow[], t: StorageT): RowSignal | null {
  return worstSignal(rows.map((r) => {
    const chip = backupChip(r.state, t)
    const state = chip.tone === 'danger' ? 'error' : chip.tone === 'warning' ? 'warning' : null
    return state ? { state, reason: `${r.file}: ${chip.label}` } : null
  }))
}

/** A Store's SDK state as a chip tone. */
export function storeTone(state: string): Tone {
  if (state === 'idle') return 'success'
  if (state === 'in_use') return 'info'
  if (state === 'busy') return 'warning'
  if (state === 'down' || state === 'unresolved') return 'danger'
  return 'neutral'
}

/** A Store's state in words. */
export function storeStateWords(state: string, t: StorageT): string {
  switch (state) {
    case 'idle': return t('stateIdle')
    case 'in_use': return t('stateInUse')
    case 'busy': return t('stateBusy')
    case 'down': return t('stateDown')
    case 'unresolved': return t('stateUnresolved')
    default: return state
  }
}

/** A backup file's state: its tone and words. */
export function backupChip(state: BackupState | null | undefined, t: StorageT): { tone: Tone, label: string, dashed?: boolean } {
  switch (state) {
    case 'current': return { tone: 'success', label: t('backupCurrent') }
    case 'store_changed': return { tone: 'warning', label: t('backupStoreChanged') }
    case 'bucket_changed': return { tone: 'warning', label: t('backupBucketChanged') }
    case 'both_changed': return { tone: 'danger', label: t('backupBothChanged') }
    case 'unlinked': return { tone: 'neutral', label: t('backupUnlinked') }
    case 'missing': return { tone: 'danger', label: t('backupMissing') }
    case 'unknown': return { tone: 'neutral', label: t('backupUnknown'), dashed: true }
    default: return { tone: 'neutral', label: t('backupNotListed'), dashed: true }
  }
}

/** The newest backup time a Store's links recorded. */
export const latestBackup = (s: StoreRow): number | null =>
  s.links.reduce<number | null>((n, l) => (l.last?.at != null && (n === null || l.last.at > n) ? l.last.at : n), null)

/** Backup coverage of the SQLite Stores. */
export function coverageOf(view: StorageView) {
  const sqlite = view.stores.filter((s) => s.kind === 'sqlite')
  const backed = sqlite.filter((s) => s.links.length > 0)
  const latest = backed.map(latestBackup).filter((n): n is number => n !== null)
  return { sqlite, backed, never: sqlite.filter((s) => s.links.length === 0), oldest: latest.length ? Math.min(...latest) : null }
}

/** Where a Store is, in words: the home, a machine, or PostgreSQL. */
export const placeWords = (machine: string | null | undefined, t: StorageT): string => (machine === 'native' ? t('home') : (machine ?? '?'))

/** One file a bucket holds: the file, the Store it belongs to, its last listed state. */
export interface BucketFileRow {
  file: string
  store: StoreRow | null
  storeName: string | null
  state: BackupState | null
  bytes: number | null
  modified: number | null
  reason: string | null
  link: StoreBackupLink | null
}

/** A bucket's files: its listing when it was listed, else the Stores' links alone. */
export function bucketFiles(b: BucketRow, stores: readonly StoreRow[]): BucketFileRow[] {
  const byName = new Map(stores.map((s) => [s.name, s]))
  const linkOf = (s: StoreRow | undefined, file: string) => s?.links.find((l) => l.bucket === b.name && l.file === file) ?? null
  const rows: BucketFileRow[] = b.files
    ? b.files.map((f) => ({ file: f.file, store: (f.store && byName.get(f.store)) || null, storeName: f.store, state: f.state, bytes: f.bytes, modified: f.modified, reason: f.reason, link: linkOf(f.store ? byName.get(f.store) : undefined, f.file) }))
    : stores.flatMap((s) => s.links.filter((l) => l.bucket === b.name).map((l) => ({ file: l.file, store: s, storeName: s.name, state: null, bytes: l.last?.bytes ?? null, modified: null, reason: null, link: l })))
  return rows.sort((x, y) => x.file.localeCompare(y.file) || (x.storeName ?? '').localeCompare(y.storeName ?? ''))
}

// ---------- jobs ----------

/** The phases each call reports, in order. */
export const STEPS: Record<JobKind, readonly string[]> = {
  push: ['check', 'snapshot', 'send', 'verify', 'install', 'record', 'retire'],
  pull: ['check', 'snapshot', 'send', 'verify', 'install', 'record', 'retire'],
  move: ['check', 'snapshot', 'send', 'verify', 'install', 'record', 'retire'],
  backup: ['check', 'snapshot', 'send', 'check', 'hash', 'upload'],
  restore: ['check', 'download', 'verify', 'install'],
}

export type StepState = 'done' | 'now' | 'failed' | 'todo'

/** One run of a call's steps with each step's state. */
export function stepsOf(j: StorageJob): { step: string, state: StepState }[] {
  const seen = j.phases?.filter((p) => p.half === (j.half ?? null)).map((p) => p.phase)
  const steps = seen?.length ? seen : [...STEPS[j.kind], ...(!STEPS[j.kind].includes(j.phase ?? '') && j.phase ? [j.phase] : [])]
  const ok = j.ended !== null && j.error === null
  const at = j.error ? steps.lastIndexOf(j.error.phase ?? '') : j.phase ? steps.lastIndexOf(j.phase) : j.ended ? -1 : 0
  return steps.map((step, i) => ({ step, state: ok || i < at ? 'done' : i === at ? (j.error ? 'failed' : 'now') : 'todo' }))
}

/** A running job's share done: its steps, and inside the current step its bytes. */
export function shareOf(j: StorageJob): number {
  if (j.ended) return 1
  const steps = stepsOf(j)
  const at = Math.max(0, steps.findIndex((s) => s.state === 'now'))
  const inner = j.total ? Math.min(1, Math.max(0, (j.done ?? 0) / j.total)) : 0
  const half = j.kind === 'move' ? (j.half === 'push' ? 1 : 0) : 0
  const runs = j.kind === 'move' ? 2 : 1
  return (half + (at + inner) / Math.max(1, steps.length)) / runs
}

/** A step in words. */
export function stepWords(step: string | null, t: StorageT): string {
  switch (step) {
    case 'check': return t('stepCheck')
    case 'snapshot': return t('stepSnapshot')
    case 'send': return t('stepSend')
    case 'verify': return t('stepVerify')
    case 'install': return t('stepInstall')
    case 'record': return t('stepRecord')
    case 'retire': return t('stepRetire')
    case 'upload': return t('stepUpload')
    case 'download': return t('stepDownload')
    case 'hash': return t('stepHash')
    case null: return t('stepStarting')
    default: return step
  }
}

/** What a running job does, in words. */
export function doingWords(j: StorageJob, t: StorageT): string {
  switch (j.kind) {
    case 'push': return t('jobPushing', { place: placeWords(j.target, t) })
    case 'pull': return t('jobPulling', { place: placeWords(j.from, t) })
    case 'move': return t('jobMoving', { place: placeWords(j.target, t) })
    case 'backup': return t('jobBackingUp', { place: j.target })
    case 'restore': return t('jobRestoring', { place: j.file ? `${j.target}/${j.file}` : j.target })
  }
}

/** How a job ended, in words. */
export function endedWords(j: StorageJob, t: StorageT): string {
  if (j.summary) return j.summary
  if (j.outcome === 'unknown') return t('jobUnknown')
  if (j.outcome === 'interrupted') return t('jobInterrupted')
  const place = j.kind === 'pull' ? placeWords(j.from, t) : j.kind === 'backup' || j.kind === 'restore' ? j.target : placeWords(j.target, t)
  if (j.error) return t('jobFailed', { what: kindWords(j.kind, t), place, phase: j.error.phase ?? '—' })
  switch (j.kind) {
    case 'push': return t('jobPushed', { place })
    case 'pull': return t('jobPulled', { place })
    case 'move': return t('jobMoved', { place })
    case 'backup': return t('jobBackedUp', { place })
    case 'restore': return t('jobRestored', { place })
  }
}

/** A job kind as a noun. */
export function kindWords(kind: JobKind, t: StorageT): string {
  switch (kind) {
    case 'push': return t('kindPush')
    case 'pull': return t('kindPull')
    case 'move': return t('kindMove')
    case 'backup': return t('kindBackup')
    case 'restore': return t('kindRestore')
  }
}

/** How long a job that ended well stays on its Store. */
export const SHOW_DONE_MS = 60_000

/** The job a Store shows: running, else its newest ended job while it failed (until dismissed) or ended well a minute ago. */
export function cardJob(jobs: readonly StorageJob[], store: string, dismissed: ReadonlySet<string>, now: number): StorageJob | undefined {
  const mine = jobs.filter((j) => j.store === store)
  const running = mine.find((j) => !j.ended)
  if (running) return running
  const last = mine.filter((j) => j.ended).sort((a, b) => b.ended! - a.ended!)[0]
  if (!last || dismissed.has(last.id)) return undefined
  return last.error || now - last.ended! < SHOW_DONE_MS ? last : undefined
}

/** How many jobs run, and how many failed and are not dismissed. */
export function jobCounts(jobs: readonly StorageJob[], dismissed: ReadonlySet<string>) {
  const latest = new Map<string, StorageJob>()
  for (const j of jobs) if (!latest.has(j.store) || j.started > latest.get(j.store)!.started) latest.set(j.store, j)
  const last = [...latest.values()]
  return { running: last.filter((j) => !j.ended).length, failed: last.filter((j) => j.ended && j.error && !dismissed.has(j.id)).length }
}

// ---------- PostgreSQL machines (store.attach) ----------


/**
 * A PostgreSQL Store's machines. Without store.attach in the pinned CLI (or
 * from a record before attachments) its Sandboxes run on the LayerFS Home,
 * shown as one unchecked attachment.
 */
export function attachmentsOf(s: StoreRow): PgAttachment[] {
  if (s.kind !== 'postgresql') return []
  if (s.attachments) return s.attachments
  return [{ machine: 'native', own: false, url: null, target: s.postgresql?.target ?? null, password: null, saved: false, checked: null, lastError: null }]
}

/** The PostgreSQL Stores attached to `machine`, with their attachment. */
export function pgStoresOn(view: StorageView, machine: string): { store: StoreRow, attachment: PgAttachment }[] {
  return view.stores.filter((s) => s.kind === 'postgresql').flatMap((store) => {
    const attachment = attachmentsOf(store).find((a) => a.machine === machine)
    return attachment ? [{ store, attachment }] : []
  }).sort((a, b) => a.store.name.localeCompare(b.store.name))
}

/** An attachment's dot: its last refusal, else not checked yet. */
export function attachmentSignal(a: PgAttachment, t: StorageT): RowSignal | null {
  if (a.lastError) return { state: 'error', reason: `${t('checkFailed')}: ${a.lastError.message}` }
  if (!a.checked) return { state: 'warning', reason: t('notChecked') }
  return null
}

/** What a machine of `platform` dials for a server on this host's localhost (LayerFS's reach rewrite). */
export function loopbackAlias(platform: string): string | null {
  switch (platform) {
    case 'docker': return 'host.docker.internal'
    case 'lima': return '192.168.5.2'
    case 'apple-container': return '192.168.64.1'
    default: return null
  }
}

/** Why `machine` cannot take PostgreSQL Store `s` now, or null when it can. */
export function attachRefusal(view: StorageView, s: StoreRow, machine: string, t: StorageT): string | null {
  const m = view.machines.find((x) => x.name === machine)
  if (!m) return null
  if (attachmentsOf(s).some((a) => a.machine === machine)) return t('alreadyAttached')
  if (m.supports && !m.supports.postgresql_sandbox) return m.supports.reason ?? t('postgresql')
  if (m.state === 'stopped') return t('machineStoppedAttach')
  return null
}
