/**
 * Where call log lines come from (docs/specs/layerfs-logs.md §3): the pinned
 * CLI's own call log through `home log` / `home clear-log` (LayerFS 2.0; every
 * client of the LayerFS home) when it has them, else this plugin's stand-in
 * file. LayerFS's file is only read through the CLI.
 */
import { isWrite, parseTag, type CallClient, type CallLine, type LogsListArgs, type LogsListAnswer, type LogsResetAnswer } from '../../shared/logs.ts'
import { listCalls, matches, projectOf, resetCalls as resetStandIn } from '../layerfs/call-log.ts'
import { clearOutputs, outputsDir } from '../layerfs/call-output.ts'
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

/** One page of lines, newest first, from whichever source is active. */
export async function readCalls(layerfs: LayerfsService, args: LogsListArgs): Promise<CallPage> {
  if (!(await layerfs.nativeLogs())) return { ...listCalls(layerfs.callLog, args), source: 'plugin' }
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
  const filtered = Object.keys(local).length > 0
  const lines: CallLine[] = []
  let cursor = args.cursor, has_more = false, skipped = 0
  for (let round = 0; round < 50; round++) {
    let page: any
    try {
      page = await layerfs.lfs.home.log({ ...native, ...(cursor ? { cursor } : {}), limit: limit - lines.length, detail: true })
    } catch (error: any) {
      // A home that was never initialized (or is not set up yet) has no log yet.
      if ((error?.code === 'Unavailable' || error?.code === 'Uninitialized' || error?.code === 'NotFound') && !cursor) return { lines: [], has_more: false, skipped: 0, source: 'layerfs' }
      throw error
    }
    skipped += Number(page?.skipped ?? 0)
    for (const item of page?.items ?? []) {
      const line = lineOfItem(item)
      if (!line) { skipped++; continue }
      if (!filtered || matches(line, local)) lines.push(line)
    }
    has_more = typeof page?.next_cursor === 'string' && !!page.next_cursor
    cursor = has_more ? page.next_cursor : undefined
    if (!has_more || lines.length >= limit) break
  }
  return { lines, ...(has_more && cursor ? { next: cursor } : {}), has_more, skipped, source: 'layerfs' }
}

/** Clears the active source (`home clear-log`, else the stand-in); the stored outputs (`trace/outputs/`) go too, in both modes. */
export async function resetCalls(layerfs: LayerfsService): Promise<LogsResetAnswer> {
  if (!(await layerfs.nativeLogs())) {
    const answer = resetStandIn(layerfs.callLog)
    clearOutputs(outputsDir(layerfs.callLog))
    return answer
  }
  const answer = await layerfs.lfs.home.clear_log({ detail: true })
  clearOutputs(outputsDir(layerfs.callLog))
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
 * session (pages, presets' polling) are left out; a session's reads are kept.
 * @param limit - lines returned at most (the newest).
 * @param scan - lines read at most.
 */
export async function projectCalls(layerfs: LayerfsService, project: string, known: readonly string[], limit = 500, scan = PROJECT_SCAN): Promise<{ lines: CallLine[], source: 'layerfs' | 'plugin', scanned: number, has_more: boolean }> {
  const sandboxes = new Set(known)
  const lines: CallLine[] = []
  let cursor: string | undefined, scanned = 0, has_more = false, source: 'layerfs' | 'plugin' = 'plugin'
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
    source = page.source
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
  return { lines, source, scanned, has_more }
}
