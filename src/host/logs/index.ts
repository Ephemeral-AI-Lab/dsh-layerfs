/**
 * Logs area, host half (docs/specs/layerfs-logs.md §5–§6).
 *
 * Operations (the `layerfs` Remote):
 *   logs.list LogsListArgs   one page of call log lines, newest first, each
 *                            labelled with the project session, turn and
 *                            checkpoint it belongs to (`dsh`, see CallLabel)
 *   logs.reset {}            clear the history (the active source's) and the stored outputs
 *   logs.output {tag}        what one call made through DSH printed (`CallOutput`),
 *                            or `{missing: true}` when none is kept
 *
 * Event: `logs` after stand-in appends (at most once a second).
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, watch } from 'node:fs'
import { dirname } from 'node:path'
import { isDshTag, LOGS_EVENT, parseTag, type CallLabel, type CallLine, type LabeledLine, type LogsListAnswer, type LogsOutputAnswer } from '../../shared/logs.ts'
import { onCallLogAppend } from '../layerfs/call-log.ts'
import { hasOutput, outputsDir, readOutput, validOutputTag } from '../layerfs/call-output.ts'
import type { Checkpoint } from '../sessions/state.ts'
import { listArgs, readCalls, resetCalls } from './source.ts'

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
        ...(checkpoint ? { checkpoint: checkpointLabel(checkpoint, !!checkpoint.commit && checkpoint.changed > 0) } : {}),
      }
      out.push({ ...line, dsh, ...stored(line) })
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
      const page = await readCalls(ctx.layerfs, listArgs(args))
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
