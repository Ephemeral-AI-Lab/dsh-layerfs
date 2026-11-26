/**
 * The home Store tab's accordion rows, as data (StoreRows.tsx draws them;
 * docs/specs/store-home-rows.md):
 *
 * - the one shared status label set for a PostgreSQL check from the host or a
 *   machine (`reachStatus`, `hostStatus`), each failure with its one action;
 * - a PostgreSQL row's folded summary (`pgSummary`): its address, projects,
 *   the first machines with their reach and the one status word;
 * - a SQLite row's state and its backups in a few numbers;
 * - the caps (3 icons in a summary, 5 rows in a list) and `+N`;
 * - the attach picker's choices, grouped by provider, with why a machine (or
 *   a Store, from a machine page) cannot attach, and the connection step a
 *   test stopped at;
 * - login-in-URL detection for the Connect dialog;
 * - one tone → dot state rule for every status dot;
 * - the open rows, remembered per viewer.
 *
 * Kept free of React so it is unit tested (test/store-rows.test.mjs).
 */
import { classifyPgFailure } from '../../shared/pg-failure.ts'
import { timeLocale } from '../ui/locale-sync.ts'
import type { StorageKey } from './locale.ts'
import { storeBackups } from './store-backups.ts'
import type { BucketRow, PgAttached, PgReach, StorageJob, StorageView, StoreRow } from './types.ts'

/** Rows drawn in an unfolded list before `+N →`. */
export const LIST_ROWS = 5

/** The first `n` items and how many more there are. */
export function capped<T>(items: readonly T[], n: number): { shown: T[], more: number } {
  return { shown: items.slice(0, Math.max(0, n)), more: Math.max(0, items.length - Math.max(0, n)) }
}

// ---------- the shared status label set ----------

/** One status of a check from the host or a machine (spec "Status labels"). */
export type ReachKey = 'reachable' | 'checking' | 'notChecked' | 'address' | 'password' | 'database' | 'notThisStore' | 'machineStopped' | 'machineUpdate' | 'failed'
/** A failure's one action: Edit connection…, Start, Update; null when there is none. */
export type ReachFix = 'edit' | 'start' | 'update' | null

export interface ReachStatus {
  key: ReachKey
  tone: 'ok' | 'danger' | 'warning' | 'idle' | 'ongoing'
  fix: ReachFix
  /** LayerFS's own words, for the tooltip (never on the row). */
  detail: string | null
}

/** Each status's words (locale keys). */
export const REACH_LABEL: Readonly<Record<ReachKey, StorageKey>> = {
  reachable: 'stReachable', checking: 'stChecking', notChecked: 'stNotChecked', address: 'stAddress', password: 'stPassword',
  database: 'stDatabase', notThisStore: 'stNotThisStore', machineStopped: 'stMachineStopped', machineUpdate: 'stMachineUpdate', failed: 'stFailed',
}

const FIX: Readonly<Record<ReachKey, ReachFix>> = {
  reachable: null, checking: null, notChecked: null, address: 'edit', password: 'edit', database: 'edit', notThisStore: 'edit',
  machineStopped: 'start', machineUpdate: 'update', failed: 'edit',
}

const status = (key: ReachKey, detail: string | null = null): ReachStatus => ({
  key, fix: FIX[key], detail,
  tone: key === 'reachable' ? 'ok' : key === 'checking' ? 'ongoing' : key === 'notChecked' ? 'idle' : key === 'machineStopped' || key === 'machineUpdate' ? 'warning' : 'danger',
})

/**
 * A failed check's label, from LayerFS's refusal code and words (doctor
 * evidence, documented messages): the address did not answer, the password
 * was refused, the database is missing or holds another Store. Anything it
 * cannot place is `failed` (its words stay the tooltip).
 */
