/**
 * Where call log lines come from (docs/specs/layerfs-logs.md §3): the pinned
 * CLI's own call log through `home log` / `home clear-log` (LayerFS 2.0; every
 * client of the LayerFS home; discovery refuses a CLI without them). LayerFS's
 * file is only read through the CLI.
 */
import { isWrite, operationOf, parseTag, type CallClient, type CallLine, type LogsListArgs, type LogsListAnswer, type LogsResetAnswer } from '../../shared/logs.ts'
import { clearOutputs } from '../layerfs/call-output.ts'
import type { LayerfsService } from '../service.ts'

export type CallPage = Omit<LogsListAnswer, 'lines'> & { lines: CallLine[] }

/** Only the fields the page may set, with sane types. */
export function listArgs(raw: any): LogsListArgs {
  const text = (v: unknown) => typeof v === 'string' && v ? v : undefined
  const args: LogsListArgs = {}
  for (const key of ['cursor', 'op', 'project', 'tag', 'outcome'] as const) { const v = text(raw?.[key]); if (v) args[key] = v }
  if (['cli', 'node', 'python', 'rust'].includes(raw?.client)) args.client = raw.client
  if (Number.isFinite(raw?.limit)) args.limit = Math.max(1, Math.min(1000, Math.floor(raw.limit)))
  if (Number.isFinite(raw?.since)) args.since = Math.floor(raw.since)
  if (raw?.writes === true) args.writes = true
  return args
}

/** The project a line names: the first `<store>/<name>` word after family and call. */
export function projectOf(argv: readonly string[]): string | undefined {
  return argv.slice(2).find((word) => /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(word))
}

/** Whether a line passes the `LogsListArgs` filters (`project`: case-insensitive substring). */
export function matches(line: CallLine, args: LogsListArgs): boolean {
  if (args.op) {
    const op = args.op.replaceAll('-', '_')
    if (op.includes('.') ? operationOf(line.argv) !== op : line.argv[0] !== op) return false
  }
  if (args.project) {
    const project = projectOf(line.argv)
    if (!project || !project.toLowerCase().includes(args.project.toLowerCase())) return false
  }
  if (args.client && line.client !== args.client) return false
  if (args.tag && !(args.tag.endsWith(':') ? line.tag?.startsWith(args.tag) : line.tag === args.tag)) return false
  if (args.outcome && line.outcome !== args.outcome) return false
  if (typeof args.since === 'number' && line.at < args.since) return false
  if (args.writes && !isWrite(line.argv)) return false
  return true
}

/**
 * One `home log --detail` item as a call log line: `logged_at` (ISO) is `at`,
 * `duration_ms` is `ms`, and the outcome is `ok`, or the refusal code
 * (`error`) of a refused call; a result's own word (`committed`, …) is `kind`.
 */
export function lineOfItem(item: any): CallLine | null {
  const at = typeof item?.logged_at === 'string' ? Date.parse(item.logged_at) : NaN
  if (!Number.isFinite(at) || !Array.isArray(item?.argv)) return null
  const word = typeof item.outcome === 'string' ? item.outcome : 'ok'
  const refused = word === 'refused' || (typeof item.error === 'string' && item.error)
  return {
    v: 1, at, ms: Number.isFinite(item.duration_ms) ? Number(item.duration_ms) : 0,
    client: (['cli', 'node', 'python', 'rust'].includes(item.client) ? item.client : 'cli') as CallClient,
    argv: item.argv.map(String),
    outcome: refused ? String(item.error ?? 'Failed') : 'ok',
    ...(!refused && word !== 'ok' ? { kind: word } : {}),
    ...(typeof item.commit === 'string' && item.commit ? { commit: item.commit } : {}),
    ...(typeof item.tag === 'string' && item.tag ? { tag: item.tag } : {}),
  }
}

/** Native lines one filtered read scans (the CLI's largest page). */
const FILTER_SCAN = 1000

/**
 * Native pages one filtered request scans at most. A match can be anywhere in
 * the log, so a filtered request cannot stop at a line count (B1: a rare write
 * had to be walked to). It stops at this page budget instead: the matches so
 * far, `has_more: true` and a cursor after the last scanned page carry on, with
 * `partial: true` saying the scan did not reach the end. An empty filtered
 * answer is therefore only returned once the log itself ended, and one request
 * stays bounded (8 × 1000 lines) however large the log is.
 */
export const FILTER_BUDGET = 8

/**
 * A filtered page's own cursor: the native cursor its scan started at, and how
 * many matching lines of that scan were already returned. A filtered page hands
 * over at most `limit` matching lines; the rest of the scan (when a page holds
 * more than that) follows from this cursor instead of being skipped.
 */
