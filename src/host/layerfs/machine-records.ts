/**
 * The 2.0 machine records as this host reads them (call-surface-2-0 `machine`
 * rows): `machine list --detail` / `machine get --detail` items, and the
 * `op` companion. Shared by the Machines routes, the Storage and Projects
 * routes and the session service, so each reads a machine one way.
 */
import type { Lfs } from './cli.ts'
import { hostNameFor, type HostMachineName } from '../../shared/host-machine.ts'

export { HOST_PLATFORM, PROCESS_BACKEND, isHostMachine, isHostName } from '../../shared/host-machine.ts'

/**
 * This computer's host machine (layerfs #835): `macos-host` on macOS,
 * `linux-host` on Linux (a Windows host reaches LayerFS through a Linux
 * worker, whose host is `linux-host`). The default where a caller needs a name
 * before anything is read; listed machines say it by `platform: "host"`.
 */
export const HOST_MACHINE: HostMachineName = hostNameFor(process.platform) ?? 'linux-host'

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const list = (value: any): any[] => (Array.isArray(value) ? value : [])

/** The six states of LayerFS 2.0 (`calls.json` `states`); a machine is never `blocked`. */
export const STATES = new Set(['ready', 'busy', 'stopped', 'blocked', 'broken', 'unknown'])

/**
 * A 2.0 `op` companion (`{ name, phase, started_at }`: a busy machine's,
 * Store's, Sandbox's or Workspace's) as the page reads it, or null. 2.0 has no
 * uncertain op: an outcome that is not known is `broken` with reason
 * `unresolved`, so `uncertain` is always false.
 */
export const opOf = (o: any) => {
  if (!o || typeof o !== 'object' || typeof o.name !== 'string') return null
  const at = typeof o.started_at === 'string' ? Date.parse(o.started_at) : NaN
  return { id: '', name: o.name as string, phase: text(o.phase) ?? '', started: Number.isFinite(at) ? at : null, uncertain: false }
}

/** An ISO time (2.0 `*_at`) as epoch ms, or null. */
export const msAt = (v: unknown): number | null => { if (typeof v !== 'string') return null; const at = Date.parse(v); return Number.isFinite(at) ? at : null }

/**
 * The machines attached to a PostgreSQL Store record (`store get` /
 * `store list` `machines`: names, or `{ machine, reached, reach }` rows) in
 * LayerFS's order. A machine attached but not checked yet has no reach
 * (`reached` null).
 */
export function attachedOf(s: any): { machine: string, reached: 'ok' | 'failed' | null, reach: any }[] {
  const rows: any[] = (Array.isArray(s?.machines) ? s.machines : []).map((r: any) => (typeof r === 'string' ? { machine: r } : r))
    .filter((r: any) => typeof r?.machine === 'string' && r.machine)
  return rows.map((r) => {
    const reach = r.reach && typeof r.reach === 'object' ? r.reach : null
    const reached = r.reached === 'ok' || r.reached === 'failed' ? r.reached : reach ? (reach.ok === true ? 'ok' : 'failed') : null
    return { machine: String(r.machine), reached, reach }
  })
}

/** A 2.0 thing's state companions: `blocked_by`, `reason`, `fix`, `message`, `observed_at` (absent when LayerFS gave none). */
export function companionsOf(s: any): { blockedBy?: { machine?: string, store?: string, sandbox?: string, reason: string }, reason?: string, fix?: string, message?: string, observedAt?: number } {
  const out: ReturnType<typeof companionsOf> = {}
  const b = s?.blocked_by
  if (b && typeof b === 'object') out.blockedBy = { ...(typeof b.machine === 'string' ? { machine: b.machine } : {}), ...(typeof b.store === 'string' ? { store: b.store } : {}), ...(typeof b.sandbox === 'string' ? { sandbox: b.sandbox } : {}), reason: String(b.reason ?? '') }
  if (typeof s?.reason === 'string' && s.reason) out.reason = s.reason
  if (typeof s?.fix === 'string' && s.fix) out.fix = s.fix
  if (typeof s?.message === 'string' && s.message) out.message = s.message
  const seen = msAt(s?.observed_at)
  if (seen !== null) out.observedAt = seen
  return out
}