export function failureKey(error: string | null | undefined, code?: string): ReachKey {
  const text = error ?? ''
  if (/holds another Store than|not this Store/i.test(text)) return 'notThisStore'
  if (/SQLSTATE 3D000|database "?[^"\s]*"? does not exist|database not found/i.test(text)) return 'database'
  if (/machine \S+ is stopped|machine is stopped|\bstopped\b.*machine/i.test(text)) return 'machineStopped'
  if (/SQLSTATE 28P01|SQLSTATE 28000|password authentication failed/i.test(text)) return 'password'
  switch (classifyPgFailure(code, text)) {
    case 'server': case 'daemon_dns': return 'address'
    case 'login': return 'password'
    case 'store': return 'database'
    default: return 'failed'
  }
}

/** A machine as far as its reach status needs it (a stopped or outdated one is said first). */
export interface ReachMachine { state?: string | null, reason?: string | null }

/**
 * A side's status: `checking` while a check runs, the machine's own state when
 * it is stopped or needs an update, else the last reach (reachable, a failure
 * label) or `not checked` when none was seen.
 */
export function reachStatus(reach: PgReach | null | undefined, opts: { checking?: boolean, machine?: ReachMachine | null } = {}): ReachStatus {
  if (opts.checking) return status('checking')
  const m = opts.machine
  if (m?.state === 'stopped') return status('machineStopped', reach?.error ?? null)
  if (m?.state === 'broken' && m.reason === 'outdated') return status('machineUpdate', reach?.error ?? null)
  if (!reach) return status('notChecked')
  if (reach.ok) return status('reachable')
  return status(failureKey(reach.error), reach.error)
}

/**
 * The host's check of a PostgreSQL Store: its recorded reach when LayerFS
 * gives one, else the Store's own state (`broken` `unreachable` is a failed
 * host check), else not checked.
 */
export function hostStatus(s: Pick<StoreRow, 'state' | 'reason' | 'message' | 'postgresql'>, checking = false): ReachStatus {
  if (checking) return status('checking')
  const host = s.postgresql?.host ?? null
  if (host) return reachStatus(host)
  if (s.state === 'broken' && s.reason === 'unreachable') return status(failureKey(s.message ?? null, 'Unavailable'), s.message ?? null)
  return status('notChecked')
}

/**
 * A refused connect (Connect a database, Edit connection) as one line and the
 * field it is about, from the connection step LayerFS says it stopped at,
 * never from its words (they stay the line's title). `Exists` is the name; a
 * `Conflict` with no step is a changed connection an attached machine would
 * lose (`machines` in its detail).
 */
export function connectFailure(code: string, step: string | null | undefined): { key: StorageKey, field: 'address' | 'password' | 'name' | null } {
  if (code === 'Exists') return { key: 'cdNameTaken', field: 'name' }
  switch (testStep(step)) {
    case 'address': case 'connection': return { key: 'pgErrAddress', field: 'address' }
    case 'tls': return { key: 'pgErrTls', field: 'address' }
    case 'login': return { key: 'pgErrPassword', field: 'password' }
    case 'database': return { key: 'pgErrDatabase', field: 'address' }
    case 'store': return { key: 'pgErrNotThisStore', field: 'address' }
    default: return code === 'Conflict' ? { key: 'pgTestLoses', field: null } : { key: 'pgErrFailed', field: null }
  }
}

/** A list of words joined as the reader's language does ("a, b and c" / "a、b和c"). */
export function listWords(items: readonly string[]): string {
  try { return new Intl.ListFormat(timeLocale() ?? 'en', { type: 'conjunction' }).format(items) } catch { return items.join(', ') }
}

/** A provider's words beside a name, unless they say the same thing ("docker Docker", "native Native"). */
export const providerBeside = (name: string, provider: string): string | null => (provider && provider.toLowerCase() !== name.toLowerCase() ? provider : null)

