/** The Logs page's filters and the `logs.list` arguments they become. */
import type { CallClient, LogsListArgs } from '../../shared/logs.ts'

export type ClientChoice = 'all' | CallClient
export type OutcomeChoice = 'all' | 'ok' | 'refused'

export interface Filters {
  project: string
  op: string
  client: ClientChoice
  outcome: OutcomeChoice
  writes: boolean
  tag?: string | undefined
}

/**
 * The page opens on every call. The native log has no read/write bit (#659
 * Q1), so "Only writes" is a client-side filter over a native scan: useful,
 * but an explicit choice, never the default (it would make one page read scan
 * the whole log).
 */
export const DEFAULT_FILTERS: Filters = { project: '', op: 'all', client: 'all', outcome: 'all', writes: false }

/** Lines one page asks for; also the page's "More" step. */
export const PAGE = 100

/**
 * Whether these filters make the host scan the native log page by page (a
 * local filter: Only writes, or the project search, which LayerFS matches
 * exactly): up to `FILTER_BUDGET` CLI pages per read, so a refresh is heavy.
 */
export function scansLog(f: Filters): boolean {
  return f.writes || f.project.trim() !== ''
}

/** How long `logs` events (about one a second in a run) are coalesced into one refresh. */
export const REFRESH_COALESCE_MS = 500
/** The same for a filtered scan: a heavy read (AGENTS.md data loading rules). */
export const SCAN_REFRESH_MS = 3_000

/** The coalescing window for a refresh of this view. */
export function refreshDelay(f: Filters): number {
  return scansLog(f) ? SCAN_REFRESH_MS : REFRESH_COALESCE_MS
}

/**
 * A scan refresh reads only lines at or after the newest line seen before the
 * last scan, less this margin: lines from several writers can land a moment
 * out of time order.
 */
export const SINCE_SKEW_MS = 5_000

/** The `logs.list` arguments for these filters. */
export function argsOf(f: Filters): LogsListArgs {
  return {
    limit: PAGE,
    ...(f.project.trim() ? { project: f.project.trim() } : {}),
    ...(f.op !== 'all' ? { op: f.op } : {}),
    ...(f.client !== 'all' ? { client: f.client } : {}),
    // `refused` is every outcome but `ok`; the contract filters one code, so it is narrowed here.
    ...(f.outcome === 'ok' ? { outcome: 'ok' } : {}),
    ...(f.tag ? { tag: f.tag } : {}),
    ...(f.writes ? { writes: true } : {}),
  }
}

/**
 * What an empty page does about "is the whole log empty?" (which decides the
 * Reset button and the writes-only empty state):
 *
 * - `nonempty`: a line was shown, so the log is not empty;
 * - `empty`: an unfiltered read showed nothing, so the whole log is empty;
 * - `skip`: no answer is needed (a tag has its own empty state; more pages
 *   exist; or the answer is already known for the log as it is now) — asking
 *   would be a second read per event for an empty filtered view;
 * - `probe`: ask once with a one-line read. A known answer that predates the
 *   last change to the log (new lines, a reset) is asked again: the log may
 *   have filled or emptied since.
 */
export type EmptyAction = 'nonempty' | 'empty' | 'skip' | 'probe'

export function emptyAction(input: {
  lines: number
  hasMore: boolean
  /** The read carried no filter but the page limit. */
  unfiltered: boolean
  /** A tag filter is set (its empty state is `emptyTag`, not "the log is empty"). */
  tag: boolean
  /** The whole-log answer already known, if any. */
  known: boolean | undefined
  /** The known answer was learned before the log last changed. */
  stale?: boolean
}): EmptyAction {
  if (input.lines > 0) return 'nonempty'
  if (input.hasMore) return 'skip'
  if (input.unfiltered) return 'empty'
  if (input.tag) return 'skip'
  if (input.known !== undefined && !input.stale) return 'skip'
  return 'probe'
}
