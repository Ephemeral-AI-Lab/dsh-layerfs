/**
 * Logs area, host half (docs/specs/layerfs-logs.md §5–§6).
 *
 * Operations (the `layerfs` Remote):
 *   logs.list LogsListArgs   one page of call log lines, newest first, each
 *                            labelled with the project session, turn and
 *                            checkpoint it belongs to (`dsh`, see CallLabel),
 *                            or with its simulation run (`sim`); for a session
 *                            tag, imported receipts follow this machine's lines
 *                            (`source: 'receipt'`)
 *   logs.project {project, sandboxes?, limit?}
 *                            one project's calls, newest first and labelled: the
 *                            lines naming it and those on its Sandboxes (`projectCalls`)
 *   logs.reset {}            clear the history (the active source's) and the stored outputs
 *   logs.output {tag}        what one call made through DSH printed (`CallOutput`),
 *                            or `{missing: true}` when none is kept
 *
 * Event: `logs` after stand-in appends (at most once a second).
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, watch } from 'node:fs'
import { dirname } from 'node:path'
import { HOST_SESSION, isDshTag, LOGS_EVENT, parseSimTag, parseTag, sessionTag, TAG_PREFIX, type CallLabel, type CallLine, type LabeledLine, type LogsListArgs, type LogsListAnswer, type LogsOutputAnswer, type LogsProjectAnswer } from '../../shared/logs.ts'
import { matches, onCallLogAppend } from '../layerfs/call-log.ts'
import { hasOutput, outputsDir, readOutput, validOutputTag } from '../layerfs/call-output.ts'
import type { Checkpoint } from '../sessions/state.ts'
import { callsSince, listArgs, projectCalls, readCalls, resetCalls, type CallPage } from './source.ts'

export const name = 'dsh-layerfs-logs'
export const inject = ['layerfs', 'layerfsRemote']

interface SessionFacts { title?: string, invocations: any[], checkpoints: Checkpoint[] }

/** What one page's labels need from a session: read once per session per page. */
async function facts(ctx: Context, sessionId: string): Promise<SessionFacts> {
  const persistence = ctx.get('sessionPersistence' as never) as any
  const sessions = ctx.get('layerfsSessions' as never) as any
  const sidecar = await Promise.resolve(persistence?.readSidecar?.(sessionId)).catch(() => undefined)
  const local: Checkpoint[] | undefined = sessions?.checkpoints?.(sessionId)
  const live = (ctx.get('sessions' as never) as any)?.get?.(sessionId)
  let title: string | undefined
  try {
    const titles = live?.snapshotEvents?.(0)?.filter((e: any) => e.type === 'session/title' && typeof e.data?.title === 'string') ?? []
    title = titles.at(-1)?.data.title
  } catch { /* title is optional */ }
  title ??= typeof sidecar?.title === 'string' ? sidecar.title : undefined
  return {
    ...(title ? { title } : {}),
    invocations: Array.isArray(sidecar?.invocations) ? sidecar.invocations : [],
    checkpoints: local?.length ? local : Array.isArray(sidecar?.checkpoints) ? sidecar.checkpoints : [],
  }
}

const checkpointLabel = (c: Checkpoint, saved: boolean): NonNullable<CallLabel['checkpoint']> =>
  ({ kind: c.kind, turn: c.turn, changed: c.changed, saved })

/**
 * The §5 join. A `dsh:` tag names the session and receipt: the sidecar receipt
 * gives origin, turn and tool call; the checkpoint whose `receipt` matches is
 * this call's (`saved` only when its save created a version). A line without a
 * `dsh:` tag but naming a version is matched against local checkpoints by that
 * version and never shown as having saved it.
 */