function filteredCursor(native: string | undefined, skip: number): string {
  return Buffer.from(JSON.stringify({ w: 1, ...(native ? { c: native } : {}), s: skip })).toString('base64url')
}

/** `{ native, skip }` of a filtered cursor; a bare native cursor (or none) starts a scan. */
function readFilteredCursor(cursor: string | undefined): { native?: string, skip: number } {
  if (!cursor) return { skip: 0 }
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (value?.w === 1 && Number.isInteger(value.s) && value.s >= 0 && (value.c === undefined || typeof value.c === 'string')) {
      return { native: value.c || undefined, skip: value.s }
    }
  } catch { /* not ours: a native cursor */ }
  return { native: cursor, skip: 0 }
}

/**
 * One page of lines, newest first, from LayerFS's own call log.
 *
 * A local filter (`writes`, or a filter the pinned CLI's `home log` has no
 * option for) cannot be pushed into the CLI. It is applied to native pages of
 * `FILTER_SCAN` lines, scanned until the page holds one more matching line than
 * asked for (so `has_more` is a fact), the log ends (so an empty filtered view
 * really has no such lines), or `FILTER_BUDGET` pages were read (so one request
 * stays bounded: then `partial` is set and `next` carries on). `next` continues
 * over the filtered set: a native cursor after the scanned pages, or a cursor
 * into the page that held the next matching line, so "More" has no gap and no
 * repeat.
 */
export async function readCalls(layerfs: LayerfsService, args: LogsListArgs): Promise<CallPage> {
  const entry = (await layerfs.discovery()).calls.find((c) => c.family === 'home' && c.call === 'log')
  const accepted = new Set(entry?.options.map((o) => o.name) ?? [])
  const limit = args.limit ?? 100
  // LayerFS matches `project` exactly; the page searches by substring, and `writes` is ours (#659 Q1).
  const local: LogsListArgs = { ...(args.project ? { project: args.project } : {}), ...(args.writes ? { writes: true } : {}) }
  const native: Record<string, unknown> = {}
  // the page's `op` filter is `home log --call` (a family, or family.call)
  for (const [key, option] of [['op', 'call'], ['client', 'client'], ['tag', 'tag'], ['outcome', 'outcome'], ['since', 'since']] as const) {
    if (args[key] === undefined) continue
    if (accepted.has(option)) native[option] = args[key]
    else (local as any)[key] = args[key]
  }
  const read = async (cursor: string | undefined, pageLimit: number): Promise<any> => {
    try {
      return await layerfs.lfs.home.log({ ...native, ...(cursor ? { cursor } : {}), limit: pageLimit, detail: true })
    } catch (error: any) {
      // A home that was never initialized (or is not set up yet) has no log yet.
      if ((error?.code === 'Unavailable' || error?.code === 'Uninitialized' || error?.code === 'NotFound') && !args.cursor) return null
      throw error
    }
  }
  const parse = (page: any): { lines: CallLine[], skipped: number, next?: string } => {
    let skipped = Number(page?.skipped ?? 0)
    const lines: CallLine[] = []
    for (const item of page?.items ?? []) {
      const line = lineOfItem(item)
      if (!line) { skipped++; continue }
      lines.push(line)
    }
    const next = typeof page?.next_cursor === 'string' && page.next_cursor ? String(page.next_cursor) : undefined
    return { lines, skipped, ...(next ? { next } : {}) }
  }
  if (Object.keys(local).length === 0) {
    const page = await read(args.cursor, limit)
    if (!page) return { lines: [], has_more: false, skipped: 0, source: 'layerfs' }
    const { lines, skipped, next } = parse(page)
    return { lines, ...(next ? { next } : {}), has_more: !!next, skipped, source: 'layerfs' }
  }
  // Filtered: scan native pages until one line more than `limit` matches, the
  // log ends, or FILTER_BUDGET pages are read. A resumed cursor re-reads the page
  // it names and drops the matches this page already handed out.
  const from = readFilteredCursor(args.cursor)
  const pages: { start?: string, skippedMatches: number, lines: CallLine[] }[] = []
  let cursor = from.native, drop = from.skip, skipped = 0, total = 0, more = false, scan = 0
  while (total <= limit) {
    // The budget bounds one request, not the search: a resumed cursor keeps scanning.
    if (scan >= FILTER_BUDGET) break
    const page = await read(cursor, FILTER_SCAN)
    scan++
    if (!page) break
    const parsed = parse(page)
    skipped += parsed.skipped
    const matching = parsed.lines.filter((line) => matches(line, local))
    // The cursor's skip names lines of the page it resumes; a shorter re-read
    // (a changed log) must not drop matches from the pages after it.
    const skippedMatches = pages.length === 0 ? Math.min(drop, matching.length) : 0
    drop -= skippedMatches
    pages.push({ start: cursor, skippedMatches, lines: matching.slice(skippedMatches) })
    total += matching.length - skippedMatches
    more = !!parsed.next
    cursor = parsed.next
    // Newest first: a page that reaches a line older than a local `since` ends
    // the search (the Logs page's refresh reads only what was logged since).
    const since = local.since
    if (since !== undefined && parsed.lines.some((line) => line.at < since)) more = false
    if (!more) break
  }
  const flat: { line: CallLine, page: number, index: number }[] = []
  pages.forEach((page, at) => page.lines.forEach((line, index) => flat.push({ line, page: at, index })))
  const lines = flat.slice(0, limit).map((entry) => entry.line)
  const after = flat[limit]
  const next = after
    ? filteredCursor(pages[after.page]!.start, pages[after.page]!.skippedMatches + after.index)
    : more ? filteredCursor(cursor, 0) : undefined
  // The budget stopped the scan before the log ended: older lines are unscanned,
  // so `has_more` is "not proven empty", never "there is another match".
  const partial = !after && more
  return { lines, ...(next ? { next } : {}), has_more: !!next, ...(partial ? { partial: true } : {}), skipped, source: 'layerfs' }
}

