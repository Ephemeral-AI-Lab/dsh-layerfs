/** Storage's pure rules: placement, attention and job words. No React. */
import type { Tone } from '../ui/index.tsx'
import type { BackupFile, BucketRow, JobKind, PgConnection, StorageJob, StorageView, StoreBackupLink, StoreRow } from './types.ts'
import type { StorageKey, StorageT } from './locale.ts'
import { connectBucketFix } from '../../shared/doctor.ts'

/** A sqlite Store saved under the LayerFS home (`native`). */
export const inHome = (s: StoreRow): boolean => s.kind === 'sqlite' && s.machine === 'native'

/** project.init goes into a ready Store (LayerFS refuses a busy, blocked or broken one). */
export const canAddProject = (s: StoreRow): boolean => s.state === 'ready'

/**
 * A backup file's state, from 2.0's `behind` (the Store changed since its last
 * backup), `changed` (the bucket's copy is not the one the link last moved)
 * and `missing`; `unknown` when LayerFS could not read them (`message`),
 * `unlinked` when no Store of this home links the file.
 */
export type BackupState = 'current' | 'store_changed' | 'bucket_changed' | 'both_changed' | 'unlinked' | 'missing' | 'unknown'

export function backupStateOf(f: Pick<BackupFile, 'store' | 'behind' | 'changed' | 'missing'> | null | undefined): BackupState | null {
  if (!f) return null
  if (f.missing) return 'missing'
  if (!f.store) return 'unlinked'
  if (f.behind == null || f.changed == null) return 'unknown'
  return f.behind ? (f.changed ? 'both_changed' : 'store_changed') : f.changed ? 'bucket_changed' : 'current'
}

/**
 * Why an action that requires a Ready Store (Push, Pull, Move, Back up, Add
 * project) waits, or null when the Store is ready.
 */
export function storeWaitsFor(
  s: Pick<StoreRow, 'name' | 'state' | 'blockedBy' | 'op' | 'fix' | 'job'>,
  t: StorageT,
  runningJob = false,
): string | null {
  const localBusy = runningJob || !!s.job
  if (s.state === 'ready' && !localBusy) return null
  if (localBusy) return t('storeNeedsOpFinish')
  if (s.state === 'busy') {
    if (s.op) {
      const op = s.op.phase ? `${s.op.name} · ${s.op.phase}` : s.op.name
      return t('opRunning', { op })
    }
    return t('storeNeedsOpFinish')
  }
  if (s.state === 'blocked' && s.blockedBy?.machine) {
    const r = s.blockedBy.reason
    if (!r || r === 'stopped') return t('compactNeedsMachine', { machine: s.blockedBy.machine })
    if (r === 'busy') return t('storeNeedsMachineBusy', { machine: s.blockedBy.machine })
    return t('compactNeedsMachineFixed', { machine: s.blockedBy.machine })
  }
  if (s.state === 'broken') {
    return s.fix === `layerfs store compact ${s.name}` ? t('storeNeedsCompact') : t('storeNeedsRepair')
  }
  return t('compactNeedsIdle')
}

/**
 * Why the Store menu's Compact waits, or null when it is offered. Shares
 * {@link storeWaitsFor}, except a `broken` Store whose fix is
 * `layerfs store compact <store>` (an earlier run's outcome unknown) is
 * offered, since running it is that fix.
 */
export function compactWaitsFor(
  s: Pick<StoreRow, 'name' | 'state' | 'blockedBy' | 'op' | 'fix' | 'job'>,
  t: StorageT,
  runningJob = false,
): string | null {
  if (!runningJob && !s.job && s.state === 'broken' && s.fix === `layerfs store compact ${s.name}`) return null
  return storeWaitsFor(s, t, runningJob)
}

/**
 * Why a blocked Store waits, from its `blocked_by` (2.0: the machine at the
 * root of the block with that machine's state, `stopped` or `busy`, or its
 * broken reason): stopped, busy, a record LayerFS cannot read (`failed`),
 * or any other broken reason in words. `place` names the machine.
 */
export function blockedWords(b: { machine?: string, reason: string }, t: StorageT, place: (m: string) => string = (m) => m): string {
  const machine = place(b.machine ?? '?')
  switch (b.reason) {
    case '': case 'stopped': return t('machineStopped', { machine })
    case 'busy': return t('machineBusyBlock', { machine })
    case 'failed': return t('machineUnreadableBlock', { machine })
    default: return t('machineBrokenBlock', { machine })
  }
}

