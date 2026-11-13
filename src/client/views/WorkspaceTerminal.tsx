/**
 * A workspace's terminal on the Sandbox map: what ran in it up to the replay
 * clock, as a transcript. The call log redacts commands and keeps little
 * output, so each call is joined to the agent's tool call that made it (its
 * tag's receipt id → `session.trajectory`), whose arguments hold the command
 * the agent typed and whose result holds what it printed
 * (`session.trajectory.record`). A call with no tool call (another client, a
 * log not loaded) shows its redacted words and what this plugin kept of its
 * output (`logs.output`). Calls one tool call made share one entry.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { parseTag, type LogsOutputAnswer } from '../../shared/logs.ts'
import type { TrajectoryAnswer, TrajectoryDetail } from '../../shared/trajectory.ts'
import type { ViewProps } from './FileViews.tsx'
import type { Translate } from './locale.ts'
import { execWords, sanitizeCommand, stamp, type MapEvent } from './model.ts'
import css from './workspace-terminal.module.css'

/** Newest entries kept on screen. */
const ENTRIES = 12
/** Output characters shown per entry (the tail: where results and errors are). */
const OUTPUT_TAIL = 6000

interface ToolRef { sessionId: string, seq: number, name: string, summary?: string, result?: string, isError?: boolean }
interface Entry { key: string, events: MapEvent[], tool?: ToolRef }

