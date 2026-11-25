/**
 * The row adapter's non-React half: the mark itself, the one-per-session miss
 * log, and the coalesced probe for a trailing seat that stopped rendering.
 *
 * The adapter is fail-open. A row it cannot identify is left visible and
 * reported once per session (a `console.warn` plus the module-level log a test
 * can read); it never hides a row it did not mark.
 *
 * Search is DSH's own flat result list: those rows have `role="treeitem"` but
 * no `data-row-key` and no trailing seat, and the query and expanded state live
 * in DSH's local WorkspaceBrowser state, not in a public service or event. The
 * adapter therefore cannot see, mark or report a search result; the seam
 * request covers that gap.
 */
import type { OwnershipState } from './ownership.ts'

export const PROJECT_OWNED_ATTR = 'data-layerfs-project-owned'
export const ROW_SELECTOR = '[role="treeitem"][data-row-key]'
/** One probe interval; DSH's list changes on events, so 30 s is enough. */
export const PROBE_INTERVAL_MS = 30_000

/** The small part of an Element the adapter needs (a test supplies a fake). */
export interface RowLike {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

export type MissReason = 'row-key' | 'no-row' | 'seat-gone'

export interface AdapterMiss {
  readonly sessionId: string
  readonly reason: MissReason
  readonly detail: string
  readonly at: number
}

export type MissWarn = (message: string) => void

/** DSH's public row identity for one session. */
export function sessionRowKey(sessionId: string): string {
  return `session:${sessionId}`
}

/** The selector the probe uses; it names the row by DSH's public identity only. */
export function sessionRowSelector(sessionId: string): string {
  const key = sessionRowKey(sessionId).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `[role="treeitem"][data-row-key="${key}"]`
}

/** Mark the row only when DSH's identity says it is this session's row. */
export function markRow(row: RowLike | null, sessionId: string): boolean {
  if (!row || row.getAttribute('data-row-key') !== sessionRowKey(sessionId)) return false
  row.setAttribute(PROJECT_OWNED_ATTR, sessionId)
  return true
}

/** Remove only our own mark, never another session's (row nodes are reused). */
export function unmarkRow(row: RowLike | null, sessionId: string): void {
  if (row && row.getAttribute(PROJECT_OWNED_ATTR) === sessionId) row.removeAttribute(PROJECT_OWNED_ATTR)
}

/**
 * The misses the adapter could not fix, keyed by session: the first one is
 * warned and kept, later ones are dropped so a render or a probe every 30 s
 * never spams. A test reads `misses`; the client only warns.
 */
export class AdapterMissLog {
  private readonly seen = new Set<string>()
  private readonly all: AdapterMiss[] = []

  constructor(
    private readonly warn: MissWarn = (message) => console.warn(message),
    private readonly now: () => number = Date.now,
  ) {}

  /** Report a miss once for this session id; `false` when it was already known. */
  report(sessionId: string, reason: MissReason, detail: string): boolean {
    if (this.seen.has(sessionId)) return false
    this.seen.add(sessionId)
    const miss: AdapterMiss = { sessionId, reason, detail, at: this.now() }
    this.all.push(miss)
    this.warn(`[dsh-layerfs] row mark: ${detail}; ${sessionRowKey(sessionId)} stays visible in DSH's Workspaces list`)
    return true
  }

  /** The reported misses, oldest first. */
  get misses(): readonly AdapterMiss[] {
    return this.all
  }

  has(sessionId: string): boolean {
    return this.seen.has(sessionId)
  }

  /** Forget every report (a test; the client keeps them for its lifetime). */
  clear(): void {
    this.seen.clear()
    this.all.length = 0
  }
}

/** The one collector every row and the probe report through. */
export const adapterMisses = new AdapterMissLog()

export type RowOutcome = 'ignored' | 'cleared' | 'marked' | 'miss'

/**
 * What one ownership answer does to one row: `project` marks a matched row or
 * reports the miss, `notProject` erases our mark, `unknown` changes nothing (a
 * host blip must not re-show or un-hide a row).
 */
export function applyRowOwnership(
  state: OwnershipState,
  sessionId: string,
  row: RowLike | null,
  log: AdapterMissLog = adapterMisses,
): RowOutcome {
  if (state === 'unknown') return 'ignored'
  if (state === 'notProject') {
    unmarkRow(row, sessionId)
    return 'cleared'
  }
  if (markRow(row, sessionId)) return 'marked'
  const found = row ? JSON.stringify(row.getAttribute('data-row-key')) : 'no row'
  log.report(sessionId, row ? 'row-key' : 'no-row', `expected ${sessionRowKey(sessionId)}, found ${found}`)
  return 'miss'
}

/** What the probe needs from the document; no layout reads, only queries. */
export interface ProbeDocument {
  readonly hidden?: boolean
  querySelector(selector: string): RowLike | null
}

/** What the probe needs from the ownership store. */
export interface ProjectSource {
  projectIds(): readonly string[]
}

/**
 * One interval's DOM check. A present row that is not marked is a miss (the
 * seat stopped rendering, or never did); an absent row is not a miss, because
 * a collapsed group renders none either. Returns the number of sessions asked
 * about, so a test can see that a hidden document asks nothing.
 */
export function probeProjectRows(
  doc: ProbeDocument,
  projectIds: Iterable<string>,
  log: AdapterMissLog = adapterMisses,
): number {
  if (doc.hidden) return 0
  let asked = 0
  for (const sessionId of projectIds) {
    asked += 1
    const row = doc.querySelector(sessionRowSelector(sessionId))
    if (row && row.getAttribute(PROJECT_OWNED_ATTR) !== sessionId) {
      log.report(sessionId, 'seat-gone', `row ${sessionRowKey(sessionId)} is present but not marked`)
    }
  }
  return asked
}

/**
 * The coalesced probe: every 30 s, while the ownership store knows at least one
 * project, ask for each known project session's row. It never queries while the
 * document is hidden, and it is one `querySelector` per id per interval.
 */
export class RowProbe {
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly source: ProjectSource,
    private readonly log: AdapterMissLog,
    private readonly doc: ProbeDocument,
    private readonly intervalMs = PROBE_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => { this.check() }, this.intervalMs)
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One interval's work; public so a test can drive it without waiting 30 s. */
  check(): number {
    if (this.doc.hidden) return 0
    return probeProjectRows(this.doc, this.source.projectIds(), this.log)
  }
}