/** A status tone as a StatusDot state: the one rule for every dot on the tab. */
export type DotState = 'done' | 'error' | 'warning' | 'ongoing' | 'idle'
export const dotState = (tone: ReachStatus['tone']): DotState =>
  tone === 'ok' ? 'done' : tone === 'danger' ? 'error' : tone === 'warning' ? 'warning' : tone === 'ongoing' ? 'ongoing' : 'idle'

// ---------- addresses ----------

/** Whether an address carries a user or password (in its authority or a parameter): LayerFS refuses one; they are given apart. */
export function urlHasLogin(url: string | null | undefined): boolean {
  const value = (url ?? '').trim()
  if (!value) return false
  try {
    const u = new URL(/^postgres(?:ql)?:\/\//i.test(value) ? value : `postgresql://${value}`)
    if (u.username || u.password) return true
    return [...u.searchParams.keys()].some((k) => { const n = k.toLowerCase(); return n === 'user' || n === 'passfile' || n.includes('password') })
  } catch {
    return /^[^/]*:\/\/[^/@?]*@/.test(value)
  }
}

/** A PostgreSQL Store's address line: `user@host:port/database` (never a password), or null. */
export function pgAddress(s: Pick<StoreRow, 'postgresql'>): string | null {
  const pg = s.postgresql
  if (!pg) return null
  if (pg.server) return `${pg.user ? `${pg.user}@` : ''}${pg.server}${pg.database ? `/${pg.database}` : ''}`
  return pg.target ?? null
}

// ---------- PostgreSQL row ----------

export interface PgMachine { machine: string, platform: string | null, status: ReachStatus }

export interface PgSummary {
  projects: number
  host: ReachStatus
  /** Every attached machine with its status, by LayerFS's order. */
  machines: PgMachine[]
  /** Machines whose last check failed. */
  failed: number
  /** Attached machines that are stopped. */
  stopped: number
}

/** A PostgreSQL row's folded summary; `checking`: the sides being checked now (`host` and machine names). */
export function pgSummary(s: StoreRow, view: Pick<StorageView, 'machines'>, checking: ReadonlySet<string> = new Set()): PgSummary {
  const machines = (s.attached ?? []).map((a: PgAttached): PgMachine => {
    const record = view.machines.find((m) => m.name === a.machine)
    return { machine: a.machine, platform: record?.platform ?? null, status: reachStatus(a.reach, { checking: checking.has(a.machine), machine: record ? { state: record.state, reason: record.reason ?? null } : null }) }
  })
  return {
    projects: s.projectsCount ?? s.projects.length,
    host: hostStatus(s, checking.has('host')),
    machines,
    failed: machines.filter((m) => m.status.tone === 'danger').length,
    stopped: machines.filter((m) => m.status.key === 'machineStopped').length,
  }
}

// ---------- provider groups (a row's machines and buckets as icons) ----------

/** How bad a tone is: a group's dot shows its worst member. */
const TONE_RANK: Readonly<Record<ReachStatus['tone'], number>> = { danger: 4, warning: 3, ongoing: 2, idle: 1, ok: 0 }

export const worstTone = (tones: readonly ReachStatus['tone'][]): ReachStatus['tone'] =>
  tones.reduce<ReachStatus['tone']>((worst, tone) => (TONE_RANK[tone] > TONE_RANK[worst] ? tone : worst), 'ok')

/** One member of a provider group: its name, its tone and its words for the tooltip. */
export interface GroupMember { name: string, provider: string, tone: ReachStatus['tone'], words: string }
export interface ProviderGroupOf { provider: string, members: GroupMember[], tone: ReachStatus['tone'] }

/**
 * Members grouped by provider, one icon each with a count: several machines
 * (or buckets) of one kind share one icon, whose dot is the worst member's.
 * Providers in the order they first appear; members by name.
 */
export function providerGroups(members: readonly GroupMember[]): ProviderGroupOf[] {
  const groups = new Map<string, GroupMember[]>()
  for (const m of members) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m])
  return [...groups.entries()].map(([provider, list]) => {
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name))
    return { provider, members: sorted, tone: worstTone(sorted.map((m) => m.tone)) }
  })
}