/** Receipt id → the tool call that made it, per session, read once per growth of the calls. */
function useToolCalls(api: ViewProps['api'], events: readonly MapEvent[]) {
  const sessions = [...new Set(events.map((e) => parseTag(e.tag)?.sessionId).filter((id): id is string => !!id))].sort()
  const key = `${sessions.join('|')}#${events.filter((e) => e.tag).length}`
  const [byReceipt, setByReceipt] = useState<Map<string, ToolRef>>(new Map())
  useEffect(() => {
    let live = true
    Promise.all(sessions.map((sessionId) => api.op<TrajectoryAnswer>('session.trajectory', { sessionId }).then((answer) => {
      const out: [string, ToolRef][] = []
      for (const turn of answer.turns ?? []) for (const record of turn.records ?? []) {
        if (record.kind !== 'tool') continue
        const ref: ToolRef = { sessionId, seq: record.seq, name: record.name, summary: record.summary, result: record.result, isError: record.isError }
        for (const op of record.ops ?? []) out.push([op.id, ref])
      }
      return out
    }, () => [] as [string, ToolRef][]))).then((pairs) => { if (live) setByReceipt(new Map(pairs.flat())) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key])
  return byReceipt
}

/** The bash command in a tool call's arguments, else the raw arguments. */
function commandOf(args: string | undefined, fallback: string | undefined): string | undefined {
  if (!args) return fallback
  try {
    const value = JSON.parse(args)
    for (const k of ['command', 'cmd', 'script']) if (typeof value?.[k] === 'string' && value[k].trim()) return value[k]
  } catch { /* not JSON */ }
  return args.trim() || fallback
}

const tail = (text: string) => text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text

export function WorkspaceTerminal({ api, t, events: all, wsName, now, agentName, laneOf, reduced }: {
  api: ViewProps['api']
  t: Translate
  /** This workspace's calls that started by `now`, oldest first. */
  events: readonly MapEvent[]
  /** The workspace's own name, for `$DSH_LAYERFS_WS` in commands. */
  wsName: string
  now: number
  agentName: (id: string) => string
  laneOf: (agent: string) => string
  reduced: boolean
}): ReactNode {
  // A terminal shows what ran: the execs (mounts and saves are on the map and in Activity).
  const events = useMemo(() => all.filter((e) => e.method === 'workspace.exec'), [all])
  const tools = useToolCalls(api, events)
  const entries = useMemo(() => {
    const out: Entry[] = []
    for (const e of events) {
      const receipt = parseTag(e.tag)?.receiptId
      const tool = receipt ? tools.get(receipt) : undefined
      const last = out.at(-1)
      if (tool && last?.tool && last.tool.sessionId === tool.sessionId && last.tool.seq === tool.seq) last.events.push(e)
      else out.push({ key: tool ? `${tool.sessionId}:${tool.seq}` : e.id, events: [e], ...(tool ? { tool } : {}) })
    }
    return out.slice(-ENTRIES)
  }, [events, tools])

  // Full arguments and result of the tool calls on screen; what this plugin kept for the others.
  const [details, setDetails] = useState<Record<string, TrajectoryDetail | null>>({})
  const [outputs, setOutputs] = useState<Record<string, LogsOutputAnswer>>({})
  const wanted = entries.map((entry) => entry.key).join('|')
  useEffect(() => {
    let live = true
    for (const entry of entries) {
      if (entry.tool) {
        if (entry.key in details) continue
        const { sessionId, seq } = entry.tool
        api.op<TrajectoryDetail>('session.trajectory.record', { sessionId, seq })
          .then((d) => { if (live) setDetails((m) => ({ ...m, [entry.key]: d })) }, () => { if (live) setDetails((m) => ({ ...m, [entry.key]: null })) })
      } else {
        const e = entry.events[0]
        if (!e.tag || !e.output || e.tag in outputs) continue
        api.op<LogsOutputAnswer>('logs.output', { tag: e.tag })
          .then((o) => { if (live) setOutputs((m) => ({ ...m, [e.tag!]: o })) }, () => { if (live) setOutputs((m) => ({ ...m, [e.tag!]: { missing: true } })) })
      }
    }
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, wanted])

  // Follow the newest entry, as a terminal does (again as outputs arrive).
  const scroller = useRef<HTMLDivElement>(null)
  const newest = `${entries.at(-1)?.key}:${entries.at(-1)?.events.filter((e) => e.end <= now).length}:${Object.keys(details).length}:${Object.keys(outputs).length}`
  useLayoutEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight }, [newest])

  if (entries.length === 0) return <div className={css.terminal}><p className={css.quiet}>{t('wsTerminalEmpty')}</p></div>
  return (
    <div className={css.terminal} ref={scroller} role="log" aria-label={t('wsTerminal')}>
      {entries.map((entry) => {
        const first = entry.events[0], lastCall = entry.events.at(-1)!
        const running = entry.events.some((e) => e.end > now)
        const failed = entry.events.find((e) => e.end <= now && e.outcome !== 'ok')
        const detail = entry.tool ? details[entry.key] : undefined
        const typed = entry.tool ? commandOf(detail?.args, entry.tool.summary) : undefined
        const kept = !entry.tool && first.tag ? outputs[first.tag] : undefined
        const keptText = kept && !('missing' in kept) ? [kept.stdout, kept.stderr].filter(Boolean).join('\n').trim() : ''
        const raw = (entry.tool ? (detail?.result ?? entry.tool.result ?? '') : keptText).trim()
        const result = raw === '(no output)' ? '' : raw
        const exit = kept && !('missing' in kept) ? kept.exit : undefined
        const words = entry.tool ? null : execWords(first.argv)
        const shown = typed ? sanitizeCommand(typed, wsName) : words
        return (
          <div key={entry.key} className={css.entry} style={{ ['--lane' as string]: laneOf(first.agent) }}
            title={`${agentName(first.agent)} · ${stamp(first.start)}${typed ? `\n${typed}` : ''}`}>
            <pre className={css.command}><span className={css.prompt}>$</span>{shown ?? <span className={css.dim}>{t('wsCommandNotKept')}</span>}</pre>
            {running ? (
              <div className={css.waiting}>{!reduced && Math.floor((now - lastCall.start) * 1.8) % 2 === 1 ? null : <span className={css.cursor} />}</div>
            ) : entry.tool && detail === undefined && !entry.tool.result ? (
              <div className={css.waiting}>{t('loading')}</div>
            ) : result ? (
              <pre className={clsx(css.output, (failed || entry.tool?.isError) && css.outputBad)}>{tail(result)}</pre>
            ) : null}
            {!running && (failed || (exit != null && exit !== 0)) ? (
              <div className={css.bad}>{failed ? failed.outcome : t('trajExit', { code: exit! })}</div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