/**
 * One machine of `machine list --detail` or `machine get --detail` (the 2.0
 * long form), as the page reads it: the six-state `state` (a short-form row
 * that leaves it out is `ready`) with its companion (`op` when busy, `reason`
 * and `fix` when broken, `observed_at` from the last live read), `supports`
 * as LayerFS lists it, sizes in bytes.
 */
export function machineOf(m: any) {
  const state = text(m.state) ?? 'ready'
  return {
    name: String(m.machine),
    // empty for a record LayerFS could not read (it lists the machine `broken`/`failed` with no platform)
    platform: text(m.platform) ?? '',
    backend: text(m.backend),
    // the SDK's state, as it is (#537 U4)
    state: STATES.has(state) ? state : 'unknown',
    op: opOf(m.op),
    reason: text(m.reason),
    fix: text(m.fix),
    message: text(m.message),
    observedAt: text(m.observed_at),
    // `sqlite`, `postgresql_sandbox`, `log` (the machine has a worker log to read)
    supports: list(m.supports).map(String),
    cpus: num(m.cpus),
    memory: num(m.memory_bytes),
    disk: num(m.disk_bytes),
    // the first 20 names; `stores_count` / `sandboxes_count` sit beside a cut list
    stores: list(m.stores).map(String),
    sandboxes: list(m.sandboxes).map(String),
    storesCount: num(m.stores_count) ?? list(m.stores).length,
    sandboxesCount: num(m.sandboxes_count) ?? list(m.sandboxes).length,
    ...(text(m.image) ? { image: m.image } : {}),
    ...(text(m.os_image) ? { osImage: m.os_image } : {}),
    ...(text(m.docker) ? { docker: m.docker } : {}),
    ...(text(m.wsl) ? { wsl: m.wsl } : {}),
    ...(text(m.daemon) ? { daemon: m.daemon } : {}),
  }
}

/**
 * A machine whose record LayerFS cannot read: `machine list` names it
 * `broken` with reason `failed`, no platform and the fix `layerfs machine
 * doctor <name>`; `machine get`, `remove` and `update` refuse it `Failed`.
 */
export const unreadableRecord = (m: { state?: string | null, reason?: string | null, platform?: string | null }): boolean =>
  m.state === 'broken' && m.reason === 'failed' && !m.platform

/**
 * A machine's record (`machine list --detail` / `machine get --detail`, no
 * live read) with its live probe (`machine get --with live`) over it. The
 * probe's answer is the newer word on a machine, except that a record-level
 * broken state (unreadable, outdated, unsupported, no 2.0 name) wins with its
 * reason, fix and message: a live read that answers `unknown` (or anything
 * else) never hides the record's broken state and its fix (UI pass 2 F1;
 * LayerFS LF4 makes the live read keep it too).
 */
export function probedRecord(record: any, got: any): any {
  if (!got || typeof got !== 'object') return record
  const merged = { ...record, ...got, machine: record?.machine ?? got.machine }
  if (record?.state !== 'broken') return merged
  for (const key of ['state', 'reason', 'fix', 'message', 'op'] as const) {
    if (record[key] === undefined || record[key] === null) delete merged[key]
    else merged[key] = record[key]
  }
  return merged
}

/** A machine as the page and the host read it. */
export type MachineRecord = ReturnType<typeof machineOf>

/** Every machine of the home, from records (`machine list --detail`, no probe). */
export async function machineRows(lfs: Lfs, options: { timeout_ms?: number } = {}): Promise<MachineRecord[]> {
  return list((await lfs.machine.list({ detail: true, ...options }))?.items).map(machineOf)
}

/** Whether a machine's record says it runs PostgreSQL Sandboxes (a row without `supports` is not ruled out). */
export const runsPostgresql = (m: { supports?: readonly string[] | null }): boolean => !m.supports || m.supports.includes('postgresql_sandbox')
/** Whether a machine's record says it holds sqlite Stores (a row without `supports` is not ruled out). */
export const holdsSqlite = (m: { supports?: readonly string[] | null }): boolean => !m.supports || m.supports.includes('sqlite')