// ---------- SQLite row ----------

/** A SQLite row's dot: ready, its machine stopped, an operation running, or needs attention. */
export type SqliteState = 'ready' | 'stopped' | 'busy' | 'attention'

/** A SQLite row's state as a status tone (the one dot rule): a stopped machine is a warning, as everywhere. */
export const sqliteTone = (state: SqliteState): ReachStatus['tone'] =>
  state === 'ready' ? 'ok' : state === 'busy' ? 'ongoing' : state === 'stopped' ? 'warning' : 'danger'

export function sqliteState(s: Pick<StoreRow, 'state' | 'blockedBy' | 'op'>, machineState: string | null | undefined, job: Pick<StorageJob, 'ended'> | null | undefined): SqliteState {
  if ((job && !job.ended) || s.state === 'busy' || s.op) return 'busy'
  if (machineState === 'stopped' || (s.state === 'blocked' && s.blockedBy?.reason === 'stopped')) return 'stopped'
  if (s.state === 'broken' || s.state === 'blocked' || s.state === 'unknown') return 'attention'
  return 'ready'
}

export interface BackupSummary {
  /** Linked buckets. */
  buckets: number
  /** The newest backup that worked, of any bucket. */
  last: number | null
  /** Buckets whose last attempt failed. */
  failed: number
}

/** A SQLite Store's backups in a few numbers: linked buckets, the last success and the failed attempts. */
export function backupSummary(s: StoreRow, buckets: readonly BucketRow[]): BackupSummary {
  const backups = storeBackups(s, buckets)
  const times = s.links.map((l) => l.last?.at ?? null).filter((n): n is number => n !== null)
  return {
    buckets: backups.length,
    last: times.length ? Math.max(...times) : null,
    failed: s.links.filter((l) => linkFailed(l)).length,
  }
}

/** Whether a link's last attempt failed after (or without) its last success. */
export const linkFailed = (l: StoreRow['links'][number]): boolean =>
  !!l.attempt?.error && (l.last?.at == null || (l.attempt.at ?? 0) > l.last.at)

// ---------- attach picker ----------

/**
 * Why a machine cannot attach before any test (each with its one action, or
 * none). Whether it reaches the Store's address is never predicted: the
 * picker's Test (and Attach's own check) runs from the machine.
 */
export type AttachBlock = 'stopped' | 'platform'

export interface AttachMachine { name: string, platform: string, block: AttachBlock | null }
export interface ProviderGroup<T> { platform: string, items: T[] }

/** A machine record as the picker reads it. */
export interface PickerMachine { name: string, platform: string, state?: string | null, supports?: readonly string[] | null }

/** Why `m` cannot attach: it cannot run PostgreSQL Sandboxes, or it is stopped. */
export function attachBlock(m: PickerMachine): AttachBlock | null {
  if (m.supports && !m.supports.includes('postgresql_sandbox')) return 'platform'
  if (m.state === 'stopped') return 'stopped'
  return null
}

/** Group items by provider (platform), providers and items by name. */
export function byProvider<T>(items: readonly T[], platformOf: (item: T) => string, nameOf: (item: T) => string): ProviderGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(platformOf(item), [...(groups.get(platformOf(item)) ?? []), item])
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, list]) => ({ platform, items: [...list].sort((a, b) => nameOf(a).localeCompare(nameOf(b))) }))
}

/**
 * The machines a Store's picker lists: every machine not attached yet,
 * grouped by provider, those that cannot attach greyed with why. A search
 * keeps the machines whose name or provider matches.
 */
