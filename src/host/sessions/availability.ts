/**
 * Whether a project conversation's Store can execute right now, from read-only
 * LayerFS 2.0 facts. LayerFS has no change events, so the host polls
 * `store list --detail` (records: one call for every Store; it starts no
 * machine) and, for a PostgreSQL Store now and then, `store get --with live`
 * (a live read of its server from this computer).
 *
 *   available    ready, no op
 *   transient    busy (move, remove, compact, backup, restore): wait, never deactivate
 *   unavailable  blocked by its machine, or broken (unresolved, missing, unreachable)
 *   removed      the Store is no longer listed
 *   unknown      unknown (its machine did not answer), or a word this build does not name: never deactivate on it
 */

export type StoreHealthState = 'available' | 'transient' | 'unavailable' | 'removed' | 'unknown'
export interface StoreHealth { readonly state: StoreHealthState, readonly reason?: string }

/** A `store list --detail` row, or a `store get` answer (with `--with live`, its state is the live read's). */
export function classifyStore(row: any | undefined, live?: any): StoreHealth {
  if (!row) return { state: 'removed', reason: 'The project Store is no longer listed in this LayerFS home. Conversation history is retained.' }
  const name = row.store ? `Store ${row.store}` : 'the project Store'
  const x = live ?? row
  const state = typeof x.state === 'string' ? x.state : 'ready'
  const op = x.op
  const fix = typeof x.fix === 'string' && x.fix ? ` Fix: ${x.fix}` : ''
  if (state === 'blocked') return { state: 'unavailable', reason: `The machine of ${name}${x.blocked_by?.machine ? ` (${x.blocked_by.machine})` : ''} is ${x.blocked_by?.reason ?? 'not ready'}.` }
  if (state === 'broken') {
    if (x.reason === 'unresolved') return { state: 'unavailable', reason: `An earlier operation on ${name} left an uncertain outcome; resolve it on the Storage page.${fix}` }
    if (x.reason === 'unreachable') return { state: 'unavailable', reason: `The PostgreSQL server of ${name} cannot be reached from this computer.${fix}` }
    if (x.reason === 'missing') return { state: 'unavailable', reason: `The file of ${name} is missing.${fix}` }
    return { state: 'unavailable', reason: `${name} needs repair (${String(x.reason ?? 'broken')}).${fix}` }
  }
  if (state === 'busy' || op) return { state: 'transient', reason: `The project Store is busy${op?.name ? ` (${op.name})` : ''}.` }
  if (state === 'ready') return { state: 'available' }
  return { state: 'unknown', reason: `The project Store reads ${String(state)}.` }
}

/** The Store name a project key (`<store>/<project>`) lives in. */
export const storeOf = (project: string | undefined): string | undefined => project?.split('/')[0] || undefined
