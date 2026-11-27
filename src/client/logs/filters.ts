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
 *   exist; or the answer is already known) — asking would be a second read per
 *   event for an empty filtered view;
 * - `probe`: ask once with a one-line read.
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
}): EmptyAction {
  if (input.lines > 0) return 'nonempty'
  if (input.hasMore) return 'skip'
  if (input.unfiltered) return 'empty'
  if (input.tag) return 'skip'
  if (input.known !== undefined) return 'skip'
  return 'probe'
}
