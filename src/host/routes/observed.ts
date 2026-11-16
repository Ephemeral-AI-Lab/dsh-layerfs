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
    /** Which values are null and why (`memory_not_read`, `disk_not_read`, `cpu_unsupported`, `cpu_not_read`). */
    reason: string | null
    /**
     * Cumulative processor time of the whole machine (`/proc/stat`'s first
     * `cpu` line, layerfs-project#182 L1): busy and total microseconds. Absent
     * from a build before the fields; null with `reason` when not read.
     */
    cpuBusyUsec?: number | null
    cpuTotalUsec?: number | null
  }
  dataDisk: {
    path: string | null, fs: string | null
    /** What the measured filesystem is: `host_fs`, `vm_disk` (shared with everything in the Docker VM) or `volume` (the machine's own disk). */
    scope: string | null
    volume: string | null, inodesFree: number | null
  }
  /** The sqlite Stores on the machine; `bytes` null when the file is not there or the deadline came first. */
  stores: { name: string, bytes: number | null, allocated: number | null }[]
  /**
   * The Sandboxes the home records on it, and how many have a daemon that runs
   * now (null: the deadline came first). `items` (layerfs-project#182 L2): one
   * row per recorded Sandbox; absent from a worker of an older build.
   */
  sandboxes: { recorded: number | null, live: number | null, items?: SandboxRow[] }
  complete: boolean
  /** Why it is not complete (`deadline`). */
  reason: string | null
}

/** What a Sandbox's own cgroup has used (`usage` of `sandbox.get` and of `machine.stats` rows). `memoryFile` and `oomKills` are absent from a build before them. */
export interface Usage {
  cpuUsec: number | null
  memoryCurrent: number | null
  memoryPeak: number | null
  /** The `file` line of `memory.stat`: file cache and tmpfs, inside `memoryCurrent`. */
  memoryFile?: number | null
  pids: number | null
  /** The `oom_kill` line of `memory.events`: processes killed for lack of memory, counted since the Sandbox began. */
  oomKills?: number | null
}

/** One `machine.stats` row of a recorded Sandbox (layerfs-project#182 L2). */
export interface SandboxRow {
  name: string
  /** Its daemon process runs (`true`), has ended (`false`), or was not observed (`null`, with `liveReason`). */
  live: boolean | null
  liveReason?: string
  /** When its daemon process started, epoch ms (null when gone or unknown). */
  startedAt: number | null
  usage: Usage | null
  /** Why `usage` is null, or (`no_controller`) why some of its values are. */
  usageReason?: string
}

/** A `usage` object by presence: the newer values only when LayerFS sent them. */
export function usageOf(u: any): Usage | null {
  if (!u || typeof u !== 'object') return null
  return {
    cpuUsec: count(u.cpu_usec), memoryCurrent: count(u.memory_current), memoryPeak: count(u.memory_peak),
    ...('memory_file' in u ? { memoryFile: count(u.memory_file) } : {}),
    pids: count(u.pids),
    ...('oom_kills' in u ? { oomKills: count(u.oom_kills) } : {}),
  }
}

/** One `sandboxes.items` row; null without a name. */
export function sandboxRowOf(row: any): SandboxRow | null {
  const name = text(row?.name)
  if (!name) return null
  const live = row.live === true ? true : row.live === false ? false : null
  const liveReason = text(row.live_reason), usageReason = text(row.usage_reason)
  return {
    name, live, ...(liveReason ? { liveReason } : {}), startedAt: count(row.started_at),
    usage: usageOf(row.usage), ...(usageReason ? { usageReason } : {}),
  }
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
      ...('cpu_busy_usec' in r ? { cpuBusyUsec: count(r.cpu_busy_usec) } : {}),
      ...('cpu_total_usec' in r ? { cpuTotalUsec: count(r.cpu_total_usec) } : {}),
    },
    dataDisk: { path: text(d.path), fs: text(d.fs), scope: text(d.scope), volume: text(d.volume), inodesFree: count(d.inodes_free) },
    stores: (Array.isArray(answer?.stores) ? answer.stores : [])
      .filter((s: any) => s && typeof s.name === 'string' && s.name)
      .map((s: any) => ({ name: s.name as string, bytes: count(s.bytes), allocated: count(s.allocated) })),
    sandboxes: {
      recorded: count(b.recorded), live: count(b.live),
      ...(Array.isArray(b.items) ? { items: b.items.map(sandboxRowOf).filter((x: SandboxRow | null): x is SandboxRow => !!x) } : {}),
    },
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
  usage?: Usage | null
  usageReason?: string
} {
  const out: ReturnType<typeof processOf> = {}
  if (record && 'daemon' in record) {
    const d = record.daemon
    out.daemon = d && typeof d === 'object' ? { pid: count(d.pid), startedAt: count(d.started_at) } : null
  }
  if (record && 'usage' in record) {
    const u = record.usage
    out.usage = usageOf(u)
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