/**
 * A PostgreSQL Store's size as LayerFS measures it (`store get --with stats`):
 * stored pack bodies plus metadata (`stored_bytes`, `metadata_bytes`), or null
 * when neither was reported. Unlike the projects' Commit counters it includes
 * what Init saved.
 */
export function pgStoreBytes(st: { stored_bytes?: number | null, metadata_bytes?: number | null } | null | undefined): number | null {
  const stored = st?.stored_bytes ?? null, metadata = st?.metadata_bytes ?? null
  return stored === null && metadata === null ? null : (stored ?? 0) + (metadata ?? 0)
}

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
    .filter((m) => m.name !== 'native' && (!m.supports || m.supports.includes('sqlite')))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** A Store the explorer lets you drag to another place (the Store menu's move gating). */
export const canMove = (s: StoreRow): boolean =>
  s.kind === 'sqlite' && !s.job && s.state === 'ready'

/** A link's file as its bucket's last listing has it. */
export const listedOf = (s: StoreRow, bucket: string, file: string, buckets: readonly BucketRow[]) =>
  buckets.find((b) => b.name === bucket)?.files?.find((f) => f.file === file && f.store === s.name)

/** A link's last listed state, when its bucket was listed. */
export const linkState = (s: StoreRow, bucket: string, file: string, buckets: readonly BucketRow[]): BackupState | undefined => backupStateOf(listedOf(s, bucket, file, buckets)) ?? undefined

/** A tree row's status dot and the words that explain it. */
export interface RowSignal { state: 'error' | 'warning' | 'ongoing', reason: string }

const SIGNAL_RANK: Record<RowSignal['state'], number> = { ongoing: 1, warning: 2, error: 3 }

/** The most urgent of some rows' signals: what a collapsed parent shows. */
export function worstSignal(signals: readonly (RowSignal | null | undefined)[]): RowSignal | null {
  return signals.reduce<RowSignal | null>((w, s) => (s && (!w || SIGNAL_RANK[s.state] > SIGNAL_RANK[w.state]) ? s : w), null)
}

/** A Store waiting on its stopped machine (`blocked_by { machine, reason: stopped }`, LayerFS gives no fix). */
export const stoppedBlock = (s: Pick<StoreRow, 'state' | 'blockedBy'>): boolean =>
  s.state === 'blocked' && ['', 'stopped'].includes(s.blockedBy?.reason ?? '')

/** The machine a Store waits on while that machine is broken (not stopped or busy), or null (F3). */
export const brokenBlock = (s: Pick<StoreRow, 'state' | 'blockedBy'>): string | null =>
  s.state === 'blocked' && s.blockedBy?.machine && !['', 'stopped', 'busy'].includes(s.blockedBy.reason) ? s.blockedBy.machine : null

/** Whether a SQLite Store's banner/action should treat it as waiting on a stopped machine (a broken Store keeps priority). */
export const storeMachineStopped = (s: Pick<StoreRow, 'kind' | 'state' | 'blockedBy'>, machineState?: string | null): boolean =>
  s.state !== 'broken' && !brokenBlock(s) && (stoppedBlock(s) || (s.kind === 'sqlite' && machineState === 'stopped'))

/** Whether a SQLite Store's machine is broken or has an unreadable record. */
export const storeMachineBroken = (s: Pick<StoreRow, 'kind' | 'state' | 'blockedBy'>, machineState?: string | null): boolean =>
  !!brokenBlock(s) || (s.kind === 'sqlite' && machineState === 'broken')

/** Notice / card status tone for a Store: red only for a broken Store or broken machine; stopped machine is neutral. */
export function storeNoticeTone(s: Pick<StoreRow, 'kind' | 'state' | 'blockedBy'>, machineState?: string | null): 'danger' | undefined {
  if (s.state === 'broken' || storeMachineBroken(s, machineState)) return 'danger'
  return undefined
}

export type MachineHealthKey = 'spMachineRunning' | 'spMachineStopped' | 'spMachineBroken' | 'spMachineUnreadable' | 'spMachineBusy' | 'spMachineUnknown'

/** Overview Health › Machine row: grades the machine by its own state (even when the Store itself is broken). */
export function overviewMachineHealth(s: Pick<StoreRow, 'kind' | 'machine' | 'state' | 'blockedBy'>, machineState?: string | null): { tone: 'ok' | 'info' | 'danger', key: MachineHealthKey } {
  if (storeMachineBroken(s, machineState)) {
    return { tone: 'danger', key: s.blockedBy?.reason === 'failed' ? 'spMachineUnreadable' : 'spMachineBroken' }
  }
  if (stoppedBlock(s) || (s.kind === 'sqlite' && machineState === 'stopped')) return { tone: 'info', key: 'spMachineStopped' }
  if (machineState === 'busy' || (s.state === 'blocked' && s.blockedBy?.reason === 'busy')) return { tone: 'info', key: 'spMachineBusy' }
  if (machineState === 'ready' || (s.machine === 'native' && machineState !== 'broken')) return { tone: 'ok', key: 'spMachineRunning' }
  return { tone: 'info', key: 'spMachineUnknown' }
}

/** How much a Store needs you, and why: its running or failed job first, then its own state, its backups, its machine. */
export function storeSignal(s: StoreRow, job: StorageJob | undefined, machineState: string | null | undefined, buckets: readonly BucketRow[], t: StorageT): RowSignal | null {
  if (job && !job.ended) return { state: 'ongoing', reason: doingWords(job, t) }
  if (job?.error) return { state: 'error', reason: endedWords(job, t) }
  // the state's word and its reason; the fix is the card's one action
  if (s.state === 'broken') return { state: 'error', reason: brokenWords(s, t) }
  if (brokenBlock(s)) return { state: 'error', reason: blockedWords(s.blockedBy!, t) }
  if (stoppedBlock(s)) return null
  if (s.state === 'blocked') return s.blockedBy?.reason === 'busy' ? null : { state: 'warning', reason: s.blockedBy?.machine ? blockedWords(s.blockedBy, t) : storeStateWords(s.state, t, s.blockedBy?.reason) }
  if (s.state === 'unknown') return { state: 'warning', reason: storeStateWords(s.state, t) }
  const links = s.links.map((l) => ({ l, state: linkState(s, l.bucket, l.file, buckets) }))
  const linkReason = (x: typeof links[number]) => `${x.l.bucket}/${x.l.file}: ${backupChip(x.state, t).label}`
  const broken = links.find((x) => x.state === 'both_changed' || x.state === 'missing')
  if (broken) return { state: 'error', reason: linkReason(broken) }
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

/** A Sandbox's state in the machine pages' words: Lost for a broken one whose daemon ended (`lost`, `missing`), else the state word. */
export function sandboxStateWords(b: { state: string, reason?: string | null }, t: StorageT): string {
  if (b.state === 'broken' && (b.reason === 'lost' || b.reason === 'missing')) return t('sandboxLost')
  return storeStateWords(b.state, t)
}

/** A Store's 2.0 state as a chip tone. Stopped machines stay neutral; broken machines and broken Stores are red. */
export function storeTone(state: string, blockedBy?: StoreRow['blockedBy']): Tone {
  if (state === 'ready') return 'success'
  if (state === 'busy') return 'info'
  if (state === 'stopped') return 'neutral'
  if (state === 'broken') return 'danger'
  if (state === 'blocked') {
    if (brokenBlock({ state, blockedBy })) return 'danger'
    if (stoppedBlock({ state, blockedBy }) || blockedBy?.reason === 'busy') return 'neutral'
    return 'warning'
  }
  return 'neutral'
}

const REASON_KEYS = new Map<string, StorageKey>([
  ['corrupt', 'reasonCorrupt'],
  ['outdated', 'reasonOutdated'],
  ['missing', 'reasonMissing'],
  ['unreachable', 'reasonUnreachable'],
  ['failed', 'reasonFailed'],
  ['unresolved', 'reasonUnresolved'],
  ['lost', 'reasonLost'],
  ['engine_down', 'reasonEngineDown'],
  ['unsupported', 'reasonUnsupported'],
  ['not_answering', 'reasonNotAnswering'],
])

/** A Store's state in words (one of the six), with its localized reason when given: `Broken · corrupt` / `损坏 · 数据损坏`. */
export function storeStateWords(state: string, t: StorageT, reason?: string | null): string {
  const word = (() => {
    switch (state) {
      case 'ready': return t('stateReady')
      case 'busy': return t('stateBusy')
      case 'stopped': return t('stateStopped')
      case 'blocked': return t('stateBlocked')
      case 'broken': return t('stateBroken')
      default: return t('stateUnknown')
    }
  })()
  if (!reason) return word
  const key = REASON_KEYS.get(reason.toLowerCase())
  const text = key ? t(key) : reason.replace(/_/g, ' ')
  return `${word} · ${text}`
}

/**
 * A PostgreSQL Store whose record names no saved login (one connected before
 * saved logins). LayerFS 2.0 does not dial it: it is `broken` `outdated` and
 * every call is refused until a login is saved and named
 * (`store save-auth` then `store update --auth`).
 */
export const needsLogin = (s: Pick<StoreRow, 'kind' | 'state' | 'reason' | 'postgresql'>): boolean =>
  s.kind === 'postgresql' && s.state === 'broken' && ((s.reason === 'outdated' && !s.postgresql?.auth) || (s.reason === 'missing' && !!s.postgresql?.auth))

/** A broken Store's words: an unknown outcome, a PostgreSQL Store with no saved login, else the state word and its reason. */
export function brokenWords(s: Pick<StoreRow, 'kind' | 'state' | 'reason' | 'postgresql'>, t: StorageT): string {
  if (s.reason === 'unresolved') return t('unresolved')
  if (needsLogin(s)) return `${t('stateBroken')} · ${t('reasonNoLogin')}`
  return storeStateWords(s.state, t, s.reason)
}

/** Whether a Store's sessions are unavailable (owner Q-R3): broken (outdated, missing, …) or blocked, until its fix. */
export const sessionsUnavailable = (s: { state?: string | null } | undefined): boolean => s?.state === 'broken' || s?.state === 'blocked'

/**
 * A Store's hover tip: LayerFS's own sentence when its answer has one; a
 * PostgreSQL Store with no saved login says what LayerFS's refusal says
 * (`store list` gives no sentence for it); else its fix line.
 */
export function storeTip(s: Pick<StoreRow, 'name' | 'kind' | 'state' | 'reason' | 'postgresql' | 'message' | 'fix'>, t: StorageT): string | undefined {
  if (s.message) return s.message
  if (needsLogin(s)) return t('pgNoLoginTip', { store: s.name })
  return s.fix ?? undefined
}

/** A Store's one action from its `fix`, when the line is a layerfs call the page can name (the card shows it as the tip's action). */
export const storeFix = (s: Pick<StoreRow, 'fix'>): string | null => (typeof s.fix === 'string' && s.fix.startsWith('layerfs ') ? s.fix : null)

/** A bucket that did not list, in a few words (the status word; LayerFS's sentence is its tip). */
export function listStatusWords(code: string, t: StorageT): string {
  switch (code) {
    case 'refused': return t('bucketStatusRefused')
    case 'timeout': case 'Timeout': return t('bucketStatusTimeout')
    case 'busy': case 'Busy': return t('bucketStatusBusy')
    case 'lost': return t('bucketStatusLost')
    default: return t('bucketStatusOther')
  }
}

/**
 * When a bucket page asks LayerFS to list on its own (F2): once per open, and
 * only for a bucket with no listing and no remembered refusal. A refused or
 * `not_listed` listing is a result: it is shown, never asked again by the
 * page. It is listed again only on a press (List again) or a real change (the
 * host lists it after a backup or restore). One closure per open page.
 */
export function autoList(): (name: string, b: Pick<BucketRow, 'files' | 'error'> | undefined, listing: boolean) => boolean {
  let asked: string | null = null
  return (name, b, listing) => {
    if (asked === name || !b || listing) return false
    asked = name
    return b.files === null && !b.error
  }
}

/** A bucket's address in its parts, for the Connect dialog: MinIO `http(s)://<host>/<bucket>/<prefix>`, R2 `r2://<account>/<bucket>/<prefix>[?jurisdiction=…]`. */
export interface BucketParts { provider: 'minio' | 'r2', endpoint?: string, account?: string, jurisdiction?: string, bucket: string, prefix: string }
export function bucketParts(url: string | null | undefined): BucketParts | null {
  if (typeof url !== 'string') return null
  const r2 = /^r2:\/\/([^/?]+)\/([^/?]+)(?:\/([^?]*?))?\/?(?:\?jurisdiction=([\w-]+))?$/.exec(url)
  if (r2) return { provider: 'r2', account: r2[1]!, bucket: r2[2]!, prefix: r2[3] ?? '', ...(r2[4] ? { jurisdiction: r2[4] } : {}) }
  const minio = /^(https?:\/\/[^/?#]+)\/([^/?#]+)(?:\/([^?#]*?))?\/?$/.exec(url)
  if (minio) return { provider: 'minio', endpoint: minio[1]!, bucket: minio[2]!, prefix: minio[3] ?? '' }
  return null
}

/**
 * A bucket that must be connected again (F5): LayerFS refused its key
 * (`not_listed` reason `refused`), or its record has no access key (a broken
 * record, or a `backup connect` fix). Its one action is Connect again…: the
 * Connect dialog with the name, and the URL when LayerFS's fix names it
 * (connecting again with the same URL rotates the key, spec v21 `rotated`).
 */
export interface Reconnect { bucket: string, provider: string | null, url: string | null }
export function reconnectOf(b: Pick<BucketRow, 'name' | 'provider' | 'state' | 'fix' | 'error'> & Partial<Pick<BucketRow, 'url'>>): Reconnect | null {
  const fixed = connectBucketFix(b.error?.fix) ?? connectBucketFix(b.fix)
  if (!fixed && b.error?.code !== 'refused' && b.state !== 'broken') return null
  // a broken record with some other fix keeps that fix (its status tip), not Connect again
  if (!fixed && b.error?.code !== 'refused' && b.fix) return null
  return { bucket: b.name, provider: fixed ? bucketParts(fixed.url)?.provider ?? b.provider : b.provider, url: fixed?.url ?? b.url ?? null }
}

/** A backup file's state: its tone and words. Backups are optional, so only real failures (missing, conflict) are red. */
export function backupChip(state: BackupState | null | undefined, t: StorageT): { tone: Tone, label: string, dashed?: boolean } {
  switch (state) {
    case 'current': return { tone: 'success', label: t('backupCurrent') }
    case 'store_changed': return { tone: 'neutral', label: t('backupStoreChanged') }
    case 'bucket_changed': return { tone: 'neutral', label: t('backupBucketChanged') }
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

/** Where a Store is, in words: the home, a machine, or PostgreSQL. */
export const placeWords = (machine: string | null | undefined, t: StorageT): string => (machine === 'native' ? t('layerfsHome') : (machine ?? '?'))

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
    ? b.files.map((f) => ({ file: f.file, store: (f.store && byName.get(f.store)) || null, storeName: f.store, state: backupStateOf(f), bytes: f.bytes, modified: f.modified, reason: f.message, link: linkOf(f.store ? byName.get(f.store) : undefined, f.file) }))
    : stores.flatMap((s) => s.links.filter((l) => l.bucket === b.name).map((l) => ({ file: l.file, store: s, storeName: s.name, state: null, bytes: l.last?.bytes ?? null, modified: null, reason: null, link: l })))
  return rows.sort((x, y) => x.file.localeCompare(y.file) || (x.storeName ?? '').localeCompare(y.storeName ?? ''))
}

// ---------- jobs ----------

/** The phases each call reports, in order. */
export const STEPS: Record<JobKind, readonly string[]> = {
  push: ['check', 'snapshot', 'send', 'verify', 'install', 'record', 'retire'],
  pull: ['check', 'snapshot', 'send', 'verify', 'install', 'record', 'retire'],
  move: ['check', 'snapshot', 'send', 'verify', 'install', 'record', 'retire'],
  backup: ['check', 'snapshot', 'send', 'hash', 'upload'],
  restore: ['check', 'download', 'verify', 'install'],
  // a sqlite Store's; the host names a PostgreSQL Store's own (`steps`)
  compact: ['mark', 'build', 'verify', 'install'],
}

export type StepState = 'done' | 'now' | 'failed' | 'todo'

export function stepsOf(j: StorageJob): { step: string, state: StepState }[] {
  const seen = j.phases?.filter((p) => p.half === (j.half ?? null)).map((p) => p.phase) ?? []
  const base = j.steps?.length ? j.steps : STEPS[j.kind]
  const extras = seen.filter((p) => !base.includes(p))
  const cur = j.error?.phase ?? j.phase ?? null
  const steps = [...base, ...extras, ...(cur && !base.includes(cur) && !extras.includes(cur) ? [cur] : [])]
  const ok = j.ended !== null && j.error === null && (!j.outcome || j.outcome === 'succeeded')
  const at = j.error ? steps.lastIndexOf(j.error.phase ?? j.phase ?? '') : j.phase ? steps.lastIndexOf(j.phase) : j.ended ? -1 : 0
  return steps.map((step, i) => ({ step, state: ok || i < at ? 'done' : i === at ? (j.error ? 'failed' : 'now') : 'todo' }))
}

export function rawShareOf(j: StorageJob): number {
  if (j.ended) return 1
  const steps = stepsOf(j)
  const at = Math.max(0, steps.findIndex((s) => s.state === 'now'))
  const inner = j.total ? Math.min(1, Math.max(0, (j.done ?? 0) / j.total)) : 0
  const halfShare = (at + inner) / Math.max(1, steps.length)
  const half = j.kind === 'move' ? (j.half === 'push' ? 1 : 0) : 0
  const runs = j.kind === 'move' ? 2 : 1
  return Math.min(0.99, Math.max(0, (half + halfShare) / runs))
}

/** Monotonic share done (0..1): never regresses past `maxShare`, never reaches 1 until ended. */
export function shareOf(j: StorageJob): number {
  if (j.ended) return 1
  return Math.min(0.99, Math.max(rawShareOf(j), j.maxShare ?? 0))
}

export function jobPercent(j: StorageJob): number {
  return Math.round(shareOf(j) * 100)
}

const halfRank = (half: StorageJob['half']): number => (half === 'push' ? 2 : half === 'pull' ? 1 : 0)

/** Merge an incoming job snapshot without letting stale polls regress progress or phases. */
export function mergeJob(old: StorageJob | undefined, incoming: StorageJob): StorageJob {
  if (!old) return incoming.ended ? incoming : { ...incoming, maxShare: rawShareOf(incoming) }
  if (old.ended && !incoming.ended) return old
  if (incoming.ended) return { ...incoming, maxShare: 1 }
  const oldShare = shareOf(old)
  const nextRaw = rawShareOf(incoming)
  const oldHalf = halfRank(old.half)
  const nextHalf = halfRank(incoming.half)
  const oldPhases = old.phases?.length ?? 0
  const nextPhases = incoming.phases?.length ?? 0
  if (nextHalf < oldHalf) return old
  if (nextHalf === oldHalf && nextPhases < oldPhases) return old
  if (nextHalf === oldHalf && nextPhases === oldPhases && incoming.phase === old.phase && (incoming.done ?? -1) < (old.done ?? -1)) return old
  const maxShare = Math.min(0.99, Math.max(oldShare, nextRaw, incoming.maxShare ?? 0))
  if (old.ended === incoming.ended && old.phase === incoming.phase && old.done === incoming.done && old.total === incoming.total && old.half === incoming.half && old.maxShare === maxShare) return old
  return { ...incoming, maxShare }
}

export function movePushFailed(j: Pick<StorageJob, 'kind' | 'half' | 'phase' | 'outcome' | 'error'>): boolean {
  if (j.kind !== 'move' || !j.error) return false
  if (j.error.note === 'pulled') return true
  const phase = j.error.phase ?? j.phase ?? null
  return j.half === 'push' && j.outcome !== 'unknown' && j.outcome !== 'interrupted' && phase !== 'retire'
}

export const DISK_HEADROOM_RATIO = 1.15
export interface DiskFit {
  state: 'ok' | 'tight' | 'full' | 'unknown'
  free: number | null
  need: number | null
  shortBy: number
}
export function diskFit(free: number | null | undefined, size: number | null | undefined): DiskFit {
  if (free == null || size == null || size <= 0) return { state: 'unknown', free: free ?? null, need: size ?? null, shortBy: 0 }
  if (free < size) return { state: 'full', free, need: size, shortBy: size - free }
  if (free < Math.ceil(size * DISK_HEADROOM_RATIO)) return { state: 'tight', free, need: size, shortBy: 0 }
  return { state: 'ok', free, need: size, shortBy: 0 }
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
    case 'mark': return t('stepMark')
    case 'build': return t('stepBuild')
    case 'swap': return t('stepSwap')
    case 'cleanup': return t('stepCleanup')
    case null: return t('stepStarting')
    // a step this page has no word for: a plain word, never LayerFS's step code
    default: return t('stepWorking')
  }
}

/** What a running job does, in words. */
export function doingWords(j: StorageJob, t: StorageT): string {
  switch (j.kind) {
    case 'push': return t(j.made ? 'jobMaking' : 'jobPushing', { place: placeWords(j.target, t) })
    case 'pull': return t('jobPulling', { place: placeWords(j.from, t) })
    case 'move': return t('jobMoving', { place: placeWords(j.target, t) })
    case 'backup': return t('jobBackingUp', { place: j.target })
    case 'restore': return t('jobRestoring', { place: j.file ? `${j.target}/${j.file}` : j.target })
    case 'compact': return t('jobCompacting', { place: j.store })
  }
}

/** A job refused because something holds its Store (a compaction while Workspaces are mounted: `InUse`, `MountsActive`). UI pass 3 F10. */
export const inUseJob = (j: Pick<StorageJob, 'error'>): boolean => j.error?.code === 'InUse' || j.error?.code === 'MountsActive'

/** What holds a Store, by the Sandboxes whose projects are in it (the in-use refusal names only a count). */
export const storeHolders = <B extends { name: string, project?: string | null }>(store: string, sandboxes: readonly B[]): B[] =>
  sandboxes.filter((b) => !!b.project && b.project.startsWith(`${store}/`))

/** A Sandbox as the job notices name it: what holds a Store. */
type Holder = { name: string, machine?: string | null, project?: string | null }

/**
 * A failed job's tip and what holds its Store, the same on Home and on its
 * Store (UI pass 3 F10): for an in-use refusal, the holding Sandboxes first,
 * then LayerFS's code and words, then its fix line (as `fixTip` words it).
 */
export function jobEnd<B extends Holder>(j: Pick<StorageJob, 'error' | 'store'>, sandboxes: readonly B[], t: StorageT, fixTip: (line: string) => string = (line) => line): { holders: B[], tip: string | undefined } {
  const holders = j.error && inUseJob(j) ? storeHolders(j.store, sandboxes) : []
  const tip = j.error ? [...(holders.length ? [t('jobInUseHolders', { holders: holders.map((b) => b.name).join(', ') })] : []), `${j.error.code}: ${j.error.message}`, ...(j.error.fix ? [fixTip(j.error.fix)] : [])].join('\n') : undefined
  return { holders, tip }
}

/** The page a holding Sandbox opens on. */
export const holderTab = (b: Holder): `sandbox:${string}` => `sandbox:${b.machine ?? 'native'}/${b.name}`

/** How a job ended, in words. `size` writes a byte count (a compaction's freed space); without it the count is left out. */
export function endedWords(j: StorageJob, t: StorageT, size?: (n: number) => string): string {
  if (j.outcome === 'unknown') return t('jobUnknown')
  if (j.outcome === 'interrupted') return t('jobInterrupted')
  const place = j.kind === 'pull' ? placeWords(j.from, t) : j.kind === 'backup' || j.kind === 'restore' ? j.target : j.kind === 'compact' ? j.store : placeWords(j.target, t)
  const failPhase = j.error?.phase ?? j.phase ?? null
  if (j.error && failPhase === 'retire' && (j.kind === 'push' || j.kind === 'pull' || j.kind === 'move')) {
    return j.kind === 'pull' || j.half === 'pull'
      ? t('jobRetireHome', { from: placeWords(j.from, t) })
      : t('jobRetireTarget', { place: placeWords(j.target, t) })
  }
  if (movePushFailed(j)) {
    return inUseJob(j)
      ? t('jobMovePushInUse', { place })
      : t('jobMovePushFailed', { place, phase: failPhase ? stepWords(failPhase, t) : '—' })
  }
  if (j.error && j.kind === 'move' && j.half === 'pull' && j.from) {
    const from = placeWords(j.from, t)
    return inUseJob(j)
      ? t('jobMovePullInUse', { place, from })
      : t('jobMovePullFailed', { place, from, phase: failPhase ? stepWords(failPhase, t) : '—' })
  }
  // in use is its own word; a failure names its step in words, never LayerFS's step code (UI pass 3 F10)
  if (j.error && inUseJob(j)) return t('jobInUse', { what: kindWords(j.kind, t), place })
  if (j.error) return t('jobFailed', { what: kindWords(j.kind, t), place, phase: failPhase ? stepWords(failPhase, t) : '—' })
  switch (j.kind) {
    case 'push': return t(j.made ? 'jobMade' : 'jobPushed', { place })
    case 'pull': return t('jobPulled', { place })
    case 'move': return t('jobMoved', { place })
    case 'backup': return t('jobBackedUp', { place })
    case 'restore': return t('jobRestored', { place })
    case 'compact': {
      // the report's own words: nothing was worth rebuilding, or what the Store shrank by
      if (j.result?.outcome === 'unchanged') return t('jobCompactedNone', { place })
      const freed = j.result?.freed_bytes
      return size && typeof freed === 'number' && freed > 0 ? t('jobCompactedFreed', { place, freed: size(freed) }) : t('jobCompacted', { place })
    }
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
    case 'compact': return t('kindCompact')
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

/**
 * Whether a failed job's notice no longer holds (UI pass 3 F11): its Store is
 * gone, or a later job of the same kind on that Store ended without an error
 * (a compaction that failed, then one that worked). A restore's Store may never
 * have existed (restore as a new Store that failed), so its absence does not
 * end a restore's notice; only a later restore that worked does.
 */
export function failureSuperseded(job: Pick<StorageJob, 'id' | 'kind' | 'store' | 'ended'>, jobs: readonly Pick<StorageJob, 'id' | 'kind' | 'store' | 'ended' | 'error'>[], stores: readonly { name: string }[]): boolean {
  if (job.kind !== 'restore' && !stores.some((s) => s.name === job.store)) return true
  const sameFamily = (kind: JobKind) => kind === job.kind || (job.kind === 'move' && (kind === 'push' || kind === 'pull'))
  return jobs.some((j) => j.id !== job.id && j.store === job.store && sameFamily(j.kind) && j.ended != null && job.ended != null && j.ended > job.ended && !j.error)
}

/** How many jobs run, and how many failed and are not dismissed. */
export function jobCounts(jobs: readonly StorageJob[], dismissed: ReadonlySet<string>) {
  const latest = new Map<string, StorageJob>()
  for (const j of jobs) if (!latest.has(j.store) || j.started > latest.get(j.store)!.started) latest.set(j.store, j)
  const last = [...latest.values()]
  return { running: last.filter((j) => !j.ended).length, failed: last.filter((j) => j.ended && j.error && !dismissed.has(j.id)).length }
}

// ---------- PostgreSQL: who connects (spec v23) ----------

/** A connections row's machine as the page names machines: this computer is `native`. */
export const rowMachine = (c: Pick<PgConnection, 'machine'>): string => c.machine ?? 'native'

/** The machines a PostgreSQL Store's database is connected from, this computer first (as `native`). */
export function connectedMachines(s: Pick<StoreRow, 'connectedFrom'>): string[] {
  return (s.connectedFrom ?? []).map(rowMachine)
}

/** `machine`'s row of a PostgreSQL Store (this computer's for `native` without an address of its own), or null. */
export function connectionOf(s: Pick<StoreRow, 'connectedFrom'>, machine: string): PgConnection | null {
  const rows = s.connectedFrom ?? []
  return rows.find((c) => c.machine === machine) ?? (machine === 'native' ? rows.find((c) => c.machine === null) ?? null : null)
}

/** The name a new login for `server` (`host:port`) gets by default (spec v23 V23-12): `pg-<host>-<port>`, never the Store's. */
export function pgServerLogin(server: string | null | undefined): string | null {
  if (!server) return null
  const name = `pg-${server}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '').slice(0, 63).replace(/-+$/, '')
  return /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(name) ? name : null
}

/** The PostgreSQL Stores connected from `machine` (its `connections` name it), or with a Sandbox there now (`busy`: their names), by name. */
export function pgStoresOn(view: Pick<StorageView, 'stores'>, machine: string, busy: ReadonlySet<string> = new Set()): StoreRow[] {
  return view.stores.filter((s) => s.kind === 'postgresql' && (connectedMachines(s).includes(machine) || busy.has(s.name))).sort((a, b) => a.name.localeCompare(b.name))
}

/** Whether a new PostgreSQL session may be placed on `m`: it runs, runs PostgreSQL Sandboxes and is not broken (the host's placement.ts). */
export const pgPlaceable = (m: { state?: string | null, supports?: readonly string[] | null } | undefined): boolean =>
  !!m && (!m.supports || m.supports.includes('postgresql_sandbox')) && (m.state ?? 'ready') === 'ready'

/**
 * The machine a new session of PostgreSQL Store `s` runs on when the person
 * names none (the host's placement.ts order, without its Sandbox read): the
 * project's last machine when given, a machine the database was reached
 * from, else native. Never a broken or stopped machine.
 */
export function pgDefaultMachine(s: Pick<StoreRow, 'connectedFrom'> | undefined, machines: readonly { name: string, state?: string | null, supports?: readonly string[] | null }[], last?: string | null): string {
  const ok = (name: string | null | undefined): name is string => !!name && pgPlaceable(machines.find((m) => m.name === name))
  if (ok(last)) return last
  return (s?.connectedFrom ?? []).filter((c) => c.reached === 'ok').map(rowMachine).find(ok) ?? 'native'
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