export async function label(ctx: Context, lines: readonly CallLine[], outputs?: string): Promise<LabeledLine[]> {
  const cache = new Map<string, Promise<SessionFacts>>()
  const of = (id: string) => { let f = cache.get(id); if (!f) cache.set(id, f = facts(ctx, id)); return f }
  let byVersion: Map<string, { sessionId: string, checkpoint: Checkpoint }> | undefined
  const versions = () => {
    if (byVersion) return byVersion
    byVersion = new Map()
    const all = (ctx.get('layerfsSessions' as never) as any)?.state?.read?.().checkpoints ?? {}
    for (const [sessionId, list] of Object.entries(all as Record<string, Checkpoint[]>)) {
      for (const checkpoint of list ?? []) {
        if (!checkpoint?.commit) continue
        const known = byVersion.get(checkpoint.commit)
        // Prefer the checkpoint that created the version over later references to it.
        if (!known || (known.checkpoint.changed <= 0 && checkpoint.changed > 0)) byVersion.set(checkpoint.commit, { sessionId, checkpoint })
      }
    }
    return byVersion
  }
  const out: LabeledLine[] = []
  const stored = (line: CallLine): { output?: true } => outputs && isDshTag(line.tag) && hasOutput(outputs, line.tag) ? { output: true } : {}
  for (const line of lines) {
    const tag = parseTag(line.tag)
    if (tag) {
      const f = await of(tag.sessionId)
      const receipt = f.invocations.find((i) => i?.id === tag.receiptId)
      const checkpoint = f.checkpoints.find((c) => c.receipt === tag.receiptId)
      const turn = Number.isInteger(receipt?.turn) ? receipt.turn : checkpoint?.turn
      const dsh: CallLabel = {
        sessionId: tag.sessionId, match: 'tag',
        ...(f.title ? { title: f.title } : {}),
        ...(receipt?.origin === 'tool' || receipt?.origin === 'host' ? { origin: receipt.origin } : checkpoint ? { origin: 'host' as const } : {}),
        ...(Number.isInteger(turn) ? { turn } : {}),
        ...(typeof receipt?.toolCallId === 'string' ? { toolCallId: receipt.toolCallId } : {}),
        ...(typeof receipt?.step?.runId === 'string' && typeof receipt?.step?.stepKey === 'string' ? { step: { runId: receipt.step.runId, stepKey: receipt.step.stepKey } } : {}),
        ...(checkpoint ? { checkpoint: checkpointLabel(checkpoint, !!checkpoint.commit && checkpoint.changed > 0) } : {}),
      }
      out.push({ ...line, dsh, ...stored(line) })
      continue
    }
    const sim = parseSimTag(line.tag)
    if (sim) {
      const sessionId = simulationRoot(ctx, sim.runId)
      out.push({ ...line, sim: { ...sim, ...(sessionId ? { sessionId } : {}) }, ...stored(line) })
      continue
    }
    const version = line.commit ?? line.layer
    const hit = version ? versions().get(version) : undefined
    if (hit) {
      const f = await of(hit.sessionId)
      out.push({ ...line, dsh: { sessionId: hit.sessionId, match: 'commit', ...(f.title ? { title: f.title } : {}), turn: hit.checkpoint.turn, checkpoint: checkpointLabel(hit.checkpoint, false) }, ...stored(line) })
      continue
    }
    out.push({ ...line, ...stored(line) })
  }
  return out
}

/** The root session of a simulation run on this machine (its binding's `simulation.runId`), when known. */
function simulationRoot(ctx: Context, runId: string): string | undefined {
  try {
    const state = (ctx.get('layerfsSessions' as never) as any)?.state?.read?.()
    for (const [id, binding] of Object.entries<any>(state?.sessions ?? {})) {
      if (binding?.simulation?.runId === runId && !binding.simulation.rootSessionId) return id
    }
  } catch { /* label is optional */ }
  return undefined
}

/** The session a `dsh:<sessionId>:` prefix or exact `dsh:<sessionId>:<receipt>` tag names. */
export function sessionOfTag(tag: string | undefined): string | undefined {
  if (tag?.startsWith(TAG_PREFIX) && tag.endsWith(':')) {
    const id = tag.slice(TAG_PREFIX.length, -1)
    return id && id !== HOST_SESSION && !id.includes(':') ? id : undefined
  }
  return parseTag(tag)?.sessionId
}