/** Clears LayerFS's call log (`home clear-log`); the stored outputs (`trace/outputs/`) go too. */
export async function resetCalls(layerfs: LayerfsService): Promise<LogsResetAnswer> {
  const answer = await layerfs.lfs.home.clear_log({ detail: true })
  clearOutputs(layerfs.outputs)
  return { removed: Number(answer?.line_count ?? 0) }
}

/** Every line with a tag under `prefix` (ending in `:`) and `at >= since`, newest first. */
export async function callsSince(layerfs: LayerfsService, prefix: string, since: number): Promise<CallLine[]> {
  const all: CallLine[] = []
  let cursor: string | undefined
  for (let round = 0; round < 20; round++) {
    const page = await readCalls(layerfs, { tag: prefix, since, limit: 1000, ...(cursor ? { cursor } : {}) })
    all.push(...page.lines)
    if (!page.has_more || !page.next) break
    cursor = page.next
  }
  return all
}

/** Lines a project's calls are read from at most (`logs.project`), newest first. */
export const PROJECT_SCAN = 10_000

/**
 * One project's calls, newest first: the lines that name it (`projectOf`) and
 * the lines on its Sandboxes (`<sandbox>` or `<sandbox>:<ws>` first argument),
 * which do not name it. A Sandbox is the project's when `known` lists it or a
 * scanned `sandbox create <project> <name>` made it. Reads made outside a
 * session (the pages' polling) are left out; a session's reads are kept.
 * @param limit - lines returned at most (the newest).
 * @param scan - lines read at most.
 */
export async function projectCalls(layerfs: LayerfsService, project: string, known: readonly string[], limit = 500, scan = PROJECT_SCAN): Promise<{ lines: CallLine[], source: 'layerfs', scanned: number, has_more: boolean }> {
  const sandboxes = new Set(known)
  const lines: CallLine[] = []
  let cursor: string | undefined, scanned = 0, has_more = false
  const sandboxOf = (argv: readonly string[]) => {
    if (argv[0] !== 'workspace' && argv[0] !== 'sandbox') return undefined
    const first = argv[2]
    if (!first || first.includes('/')) return undefined
    const colon = first.indexOf(':')
    return colon > 0 ? first.slice(0, colon) : first
  }
  const candidates: { line: CallLine, sandbox?: string }[] = []
  while (scanned < scan) {
    const page = await readCalls(layerfs, { limit: Math.min(1000, scan - scanned), ...(cursor ? { cursor } : {}) })
    scanned += page.lines.length
    for (const line of page.lines) {
      const argv = line.argv
      if (!parseTag(line.tag) && !isWrite(argv)) continue
      if (argv[0] === 'sandbox' && argv[1] === 'create' && argv[2] === project && argv[3]) sandboxes.add(argv[3])
      if (projectOf(argv) === project) candidates.push({ line })
      else { const sandbox = sandboxOf(argv); if (sandbox) candidates.push({ line, sandbox }) }
    }
    has_more = page.has_more && !!page.next
    if (!has_more) break
    cursor = page.next
  }
  for (const c of candidates) {
    if (c.sandbox && !sandboxes.has(c.sandbox)) continue
    lines.push(c.line)
    if (lines.length >= limit) break
  }
  return { lines, source: 'layerfs', scanned, has_more }
}
