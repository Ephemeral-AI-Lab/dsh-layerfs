/**
 * Where a PostgreSQL project's Sandboxes run (spec v23 V23-11). A PostgreSQL
 * Store is on no machine and has no Store-wide default: a Sandbox runs only
 * on a machine attached to the Store (`native` is an ordinary machine, attached
 * or not). When none is named:
 *
 *   1. the machine the project's newest Sandbox ran on, while it is attached
 *      and running (and not broken);
 *   2. the only machine attached to the Store, as LayerFS itself picks;
 *   3. none (null): the caller names no machine, and LayerFS refuses
 *      `InvalidInput`, with the `store attach` fix when none is attached, or
 *      `next.machines` to pick from when several are.
 *
 * Nothing is written anywhere: the choice belongs to the session or Sandbox
 * that is made.
 */
import { attachedOf, runsPostgresql } from './layerfs/machine-records.ts'

/** A machine as `machine list --detail` names it (machine-records.ts), as far as the choice needs. */
export interface PlacementMachine { name: string, state?: string | null, supports?: readonly string[] | null }

/** Whether a new PostgreSQL Sandbox may be placed on `m`: it runs, runs PostgreSQL Sandboxes and is not broken. */
export const placeable = (m: PlacementMachine): boolean => runsPostgresql(m) && (m.state ?? 'ready') === 'ready'

/**
 * The machines attached to a PostgreSQL Store ({@link attachedOf}:
 * `store get --detail` `machines`, names or `{ machine, reached }` rows):
 * those whose last check reached the database first, then the rest, each
 * in LayerFS's order.
 */
export function attachedFrom(store: any): string[] {
  const rows = attachedOf(store)
  return [...rows.filter((r) => r.reached === 'ok'), ...rows.filter((r) => r.reached !== 'ok')].map((r) => r.machine)
}

/** The machine of the newest of a project's `sandbox list --detail` rows, or null. */
export function lastUsed(sandboxes: readonly any[]): string | null {
  const at = (s: any) => { const t = Date.parse(String(s?.created_at ?? '')); return Number.isFinite(t) ? t : 0 }
  const newest = [...sandboxes].filter((s) => typeof s?.machine === 'string' && s.machine).sort((a, b) => at(b) - at(a))[0]
  return newest ? String(newest.machine) : null
}

/** The machine a new PostgreSQL Sandbox runs on when none is named (the order above), or null; `attached` from {@link attachedFrom}. */
export function pgPlacement(machines: readonly PlacementMachine[], { last, attached }: { last?: string | null, attached: readonly string[] }): string | null {
  const ok = (name: string | null | undefined): name is string => !!name && machines.some((m) => m.name === name && placeable(m))
  if (ok(last) && attached.includes(last)) return last
  return attached.length === 1 ? attached[0]! : null
}
