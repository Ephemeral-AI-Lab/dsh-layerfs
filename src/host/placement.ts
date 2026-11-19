/**
 * Where a PostgreSQL project's Sandboxes run (spec v23 V23-11). A PostgreSQL
 * Store is on no machine and has no Store-wide default: the machine is
 * chosen when a session or Sandbox is made, from the machines that are
 * running, run PostgreSQL Sandboxes and are not broken. When none is named:
 *
 *   1. the machine the project's newest Sandbox ran on;
 *   2. a machine the Store's database was reached from (`store get`
 *      `connections`, `reached: ok`), in LayerFS's row order;
 *   3. `native`.
 *
 * Never a broken or stopped machine. Nothing is written anywhere: the choice
 * belongs to the session or Sandbox that is made.
 */
import { runsPostgresql } from './layerfs/machine-records.ts'

/** A machine as `machine list --detail` names it (machine-records.ts), as far as the choice needs. */
export interface PlacementMachine { name: string, state?: string | null, supports?: readonly string[] | null }

/** Whether a new PostgreSQL Sandbox may be placed on `m`: it runs, runs PostgreSQL Sandboxes and is not broken. */
export const placeable = (m: PlacementMachine): boolean => runsPostgresql(m) && (m.state ?? 'ready') === 'ready'

/** The machines `store get --detail` names as reached (`connections[].reached` `ok`), this computer as `native`. */
export function reachedFrom(store: any): string[] {
  const rows: any[] = Array.isArray(store?.connections) ? store.connections : []
  return rows.filter((r) => r?.reached === 'ok').map((r) => (typeof r.machine === 'string' && r.machine ? r.machine : 'native'))
}

/** The machine of the newest of a project's `sandbox list --detail` rows, or null. */
export function lastUsed(sandboxes: readonly any[]): string | null {
  const at = (s: any) => { const t = Date.parse(String(s?.created_at ?? '')); return Number.isFinite(t) ? t : 0 }
  const newest = [...sandboxes].filter((s) => typeof s?.machine === 'string' && s.machine).sort((a, b) => at(b) - at(a))[0]
  return newest ? String(newest.machine) : null
}

/** The machine a new PostgreSQL Sandbox runs on when none is named (the order above). */
export function pgPlacement(machines: readonly PlacementMachine[], { last, reached }: { last?: string | null, reached?: readonly string[] } = {}): string {
  const ok = (name: string | null | undefined): name is string => !!name && machines.some((m) => m.name === name && placeable(m))
  if (ok(last)) return last
  return (reached ?? []).find(ok) ?? 'native'
}