/**
 * A call log line rebuilt from a sidecar receipt (§4): the receipt's own
 * `at`, `ms`, redacted `argv`, outcome code, kind, first version and tag.
 * Receipts written before those fields existed (no `at`) give none.
 */
export function receiptLine(receipt: any): CallLine | undefined {
  if (!receipt || typeof receipt !== 'object' || typeof receipt.id !== 'string' || typeof receipt.sessionId !== 'string' || !Number.isFinite(receipt.at)) return undefined
  const words = Array.isArray(receipt.argv) && receipt.argv.length >= 2 && receipt.argv.every((w: unknown) => typeof w === 'string') ? receipt.argv as string[] : undefined
  const [family, call] = String(receipt.operation ?? '').split('.')
  const argv = words ?? (family && call ? [family, call.replaceAll('_', '-')] : undefined)
  if (!argv) return undefined
  const version = Array.isArray(receipt.versions) ? receipt.versions.find((v: any) => v && typeof v.id === 'string') : undefined
  const outcome = receipt.outcome === 'success' ? 'ok' : typeof receipt.code === 'string' && receipt.code ? receipt.code : receipt.outcome === 'unknown' ? 'Unknown' : 'Failed'
  return {
    v: 1, at: receipt.at, ms: Number.isFinite(receipt.ms) ? Math.max(0, receipt.ms) : 0, client: 'cli', argv, outcome,
    ...(typeof receipt.kind === 'string' ? { kind: receipt.kind } : {}),
    ...(version?.kind === 'Commit' ? { commit: version.id } : version?.kind === 'Layer' ? { layer: version.id } : {}),
    tag: typeof receipt.tag === 'string' && receipt.tag ? receipt.tag : sessionTag(receipt.sessionId, receipt.id),
  }
}

const RECEIPT_CURSOR = 'receipt:'

/**
 * Lines for one session's imported receipts (never in this machine's log),
 * newest first, passing `args`' filters, minus any whose tag this machine's
 * log does hold (a session re-imported where it ran).
 */
async function importedLines(ctx: Context, sessionId: string, args: LogsListArgs): Promise<CallLine[]> {
  const persistence = ctx.get('sessionPersistence' as never) as any
  const sidecar = await Promise.resolve(persistence?.readSidecar?.(sessionId)).catch(() => undefined)
  const rows = (Array.isArray(sidecar?.invocations) ? sidecar.invocations : []).filter((r: any) => r?.imported === true && r.sessionId === sessionId)
  if (!rows.length) return []
  const { cursor: _cursor, limit: _limit, ...filters } = args
  const lines = rows.map(receiptLine).filter((line: CallLine | undefined): line is CallLine => !!line && matches(line, filters))
  if (!lines.length) return []
  const local = new Set((await callsSince(ctx.layerfs, `${TAG_PREFIX}${sessionId}:`, 0).catch(() => [])).map((line) => line.tag))
  return lines.filter((line: CallLine) => !local.has(line.tag)).sort((a: CallLine, b: CallLine) => b.at - a.at)
}

/**
 * `logs.list`: one page from the active source; for a session tag, once that
 * source has no more lines, the session's imported receipts follow
 * (`source: 'receipt'`, paged by a `receipt:<offset>` cursor).
 */