export function attachMachines(s: Pick<StoreRow, 'attached'>, machines: readonly PickerMachine[], opts: { query?: string, provider?: (platform: string) => string } = {}): ProviderGroup<AttachMachine>[] {
  const attached = new Set((s.attached ?? []).map((a) => a.machine))
  const q = (opts.query ?? '').trim().toLowerCase()
  const rows = machines.filter((m) => !attached.has(m.name))
    .filter((m) => !q || m.name.toLowerCase().includes(q) || (opts.provider?.(m.platform) ?? m.platform).toLowerCase().includes(q))
    .map((m): AttachMachine => ({ name: m.name, platform: m.platform, block: attachBlock(m) }))
  return byProvider(rows, (m) => m.platform, (m) => m.name)
}

/** The connection steps a test shows, in order. */
export const TEST_STEPS = ['address', 'connection', 'tls', 'login', 'database', 'store'] as const
export type TestStep = typeof TEST_STEPS[number]

/** LayerFS's connection step ids (`store.connection.<step>`) as the steps a test shows. */
const STEP_OF: Readonly<Record<string, TestStep>> = {
  configuration: 'address', transport: 'connection', tls: 'tls', authentication: 'login', database: 'database', schema: 'store', identity: 'store',
}
export const STEP_LABEL: Readonly<Record<TestStep, StorageKey>> = {
  address: 'stepAddress', connection: 'stepConnection', tls: 'stepTls', login: 'stepLogin', database: 'stepDatabase', store: 'stepStore',
}

/** The step a refused reach stopped at, from LayerFS's `step`; null when it names none (the check never dialled). */
export const testStep = (step: string | null | undefined): TestStep | null => (step ? STEP_OF[step] ?? null : null)

/**
 * A refused test or attach, as a picker row shows it: the step it stopped at
 * (`Failed at login`), or, for a refusal before any connection, a machine
 * that is stopped or needs its update, cannot run PostgreSQL Sandboxes, or
 * another refusal. LayerFS's words stay the tooltip.
 */
export function attachFailure(error: { code: string, message: string, step?: string | null }): { step: TestStep | null, words: StorageKey } {
  const step = testStep(error.step)
  if (step) return { step, words: 'pickFailedAt' }
  if (error.code === 'Unsupported') return { step: null, words: 'pickNoPlatform' }
  if (error.code === 'Unavailable' || error.code === 'Denied') return { step: null, words: REACH_LABEL[failureKey(error.message, error.code)] }
  return { step: null, words: 'pickRefused' }
}

export interface AttachStore { name: string, address: string | null, block: AttachBlock | null }

/** The PostgreSQL Stores a machine's picker lists: those not attached to it, greyed when it cannot run their Sandboxes. */
export function attachStores(machine: PickerMachine, stores: readonly StoreRow[], opts: { query?: string } = {}): AttachStore[] {
  const q = (opts.query ?? '').trim().toLowerCase()
  return stores.filter((s) => s.kind === 'postgresql' && !(s.attached ?? []).some((a) => a.machine === machine.name))
    .filter((s) => !q || s.name.toLowerCase().includes(q) || (pgAddress(s) ?? '').toLowerCase().includes(q))
    .map((s) => ({ name: s.name, address: pgAddress(s), block: attachBlock(machine) }))
    .sort((a, b) => Number(!!a.block) - Number(!!b.block) || a.name.localeCompare(b.name))
}

// ---------- open rows ----------

const OPEN_KEY = 'dsh-layerfs:store-rows-open:'

/** The rows a viewer left open in a view (`sqlite` or `postgresql`); empty when nothing is stored or storage is blocked. */
export function readOpenRows(kind: string): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_KEY + kind) ?? '[]')
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function writeOpenRows(kind: string, open: ReadonlySet<string>): void {
  try { localStorage.setItem(OPEN_KEY + kind, JSON.stringify([...open].sort())) } catch { /* private window or blocked storage */ }
}

/** After Check all: the open set plus every Store whose host check just failed. */
export function openFailed(open: ReadonlySet<string>, checks: readonly { store: string, host: Pick<PgReach, 'ok'> | null }[]): Set<string> {
  const next = new Set(open)
  for (const c of checks) if (c.host && !c.host.ok) next.add(c.store)
  return next
}
