/**
 * Observed values as the pages read them (layerfs-project#164, #180): a
 * machine's `machine.stats` answer, a Sandbox's `live` in `sandbox.list`, its
 * `daemon` and `usage` in `sandbox.get`, and the leftovers in `layerfs
 * doctor`'s report. Everything is read by presence: a field LayerFS did not
 * send stays absent, and a `null` it sent stays `null` (not observed), never
 * zero. No value here is derived from a record.
 */
import type { Stale } from './inspect.ts'

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
/** A count or a size: a finite number that is not negative (an exact integer past 2^53 as the nearest number); else null. */
const count = (value: unknown): number | null => {
  const n = typeof value === 'bigint' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

// ---------------------------------------------------------------- machine.stats

/** What `machine.stats` observed. Every number is LayerFS's own; `null` is "not observed". */
export interface MachineStats {
  platform: string | null
  /** When the answering side observed it (its clock), epoch ms. */
  observedAt: number | null
  /** The machine's worker process; null on a machine whose calls run in the caller's process (native). */
  worker: { version: string | null, pid: number | null, startedAt: number | null, protocol: string | null, bundle: string | null } | null
  resources: {
    cpus: number | null, memoryTotal: number | null, memoryUsed: number | null
    diskTotal: number | null, diskUsed: number | null, diskFree: number | null
    /** Whose processors and memory: `host`, `engine_host` (the kernel Docker runs on) or `vm`; another word as it came. */
    scope: string | null
    /** Which values are null and why (`memory_not_read`, `disk_not_read`). */
    reason: string | null
  }
  dataDisk: {
    path: string | null, fs: string | null
    /** What the measured filesystem is: `host_fs`, `vm_disk` (shared with everything in the Docker VM) or `volume` (the machine's own disk). */
    scope: string | null
    volume: string | null, inodesFree: number | null
  }
  /** The sqlite Stores on the machine; `bytes` null when the file is not there or the deadline came first. */
  stores: { name: string, bytes: number | null, allocated: number | null }[]
  /** The Sandboxes the home records on it, and how many have a daemon that runs now (null: the deadline came first). */
  sandboxes: { recorded: number | null, live: number | null }
  complete: boolean
  /** Why it is not complete (`deadline`). */
  reason: string | null
}

/** `GET /api/machines/:id/stats`. */
export interface MachineStatsView {
  machine: string
  /** When this host answered. */
  readAt: number
  /** When `stats` was read from LayerFS (this host's clock); null when there is none. */
  at: number | null
  /** The last good answer; null when the machine never answered on this host. */
  stats: MachineStats | null
  /** This read was refused (`code`, `message`): `stats` is what was read before. */
  stale: false | Stale
}

/** How long a machine's stats answer serves every page that asks (one CLI process per machine in this time, whoever polls). */
export const STATS_KEEP_MS = 5000

/** A `machine.stats` answer as the page reads it. */
export function statsAnswer(answer: any): MachineStats {
  const w = answer?.worker, r = answer?.resources ?? {}, d = answer?.data_disk ?? {}, b = answer?.sandboxes ?? {}
  return {
    platform: text(answer?.platform),
    observedAt: count(answer?.observed_at),
    worker: w && typeof w === 'object'
      ? { version: text(w.version), pid: count(w.pid), startedAt: count(w.started_at), protocol: w.protocol == null ? null : String(w.protocol), bundle: text(w.bundle) }
      : null,
    resources: {
      cpus: count(r.cpus), memoryTotal: count(r.memory_total), memoryUsed: count(r.memory_used),
      diskTotal: count(r.disk_total), diskUsed: count(r.disk_used), diskFree: count(r.disk_free),
      scope: text(r.scope), reason: text(r.reason),
    },
    dataDisk: { path: text(d.path), fs: text(d.fs), scope: text(d.scope), volume: text(d.volume), inodesFree: count(d.inodes_free) },
    stores: (Array.isArray(answer?.stores) ? answer.stores : [])
      .filter((s: any) => s && typeof s.name === 'string' && s.name)
      .map((s: any) => ({ name: s.name as string, bytes: count(s.bytes), allocated: count(s.allocated) })),
    sandboxes: { recorded: count(b.recorded), live: count(b.live) },
    complete: answer?.complete !== false,
    reason: text(answer?.reason),
  }
}

// ---------------------------------------------------------------- sandbox.list live, sandbox.get daemon and usage

/**
 * `live` of a `sandbox.list --live` item, by presence: absent without the
 * option (an older CLI), `true` / `false` as LayerFS observed the daemon
 * process, `null` with `liveReason` when it could not be observed.
 */
export function liveOf(item: any): { live?: boolean | null, liveReason?: string } {
  if (!item || !('live' in item)) return {}
  const live = item.live === true ? true : item.live === false ? false : null
  const reason = text(item.live_reason)
  return { live, ...(reason ? { liveReason: reason } : {}) }
}

/**
 * `daemon`, `usage` and `usage_reason` of `sandbox.get`, by presence: absent
 * from a CLI before the fields; `null` when LayerFS observed none. The reason
 * comes with a null `usage`, and also beside a `usage` whose memory or
 * process counts are null (`no_controller`).
 */
export function processOf(record: any): {
  daemon?: { pid: number | null, startedAt: number | null } | null
  usage?: { cpuUsec: number | null, memoryCurrent: number | null, memoryPeak: number | null, pids: number | null } | null
  usageReason?: string
} {
  const out: ReturnType<typeof processOf> = {}
  if (record && 'daemon' in record) {
    const d = record.daemon
    out.daemon = d && typeof d === 'object' ? { pid: count(d.pid), startedAt: count(d.started_at) } : null
  }
  if (record && 'usage' in record) {
    const u = record.usage
    out.usage = u && typeof u === 'object' ? { cpuUsec: count(u.cpu_usec), memoryCurrent: count(u.memory_current), memoryPeak: count(u.memory_peak), pids: count(u.pids) } : null
    // the reason there is no usage, or (`no_controller`) why a usage that is there has no memory or process counts
    const reason = text(record.usage_reason)
    if (reason) out.usageReason = reason
  }
  return out
}

// ---------------------------------------------------------------- doctor leftovers

/** One thing an interrupted operation left on a machine (`layerfs doctor`, a finding's `leftover`). */
export interface Leftover {
  machine: string
  /** `run-folder`, `empty-root`, `init-copy`, `backup-staging`, `image-tmp`, `image-part`; another word as it came. */
  kind: string
  path: string
  /** Its size; null when the walk's bound ended before it was measured. */
  bytes: number | null
  /** Seconds since it last changed. */
  age: number | null
  /** What `layerfs doctor fix <id>` takes. */
  id: string
  /** False for an entry LayerFS only reports (`doctor fix` refuses it). */
  fixable: boolean
  /** `doctor fix` is refused before this time (epoch ms), when LayerFS says one. */
  notBefore?: number
}

/** One machine `layerfs doctor` walked for leftovers, with what it only counts (LayerFS keeps them). */
export interface LeftoverWalk { machine: string, complete: boolean, imageLocks: number, unmountMarkers: number }

/** A finding's `leftover`, or null when it has none or it names no id. */
export function leftoverOf(finding: any): Leftover | null {
  const l = finding?.leftover
  if (!l || typeof l !== 'object') return null
  const id = text(l.id), path = text(l.path), kind = text(l.kind)
  if (!id || !path || !kind) return null
  const notBefore = count(l.not_before)
  return {
    machine: text(l.machine) ?? id.split(':')[0]!, kind, path, bytes: count(l.bytes), age: count(l.age), id,
    fixable: l.fixable !== false, ...(notBefore !== null ? { notBefore } : {}),
  }
}

/** The report's `leftovers`: one row per machine walked. */
export function walksOf(report: any): LeftoverWalk[] {
  return (Array.isArray(report?.leftovers) ? report.leftovers : [])
    .filter((row: any) => row && typeof row.machine === 'string' && row.machine)
    .map((row: any) => ({ machine: row.machine as string, complete: row.complete !== false, imageLocks: count(row.image_locks) ?? 0, unmountMarkers: count(row.unmount_markers) ?? 0 }))
}