export async function listPage(ctx: Context, args: LogsListArgs): Promise<{ page: CallPage, receipts: number }> {
  const sessionId = sessionOfTag(args.tag)
  const limit = args.limit ?? 100
  if (args.cursor?.startsWith(RECEIPT_CURSOR)) {
    const from = Number(args.cursor.slice(RECEIPT_CURSOR.length))
    if (!sessionId || !Number.isInteger(from) || from < 0) throw Object.assign(new Error('The log cursor is not valid; list from the start'), { code: 'InvalidInput' })
    const all = await importedLines(ctx, sessionId, args)
    const lines = all.slice(from, from + limit), more = from + lines.length < all.length
    const source = (await ctx.layerfs.nativeLogs()) ? 'layerfs' as const : 'plugin' as const
    return { page: { lines, ...(more ? { next: `${RECEIPT_CURSOR}${from + lines.length}` } : {}), has_more: more, skipped: 0, source }, receipts: lines.length }
  }
  const page = await readCalls(ctx.layerfs, args)
  if (!sessionId || page.has_more) return { page, receipts: 0 }
  const all = await importedLines(ctx, sessionId, args)
  if (!all.length) return { page, receipts: 0 }
  const lines = all.slice(0, Math.max(0, limit - page.lines.length)), more = lines.length < all.length
  return { page: { ...page, lines: [...page.lines, ...lines], ...(more ? { next: `${RECEIPT_CURSOR}${lines.length}` } : {}), has_more: more }, receipts: lines.length }
}

export function apply(ctx: Context): void {
  // Stand-in appends (this process, or agent shells' wrappers) → one `logs` event a second at most.
  let timer: NodeJS.Timeout | undefined, dirty = false
  const fire = () => {
    if (timer) { dirty = true; return }
    ctx.layerfs.emit(LOGS_EVENT, { at: Date.now() })
    timer = setTimeout(() => { timer = undefined; if (dirty) { dirty = false; fire() } }, 1000)
    timer.unref?.()
  }
  ctx.effect(() => () => { clearTimeout(timer); timer = undefined }, 'dsh-layerfs: logs event')
  ctx.effect(() => onCallLogAppend(ctx.layerfs.callLog, fire), 'dsh-layerfs: logs appends')
  ctx.effect(() => {
    try {
      mkdirSync(dirname(ctx.layerfs.callLog), { recursive: true, mode: 0o700 })
      const watcher = watch(dirname(ctx.layerfs.callLog), (_event, file) => { if (!file || String(file).startsWith('calls')) fire() })
      watcher.on('error', () => {})
      watcher.unref?.()
      return () => watcher.close()
    } catch { return () => {} }
  }, 'dsh-layerfs: logs watch')

  ctx.layerfsRemote.operate(ctx, {
    'logs.list': async (args: any): Promise<LogsListAnswer> => {
      const { page, receipts } = await listPage(ctx, listArgs(args))
      const lines = await label(ctx, page.lines, outputsDir(ctx.layerfs.callLog))
      const from = lines.length - receipts
      return { ...page, lines: lines.map((line, index) => index >= from ? { ...line, source: 'receipt' as const } : line) }
    },
    'logs.project': async (args: any): Promise<LogsProjectAnswer> => {
      const project = typeof args?.project === 'string' ? args.project : ''
      if (!/^[^/\s]+\/[^/\s]+$/.test(project)) throw Object.assign(new Error('logs.project needs a project, <store>/<project>'), { code: 'InvalidInput' })
      const known = Array.isArray(args?.sandboxes) ? args.sandboxes.filter((s: unknown): s is string => typeof s === 'string' && !!s) : []
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(2000, Math.floor(args.limit))) : 500
      const page = await projectCalls(ctx.layerfs, project, known, limit)
      return { ...page, lines: await label(ctx, page.lines, outputsDir(ctx.layerfs.callLog)) }
    },
    'logs.output': async (args: any): Promise<LogsOutputAnswer> => {
      const tag = args?.tag
      if (!validOutputTag(tag)) throw Object.assign(new Error('logs.output needs the dsh: tag of a call made through DSH'), { code: 'InvalidInput' })
      return readOutput(outputsDir(ctx.layerfs.callLog), tag)
    },
    'logs.reset': async () => {
      const answer = await resetCalls(ctx.layerfs)
      ctx.layerfs.emit(LOGS_EVENT, { at: Date.now() })
      return answer
    },
  })
}
