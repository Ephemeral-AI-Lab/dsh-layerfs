import { classifyPgFailure, missingPrivilege, type SessionFailure } from '../../shared/pg-failure.ts'

export type StoreHealthState = 'available' | 'transient' | 'unavailable' | 'removed' | 'unknown'
export interface StoreHealth {
  readonly state: StoreHealthState
  readonly reason?: string
  readonly failure?: SessionFailure
}

/** The host's last failed check, else the first attached machine's (`store get` `reach`, `machines[].reach`). */
function firstFailedReachError(row: any): string | undefined {
  if (row?.reach?.ok === false && typeof row.reach.error === 'string' && row.reach.error) return row.reach.error
  const conns = Array.isArray(row?.machines) ? row.machines : []
  for (const c of conns) {
    if (c?.reached === 'failed' && typeof c?.reach?.error === 'string' && c.reach.error) return c.reach.error
  }
  return undefined
}

export function classifyStore(row: any | undefined, live?: any): StoreHealth {
  if (!row) {
    return {
      state: 'removed',
      reason: 'The project Store is no longer listed in this LayerFS home. Conversation history is retained.',
      failure: { code: 'store_removed' },
    }
  }
  const storeName = typeof row.store === 'string' ? row.store : undefined
  const name = storeName ? `Store ${storeName}` : 'the project Store'
  const recordBroken = row.state === 'broken' && row.reason !== 'unreachable'
  const x = live && !(recordBroken && (live.state ?? 'ready') === 'ready') ? live : row
  const state = typeof x.state === 'string' ? x.state : 'ready'
  const op = x.op
  const fixLine = typeof x.fix === 'string' && x.fix ? x.fix : undefined
  const fix = fixLine ? ` Fix: ${fixLine}` : ''
  const isPg = row.engine === 'postgresql' || x.engine === 'postgresql'

  if (state === 'blocked') {
    const why = x.blocked_by?.reason
    const machine = typeof x.blocked_by?.machine === 'string' ? x.blocked_by.machine : undefined
    const words = !why ? 'not ready' : why === 'failed' ? 'unreadable: LayerFS cannot read its record' : String(why).replace(/_/g, ' ')
    return {
      state: 'unavailable',
      reason: `The machine of ${name}${machine ? ` (${machine})` : ''} is ${words}.`,
      failure: { code: 'machine_blocked', ...(storeName ? { store: storeName } : {}), ...(machine ? { machine } : {}), ...(why ? { reason: String(why) } : {}) },
    }
  }

  if (state === 'broken') {
    if (x.reason === 'unresolved') {
      return {
        state: 'unavailable',
        reason: `An earlier operation on ${name} left an uncertain outcome; resolve it on its Store page.${fix}`,
        failure: { code: 'store_unresolved', ...(storeName ? { store: storeName } : {}), ...(fixLine ? { fix: fixLine } : {}) },
      }
    }
    if (isPg) {
      if (row.password_saved === false) {
        return {
          state: 'unavailable',
          reason: `PostgreSQL ${name} has no saved password; give one with Edit connection… on its Store page.${fix}`,
          failure: { code: 'pg_no_login', ...(storeName ? { store: storeName } : {}), ...(fixLine ? { fix: fixLine } : {}) },
        }
      }
      if (x.reason === 'outdated') {
        return {
          state: 'unavailable',
          reason: `PostgreSQL ${name}’s record is out of date; update it on its Store page.${fix}`,
          failure: { code: 'pg_outdated', ...(storeName ? { store: storeName } : {}), ...(fixLine ? { fix: fixLine } : {}) },
        }
      }
      const rawDetail = (typeof x.message === 'string' && x.message) || firstFailedReachError(x) || firstFailedReachError(row)
      const kind = classifyPgFailure(undefined, rawDetail)
      if (kind === 'login') {
        return {
          state: 'unavailable',
          reason: `PostgreSQL ${name} failed to sign in (wrong user or password); fix them with Edit connection… on its Store page.${fix}`,
          failure: { code: 'pg_wrong_login', ...(storeName ? { store: storeName } : {}), ...(rawDetail ? { detail: rawDetail } : {}), ...(fixLine ? { fix: fixLine } : {}) },
        }
      }
      if (kind === 'privilege') {
        const priv = missingPrivilege(rawDetail)
        const detail = priv ? `${priv.role} lacks ${priv.privilege}` : rawDetail
        return {
          state: 'unavailable',
          reason: `PostgreSQL ${name} is missing a required database privilege${detail ? ` (${detail})` : ''}; grant it, or change the user with Edit connection… on its Store page.${fix}`,
          failure: { code: 'pg_privilege', ...(storeName ? { store: storeName } : {}), ...(detail ? { detail } : {}), ...(fixLine ? { fix: fixLine } : {}) },
        }
      }
      if (kind === 'store') {
        return {
          state: 'unavailable',
          reason: `PostgreSQL ${name}’s database does not match this Store; edit its connection on its Store page.${fix}`,
          failure: { code: 'pg_store_mismatch', ...(storeName ? { store: storeName } : {}), ...(rawDetail ? { detail: rawDetail } : {}), ...(fixLine ? { fix: fixLine } : {}) },
        }
      }
      if (kind === 'daemon_dns') {
        return {
          state: 'unavailable',
          reason: `Sessions cannot resolve the database hostname of PostgreSQL ${name}; switch localhost to 127.0.0.1 on its Store page.${fix}`,
          failure: { code: 'pg_daemon_dns', ...(storeName ? { store: storeName } : {}), ...(rawDetail ? { detail: rawDetail } : {}), ...(fixLine ? { fix: fixLine } : {}) },
        }
      }
      if (x.reason === 'unreachable' || kind === 'server') {
        return {
          state: 'unavailable',
          reason: `PostgreSQL ${name} could not reach its server; check its connection on its Store page.${fix}`,
          failure: { code: 'pg_unreachable', ...(storeName ? { store: storeName } : {}), ...(rawDetail ? { detail: rawDetail } : {}), ...(fixLine ? { fix: fixLine } : {}) },
        }
      }
    }
    if (x.reason === 'missing') {
      return {
        state: 'unavailable',
        reason: `The file of ${name} is missing.${fix}`,
        failure: { code: 'store_missing_file', ...(storeName ? { store: storeName } : {}), ...(fixLine ? { fix: fixLine } : {}) },
      }
    }
    return {
      state: 'unavailable',
      reason: `${name} needs repair (${String(x.reason ?? 'broken')}). Check its Store page.${fix}`,
      failure: { code: 'store_broken', ...(storeName ? { store: storeName } : {}), reason: String(x.reason ?? 'broken'), ...(fixLine ? { fix: fixLine } : {}) },
    }
  }

  if (state === 'busy' || op) {
    return {
      state: 'transient',
      reason: `The project Store is busy${op?.name ? ` (${op.name})` : ''}.`,
      failure: { code: 'store_busy', ...(storeName ? { store: storeName } : {}), ...(op?.name ? { detail: String(op.name) } : {}) },
    }
  }
  if (state === 'ready') return { state: 'available' }
  return {
    state: 'unknown',
    reason: `The project Store reads ${String(state)}.`,
    failure: { code: 'store_unknown', ...(storeName ? { store: storeName } : {}), reason: String(state) },
  }
}

export const storeOf = (project: string | undefined): string | undefined => project?.split('/')[0] || undefined
