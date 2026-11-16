/**
 * The machine page's tabs, pure (MachineTabs.tsx draws them): which tabs a
 * machine page has, the Sandboxes tab's one row per Sandbox (its record, the
 * sampler's newest values and its run folder on disk, joined by name), and
 * what the Overview's "needs you" notices count.
 */
import type { MachineSandbox } from './model.ts'
import type { SandboxSpace } from './space.ts'

export type MachineTab = 'overview' | 'sandboxes' | 'stores' | 'usage' | 'disk' | 'files' | 'log'

/** The tabs a machine page has, in order: Usage needs machine.stats, Disk machine.space, Files machine.files, Worker log logs.machine and a worker log. */
export function machineTabs(has: { usage: boolean, disk: boolean, files: boolean, log: boolean }): MachineTab[] {
  return ['overview', 'sandboxes', 'stores', ...(has.usage ? ['usage' as const] : []), ...(has.disk ? ['disk' as const] : []),
    ...(has.files ? ['files' as const] : []), ...(has.log ? ['log' as const] : [])]
}

/** What the Sandboxes tab needs of one sampler row (metrics.ts `sandboxTable`). */
export interface MetricsRowLike { name: string, closedAt: number | null }

/** One Sandboxes-tab row: `record` null for a Sandbox closed within the sampler's hour (only its values remain). */
export interface SandboxTabRow<M extends MetricsRowLike> { name: string, record: MachineSandbox | null, metrics: M | null, space: SandboxSpace | null }

/**
 * The Sandboxes tab's rows: every recorded Sandbox (those that need you
 * first, then as listed), each with its sampler values and disk row, then,
 * with `showClosed`, those closed within the hour. `closed` counts them
 * either way, for the switch.
 */
export function sandboxTabRows<M extends MetricsRowLike>(records: readonly MachineSandbox[], metrics: readonly M[], space: readonly SandboxSpace[] | null,
  needsYou: (b: MachineSandbox) => boolean, showClosed: boolean): { rows: SandboxTabRow<M>[], closed: number } {
  const byName = new Map(metrics.map((r) => [r.name, r]))
  const disk = new Map((space ?? []).map((r) => [r.name, r]))
  const recorded = new Set(records.map((b) => b.name))
  const ordered = [...records.filter(needsYou), ...records.filter((b) => !needsYou(b))]
  const rows: SandboxTabRow<M>[] = ordered.map((b) => ({ name: b.name, record: b, metrics: byName.get(b.name) ?? null, space: disk.get(b.name) ?? null }))
  const closed = metrics.filter((r) => r.closedAt != null && !recorded.has(r.name))
  if (showClosed) rows.push(...closed.map((r) => ({ name: r.name, record: null, metrics: r, space: null })))
  return { rows, closed: closed.length }
}

/**
 * What the Overview flags: gone Sandboxes (their daemon ended with the
 * machine, their run folder stays until closed) with the bytes LayerFS
 * measured for them (null when not measured), and the other Sandboxes that
 * need you.
 */
export function sandboxAttention(records: readonly MachineSandbox[], space: readonly SandboxSpace[] | null, needsYou: (b: MachineSandbox) => boolean): { gone: number, goneBytes: number | null, needsYou: number } {
  const gone = records.filter((b) => b.state === 'gone')
  const disk = new Map((space ?? []).map((r) => [r.name, r.bytes]))
  const measured = gone.map((b) => disk.get(b.name)).filter((n): n is number => n != null)
  return {
    gone: gone.length,
    goneBytes: measured.length ? measured.reduce((a, b) => a + b, 0) : null,
    needsYou: records.filter((b) => b.state !== 'gone' && needsYou(b)).length,
  }
}
