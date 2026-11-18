/**
 * Where a machine's data disk goes (`machine stats --with space`): how full it is, how
 * much of it is LayerFS's own data by part, and how much is not LayerFS's.
 * Pure: no React, no host calls. The answer comes from the host's
 * `GET /api/machines/:id/space` (one bounded walk where the machine's data
 * is, kept a minute per machine).
 *
 * Every size is LayerFS's own number; a part LayerFS did not reach is `null`
 * and is shown as not read, never as zero. When the walk stopped early
 * (`complete: false`) every size is a lower bound and what is not LayerFS's
 * is not known.
 */
import type { MachinesKey } from './locale.ts'
import type { StatsStale } from './stats.ts'
import { gib, type Words } from './model.ts'

const w = (key: MachinesKey, values?: Record<string, string>): Words => ({ key, ...(values ? { values } : {}) })

/** One recorded Sandbox's run folder by part (host `SandboxSpace`). */
export interface SandboxSpace {
  name: string
  bytes: number | null
  overlays: number | null
  writes: number | null
  home: number | null
  log: number | null
  runtime: number | null
  reason?: string
}

/** What `machine stats --with space` answered (host `MachineSpace`). */
export interface MachineSpace {
  platform: string | null
  observedAt: number | null
  disk: { total: number | null, used: number | null, free: number | null, path: string | null, fs: string | null, scope: string | null }
  layerfs: number | null
  outside: number | null
  parts: { stores: number | null, sandboxes: number | null, images: number | null, otherRuns: number | null, logs: number | null, other: number | null }
  stores: { name: string, bytes: number | null }[]
  sandboxes: SandboxSpace[]
  unreadable: number
  complete: boolean
  reason: string | null
}

/** `GET /api/machines/:id/space` (host `MachineSpaceView`). */
export interface SpaceView {
  machine: string
  readAt: number
  at: number | null
  space: MachineSpace | null
  stale: false | StatsStale
}

const GIB = 2 ** 30

/** A size in the disk views: 0 KiB for nothing, KiB under a MiB, else as the page's other disk sizes (MiB, GiB). */
export function spaceSize(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 2 ** 20) return `${n <= 0 ? 0 : Math.max(1, Math.round(n / 1024))} KiB`
  return gib(n)
}

/**
 * How full a data disk is: `low` under 15 % or 5 GiB free, `critical` under
 * 5 % or 2 GiB free; null when free or total was not observed. Both bounds,
 * so a small VM volume is not called full at half use and a large disk still
 * warns before its last few GiB.
 */
export type DiskLevel = 'ok' | 'low' | 'critical'
export function diskLevel(free: number | null | undefined, total: number | null | undefined): DiskLevel | null {
  if (free == null || total == null || total <= 0) return null
  const share = free / total
  if (share < 0.05 || free < 2 * GIB) return 'critical'
  if (share < 0.15 || free < 5 * GIB) return 'low'
  return 'ok'
}

/** One row of "where the space goes": what it is, its size, and why it is not known. */
export interface SpaceRow {
  key: 'stores' | 'overlays' | 'sandboxFiles' | 'sandboxRuntime' | 'images' | 'otherRuns' | 'logs' | 'outside' | 'free'
  /** Part of LayerFS's own data (drawn in the LayerFS shades), else not LayerFS's or free. */
  layerfs: boolean
  bytes: number | null
}

const sum = (values: (number | null | undefined)[]): number | null => {
  const known = values.filter((v): v is number => v != null)
  return known.length ? known.reduce((a, b) => a + b, 0) : null
}

/**
 * The rows of a machine's breakdown, LayerFS's first: Stores, Workspace
 * overlays, what the Sandboxes' own commands wrote (their own layer and
 * home), the Sandboxes' runtime copies and logs, the image cache, run
 * folders no Sandbox names, LayerFS's logs and records; then what is not
 * LayerFS's, then free. A LayerFS row of 0 bytes is left out; one not read
 * stays, with a null size.
 */
export function spaceRows(space: MachineSpace): SpaceRow[] {
  const p = space.parts, rows = space.sandboxes
  const measured = rows.filter((r) => r.bytes != null)
  const sandboxPart = (pick: (r: SandboxSpace) => (number | null)[]) => (p.sandboxes == null ? null : sum(measured.flatMap(pick)) ?? 0)
  const layerfs: SpaceRow[] = [
    { key: 'stores', layerfs: true, bytes: p.stores },
    { key: 'overlays', layerfs: true, bytes: sandboxPart((r) => [r.overlays]) },
    { key: 'sandboxFiles', layerfs: true, bytes: sandboxPart((r) => [r.writes, r.home]) },
    { key: 'sandboxRuntime', layerfs: true, bytes: sandboxPart((r) => [r.runtime, r.log]) },
    { key: 'images', layerfs: true, bytes: p.images },
    { key: 'otherRuns', layerfs: true, bytes: p.otherRuns },
    { key: 'logs', layerfs: true, bytes: p.logs == null && p.other == null ? null : (p.logs ?? 0) + (p.other ?? 0) },
  ]
  return [
    ...layerfs.filter((r) => r.bytes !== 0),
    { key: 'outside', layerfs: false, bytes: space.outside },
    { key: 'free', layerfs: false, bytes: space.disk.free },
  ]
}

/**
 * The three spans of a disk bar, as shares of the disk's total: LayerFS's
 * data, what is not LayerFS's, and free. When the walk stopped early, the
 * used space LayerFS did not split is `unsplit` (and `outside` is 0). Null
 * without a total.
 */
export function diskSpans(space: MachineSpace): { layerfs: number, outside: number, unsplit: number, free: number } | null {
  const { total, used, free } = space.disk
  if (total == null || total <= 0) return null
  const share = (n: number | null) => Math.max(0, Math.min(1, (n ?? 0) / total))
  const layerfs = share(space.layerfs)
  const usedShare = used != null ? share(used) : Math.max(0, 1 - share(free))
  if (space.outside != null) return { layerfs, outside: share(space.outside), unsplit: 0, free: share(free) }
  return { layerfs, outside: 0, unsplit: Math.max(0, usedShare - layerfs), free: share(free) }
}

/** What fills the part of the disk that is not LayerFS's, by what that filesystem is (`disk.scope`). */
export function outsideWords(scope: string | null): Words {
  if (scope === 'vm_disk') return w('spaceOutsideVmDisk')
  if (scope === 'host_fs') return w('spaceOutsideHost')
  if (scope === 'volume') return w('spaceOutsideVolume')
  return w('spaceOutsideOther')
}

/** The command a user runs themself to see what fills a Docker VM's disk; none elsewhere (LayerFS never removes what is not its own). */
export function outsideCommand(scope: string | null): string | null {
  return scope === 'vm_disk' ? 'docker system df' : null
}

/** Why a Sandbox's run folder was not measured, in words; an unknown word as it came. */
export function sandboxSpaceReason(reason: string | undefined): Words | null {
  if (!reason) return null
  if (reason === 'no_run_folder') return w('spaceNoRunFolder')
  if (reason === 'outside_run_root') return w('spaceOutsideRunRoot')
  if (reason === 'record_unreadable') return w('spaceRecordUnreadable')
  if (reason === 'deadline') return w('spaceDeadline')
  return w('raw', { text: reason })
}

/** A machine's Sandbox rows, the largest first; rows not measured last, by name. */
export function sandboxesBySize(space: MachineSpace): SandboxSpace[] {
  return [...space.sandboxes].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name))
}
