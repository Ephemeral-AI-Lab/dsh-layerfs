/**
 * Whether a project conversation's Store can execute right now, from read-only
 * LayerFS facts. LayerFS has no change events, so the host polls `store.list`
 * (one call for every Store; it starts no machine) and, for PostgreSQL Stores
 * that are never `down`, `store.status` → `server.reachable`.
 *
 *   available    idle | in_use, no op
 *   transient    busy, or an op in flight (push/pull/remove): wait, never deactivate
 *   unavailable  down | unresolved | PostgreSQL server unreachable
 *   removed      the Store is no longer listed
 *   unknown      a state this build does not name: never deactivate on it
 *
 * Machine state is not used: a machine reads `running` while its worker is of
 * another build and every Store on it is `down`.
 */

export type StoreHealthState = 'available' | 'transient' | 'unavailable' | 'removed' | 'unknown'
export interface StoreHealth { readonly state: StoreHealthState, readonly reason?: string }

/** A `store.list` row or a `store.status` result (both carry `state` and, when known, `op`). */
export function classifyStore(row: any | undefined, status?: any): StoreHealth {
  if (!row) return { state: 'removed', reason: 'The project Store is no longer listed in this LayerFS home. Conversation history is retained.' }
  const server = status?.server ?? row.server
  if ((row.kind ?? status?.kind) === 'postgresql' && server && server.reachable === false) {
    const detail = server.error ?? server.unavailable
    return { state: 'unavailable', reason: `The PostgreSQL server of ${row.name ? `Store ${row.name}` : 'the project Store'} did not answer${detail ? `: ${detail}` : '.'}` }
  }
  const state = status?.state ?? row.state
  const op = status?.op ?? row.op
  const downReason = status?.down_reason ?? row.down_reason
  if (state === 'down') return { state: 'unavailable', reason: downReason ?? 'The project Store\'s machine did not answer.' }
  if (state === 'unresolved') return { state: 'unavailable', reason: `An earlier Store operation${op?.name ? ` (${op.name})` : ''} left an uncertain outcome; resolve it on the Storage page.` }
  if (state === 'busy' || op) return { state: 'transient', reason: `The project Store is busy${op?.name ? ` (${op.name})` : ''}.` }
  if (state === 'idle' || state === 'in_use') return downReason ? { state: 'unavailable', reason: downReason } : { state: 'available' }
  return { state: 'unknown', reason: state ? `The project Store reads ${String(state)}.` : undefined }
}

/** The Store name a project key (`<store>/<project>`) lives in. */
export const storeOf = (project: string | undefined): string | undefined => project?.split('/')[0] || undefined

/**
 * The machine a PostgreSQL Store's Sandboxes run on (`store.attach`): `preferred`
 * when the Store is attached to it, else `native` when attached, else the first
 * machine whose check passed, else the first attached. A record without
 * `machines` comes from a CLI before attachments: `preferred`, else `native`.
 * Null when the Store is attached to no machine.
 */
export function pgMachineOf(record: any, preferred?: string | null): string | null {
  const machines = record?.machines
  if (!machines || typeof machines !== 'object') return preferred || 'native'
  const names = Object.keys(machines)
  if (preferred && names.includes(preferred)) return preferred
  if (names.includes('native')) return 'native'
  return names.find((m) => machines[m]?.checked) ?? names[0] ?? null
}
