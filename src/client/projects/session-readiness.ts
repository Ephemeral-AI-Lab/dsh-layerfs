/**
 * A project session's readiness in the sidebar: one word beside its title and
 * at most one reason under the row, in words only (`sessions.list` plus the
 * project's availability, docs/specs/layerfs-workspaces.md §5; no action
 * button: the row itself opens, and the project row carries Start and the
 * Store link, docs/guide/entry-points.md). Pure: nothing here calls LayerFS.
 */
import type { SessionFailure } from '../../shared/pg-failure.ts'
import type { StoreRow } from '../storage/types.ts'
import type { ProjectAvailability } from './availability.ts'
import type { ListT } from './list-locale.ts'
import { formatSessionFailure, pgStoreFailure } from './session-failure.ts'

/** The `sessions.list` facts this rule reads. */
export interface ReadinessSession {
  state?: string | undefined
  local?: boolean | undefined
  executionState?: 'inactive' | 'activating' | 'active' | 'interrupted' | undefined
  error?: string | null | undefined
  failure?: SessionFailure | null | undefined
}

export type SessionReadinessKey = 'unavailable' | 'stored' | 'interrupted' | 'starting' | 'active' | 'notStarted' | 'unknown'

export interface SessionReadiness {
  key: SessionReadinessKey
  word?: string
  reason?: string
}

type StatusWordKey = 'machineStopped' | 'storeUnavailable' | 'machineUnavailable' | 'starting' | 'busy'

/** The project row's existing word for a project that cannot run (`sidebarStatus`, without catalog facts). */
function statusWordKey(a: ProjectAvailability): StatusWordKey {
  if (a.state === 'stopped') return 'machineStopped'
  if (a.state === 'starting') return 'starting'
  if (a.state === 'busy') return 'busy'
  if (a.state === 'available') return 'storeUnavailable'
  return 'machineUnavailable'
}

/**
 * Read one session's readiness, first match wins:
 * the project cannot run; it is only in LayerFS; execution was interrupted;
 * it is starting, active or not started. An execution state with no word stays
 * hidden (`unknown`), as the host gave it.
 */
export function sessionReadiness(
  session: ReadinessSession,
  availability: ProjectAvailability,
  storeName: string,
  t: ListT,
  store?: StoreRow,
): SessionReadiness {
  // 1. The project cannot run (checking is not an answer yet): nothing opens.
  if (!availability.canRun && availability.state !== 'checking') {
    const failure = formatSessionFailure(pgStoreFailure(store), availability.reason, t, storeName, store)
    const reason = failure?.message ?? availability.reason ?? t('unavailableWhy', { reason: t(statusWordKey(availability)) })
    return { key: 'unavailable', word: t('unavailable'), reason }
  }
  // 2. Only in LayerFS: opening the row imports it.
  if (session.state === 'stored' && !session.local) {
    return { key: 'stored', word: t('storedElsewhere'), reason: t('storedWhy') }
  }
  // 3. Its execution stopped: the failure, in words.
  if (session.executionState === 'interrupted') {
    const failure = formatSessionFailure(session.failure, session.error, t, storeName, store)
    return { key: 'interrupted', word: t('interrupted'), reason: failure?.message ?? t('interruptedHint') }
  }
  // 4-6. The host's own state, in a word.
  if (session.executionState === 'activating') return { key: 'starting', word: t('sessionStarting') }
  if (session.executionState === 'active') return { key: 'active', word: t('active') }
  if (session.state === 'pending' || session.executionState === 'inactive' || !session.executionState) return { key: 'notStarted', word: t('notStarted') }
  // 7. No word for it: the host's own state stays hidden.
  return { key: 'unknown' }
}
