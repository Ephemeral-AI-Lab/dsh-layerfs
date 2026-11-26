/**
 * The LayerFS trajectory (docs/specs/layerfs-trajectory.md): the Trajectory
 * tab of a LayerFS project session, shadowing DSH's stock one. A lighter copy
 * of DSH's view (toolbar, four-lane timeline, records by turn, inspector) that
 * adds, under each tool call, the LayerFS calls it made and the 0..n versions
 * they created, kept or pointed at. A version opens the History tab at that
 * commit; Chat's "inspect" opens this view on a call (`focus` is its call id).
 * Read only: built by the host's `session.trajectory` op.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconDatabaseOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { StatusDot } from '../ui/StatusDot.tsx'
import type { LayerfsApi } from '../api.ts'
import { EmptyState, ErrorState, Loading } from '../files/States.tsx'
import { cachedAnswer, useQuery } from '../files/use-query.ts'
import { isUnchanged, type RequestRecord, type ToolRecord, type TraceVersion, type TrajectoryAnswer, type TrajectoryRecord, type TrajectoryReply, type TrajectoryTurn } from '../../shared/trajectory.ts'
import { HISTORY_VIEW, useNoComposer, type ViewProps } from './FileViews.tsx'
import { useSessionRows } from './hooks.ts'
import { isStreamingAssistant, mergeLiveSteps, useLiveSteps } from './live-step.ts'
import type { Translate } from './locale.ts'
import { TrajectoryInspector, type DetailCache, type Inspected, type InspectorTab, type PromptDiffCache } from './TrajectoryInspector.tsx'
import { openLogs } from '../logs/request.ts'
import { clock, durationText, KindCell, OpLine, toolsDelta, usageText, Versions, type OpenVersion } from './TrajectoryParts.tsx'
import { TrajectoryTimeline } from './TrajectoryTimeline.tsx'
import {
  checkpointVersion, filterTurns, flattenRows, focusTarget, loadedRecords, mergeOlder, opWrites, recentTurns, recordMatches, ROW_PAGE, SAVES,
  selectionTurn, timeSpan, type Row, type Selection,
} from './trajectory-model.ts'
import views from './views.module.css'
import css from './trajectory.module.css'

/** DSH's Trajectory view id; this view shadows it while a project session is on screen. */
export const TRAJECTORY_VIEW = 'trajectory'
/** While the session runs, how often the trajectory is read again (shell receipts land when the turn settles). */
const RUNNING_POLL_MS = 3000
/** Events wait this long so a burst reads once. */
const REFRESH_MS = 1000
/**
 * Older pages a focus request (Chat's inspect) reads to find a call, then it
 * gives up. A first page is a few hundred records, so reaching a session's
 * first turns takes several reads; the bound still covers a long session.
 */
const FOCUS_PAGES = 40
/** Host events after which the trajectory may have changed (`{sessionId}` or none). */
const EVENTS = ['layerfs-operation', 'layerfs-checkpoint', 'layerfs-session'] as const

/**
 * `session.trajectory` of `sessionId`, read again on its LayerFS events, on reconnect and
 * while it runs. One read at a time: events during a read queue one more (a run fires them
 * many a second), at most one per second; the last answer draws at once on a remount.
 *
 * Every read passes the revision of the answer on screen (`since`), so a read where
 * nothing moved answers `unchanged` and the rows stay as they are. A reconnect
 * forgets the revision: the feed may have missed events while it was down.
 * Idle sessions are not polled — their events cover every change — and while a
 * session runs the 3 s poll stays as a fallback for receipts that land without
 * one, now that an unchanged poll costs bytes rather than a rebuild.
 */
function useTrajectory(api: LayerfsApi, sessionId: string, running: boolean) {
  const [tick, setTick] = useState(0)
  const cacheKey = `session.trajectory:${sessionId}`
  const full = useRef(false)
  const query = useQuery(() => {
    const kept = cachedAnswer<{ sessionId: string, answer: TrajectoryAnswer }>(cacheKey)
    const since = !full.current && kept?.sessionId === sessionId ? kept.answer.revision : undefined
    full.current = false
    return api.op<TrajectoryReply>('session.trajectory', { sessionId, ...(since ? { since } : {}) }).then((reply) => {
      if (!isUnchanged(reply)) return { sessionId, answer: reply }
      if (kept) return kept
      throw new Error('session.trajectory answered unchanged without a kept answer')
    })
  }, [api, sessionId], { refresh: [tick], cache: cacheKey })
  const reload = useCallback(() => setTick((n) => n + 1), [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => { if (!timer) timer = setTimeout(() => { timer = undefined; reload() }, REFRESH_MS) }
    const mine = (e: { data?: any }) => { if (!e.data?.sessionId || e.data.sessionId === sessionId) later() }
    const offs = EVENTS.map((name) => api.onEvent(name, mine))
    offs.push(api.onEvent('connection', () => { full.current = true; later() }))
    return () => { offs.forEach((off) => off()); if (timer) clearTimeout(timer) }
  }, [api, sessionId, reload])
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') reload() }, RUNNING_POLL_MS)
    return () => clearInterval(timer)
  }, [running, reload])
  const answer = query.data?.sessionId === sessionId ? query.data.answer : null
  return { answer, error: answer ? null : query.error ?? null, reload }
}

/** What a selection points at in the answer. */
function inspectedOf(answer: TrajectoryAnswer, key: Selection, t: Translate): Inspected | null {
  const [kind, a, b] = key.split(':')
  for (const turn of answer.turns) {
    if (kind === 'r') {
      const record = turn.records.find((r) => r.seq === Number(a))
      if (record) return { kind: 'record', turn: turn.turn, record }
    } else if (kind === 'c' && turn.turn === Number(a)) {
      const checkpoint = turn.checkpoints[Number(b)]
      return checkpoint ? { kind: 'checkpoint', turn: turn.turn, checkpoint } : null
    } else if (kind === 'h' && turn.turn === Number(a)) {
      return turn.hostOps.length ? { kind: 'ops', turn: turn.turn, title: t('trajHost'), ops: turn.hostOps } : null
    } else if (kind === 'o') {
      const call = turn.orphanCalls.find((c) => c.callId === key.slice(2))
      if (call) return { kind: 'ops', turn: turn.turn, title: t('trajOrphan'), ops: call.ops }
    }
  }
  return null
}

/** A request's compact line, in the reader's words: the model route and tool count. */
export function requestLine(record: Extract<RequestRecord, { kind: 'request' }>, t: Translate): string {
  const route = record.provider && record.model ? `${record.provider}/${record.model}` : record.model ?? record.provider ?? ''
  return [route, t('trajRequestToolsCount', { n: record.tools })].filter(Boolean).join(' · ')
}

/** One record's line: its words, and for a tool call `name summary → result`. */
export function RecordText({ record, t }: { record: TrajectoryRecord, t: Translate }): ReactNode {
  if (record.kind === 'tool') {
    const running = record.result === undefined && record.endedAt === undefined
    return (
      <span className={css.text}>
        <span className={clsx(css.toolName, record.isError && css.errorText)}>{record.name}</span>
        {record.summary ? <span className={css.summary}>{record.summary}</span> : null}
        {running
          ? <span className={css.running}><StatusDot state="ongoing" size={10} />{t('trajRunning')}</span>
          : record.result ? <span className={clsx(css.result, record.isError && css.errorText)}><span className={css.arrow} aria-hidden="true">→</span>{record.result}</span> : null}
      </span>
    )
  }
  if (record.kind === 'assistant') {
    const usage = record.usage ? usageText(t, record.usage) : ''
    const live = isStreamingAssistant(record)
    return (
      <span className={css.text}>
        {record.text
          ? <span className={css.plain}>{record.text}{live && record.streaming ? <span className={css.streamCaret} aria-hidden="true" /> : null}</span>
          : <span className={css.muted}>{live && record.streaming ? t('trajWaitingText') : t('trajToolCallOnly')}</span>}
        {live && record.streaming ? <span className={css.running}><StatusDot state="ongoing" size={10} />{t('trajStreaming')}</span> : null}
        {live && record.truncated ? <span className={css.warnText}>{t('trajLiveTruncated')}</span> : null}
        {record.thinking ? <span className={css.badge}>{t('trajThought')}</span> : null}
        {record.interrupted ? <span className={clsx(css.badge, css.warnText)}>{t('trajInterrupted')}</span> : null}
        {usage ? <span className={css.usage}>{usage}</span> : null}
      </span>
    )
  }
  if (record.kind === 'system') {
    return (
      <span className={css.text}>
        {record.source ? <span className={css.badge}>{record.source}</span> : null}
        {record.promptChanged ? <span className={css.promptHint}>{t(`trajPromptChanged_${record.promptChanged}`)}</span> : null}
        {record.text ? <span className={css.plain}>{record.text}</span> : <span className={css.muted}>{t('trajNoText')}</span>}
      </span>
    )
  }
  if (record.kind === 'request') {
    return (
      <span className={css.text}>
        <span className={css.plain}>{requestLine(record, t)}</span>
        {toolsDelta(record.toolsChanged, t)}
        {record.promptChanged ? <span className={css.promptHint}>{t(`trajPromptChanged_${record.promptChanged}`)}</span> : null}
        {record.reason ? <span className={css.badge}>{record.reason}</span> : null}
      </span>
    )
  }
  if (record.kind === 'observation') {
    // One session-level line for the read-only calls folded into a counter: the
    // sentence and its top operations, never a per-poll row.
    return (
      <span className={css.text}>
        <span className={css.plain}>{record.text}</span>
        {record.top?.length ? <span className={css.muted} title={record.top.join(' · ')}>{record.top.slice(0, 3).join(' · ')}{record.top.length > 3 ? ' …' : ''}</span> : null}
      </span>
    )
  }
  return (
    <span className={css.text}>
      {record.kind === 'context' ? <span className={css.badge}>{record.source}</span> : null}
      <span className={clsx(css.plain, record.kind === 'context' && css.muted)}>{record.text}</span>
    </span>
  )
}

function recordMeta(record: TrajectoryRecord, t: Translate, now: number): string {
  if (record.kind === 'tool') {
    const end = record.endedAt ?? (record.result === undefined ? now : undefined)
    return record.at && end ? durationText(t, end - record.at) : clock(record.at)
  }
  if (record.kind === 'assistant' && record.startedAt && record.at) return durationText(t, record.at - record.startedAt)
  return clock(record.at)
}

function TurnHead({ turn, t }: { turn: TrajectoryTurn, t: Translate }): ReactNode {
  const meta = [turn.at ? clock(turn.at) : '', turn.at && turn.endAt ? durationText(t, turn.endAt - turn.at) : ''].filter(Boolean).join(' · ')
  const older = turn.totalRecords !== undefined ? turn.totalRecords - turn.records.length : 0
  return (
    <>
      <span className={css.turnTitle}>{turn.turn > 0 ? t('trajTurn', { n: turn.turn }) : t('trajBeforeTurns')}</span>
      {meta ? <span className={css.turnMeta}>{meta}</span> : null}
      {older > 0 ? <span className={css.turnMeta}>{t('trajOlderRecords', { n: older })}</span> : null}
    </>
  )
}

interface RowHandlers {
  t: Translate
  now: number
  selected: Selection | null
  onSelect: (key: Selection, tab?: InspectorTab) => void
  onToggleTurn: (turn: number, open: boolean) => void
  onToggleCall: (record: ToolRecord, open: boolean) => void
  onToggleContext: (turn: number, open: boolean) => void
  onOpen: OpenVersion
}

function Chevron({ open }: { open: boolean }): ReactNode {
  return open ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />
}

/** Fold/unfold toggle with crisp 14px SVG glyph. */
function FoldToggle({ folded, label, expand, collapse, onClick }: { folded: boolean, label: string, expand: string, collapse: string, onClick: () => void }): ReactNode {
  return (
    <button type="button" className={css.action} aria-label={folded ? expand : collapse} title={folded ? expand : collapse} onClick={onClick}>
      <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.35} strokeLinecap="round" strokeLinejoin="round" className={css.actionIcon} aria-hidden="true">
        <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.5" />
        <path d={folded ? 'M5.5 8h5M8 5.5v5' : 'M5.5 8h5'} />
      </svg>
      <span>{label}</span>
    </button>
  )
}

function TableRow({ row, h }: { row: Row, h: RowHandlers }): ReactNode {
  const { t } = h
  switch (row.type) {
    case 'turn':
      return (
        <div className={css.turnRow} data-row={row.key}>
          <button type="button" className={css.turnButton} aria-expanded={row.open} onClick={() => h.onToggleTurn(row.turn.turn, !row.open)}>
            <Chevron open={row.open} /><TurnHead turn={row.turn} t={t} />
          </button>
        </div>
      )
    case 'contextToggle':
      return (
        <div className={clsx(css.row, css.contextRow)} data-row={row.key}>
          <span />
          <button type="button" className={css.contextToggle} aria-expanded={row.open} onClick={() => h.onToggleContext(row.turn, !row.open)}>
            <Chevron open={row.open} />{row.open ? t('trajContextHide') : t('trajContextShow', { n: row.count })}
          </button>
        </div>
      )
    case 'record': {
      const { record } = row
      const tool = record.kind === 'tool' ? record : null
      const writes = tool ? tool.ops.some(opWrites) : false
      return (
        <div className={clsx(css.row, row.key === h.selected && css.selected, record.kind === 'context' && css.contextRecord)} data-row={row.key}>
          {tool && tool.ops.length ? (
            <button type="button" className={css.expander} aria-expanded={row.open} aria-label={row.open ? t('trajCollapseCalls') : t('trajExpandCalls')}
              onClick={() => h.onToggleCall(tool, !row.open)}><Chevron open={row.open} /></button>
          ) : <span />}
          {isStreamingAssistant(record) ? (
            <div className={clsx(css.rowMain, css.streamRowMain)} aria-busy={record.streaming}>
              <KindCell kind={record.kind} t={t} />
              <RecordText record={record} t={t} />
            </div>
          ) : (
            <button type="button" className={css.rowMain} aria-pressed={row.key === h.selected} onClick={() => h.onSelect(row.key)}>
              <KindCell kind={record.kind} t={t} />
              <RecordText record={record} t={t} />
            </button>
          )}
          {tool && tool.ops.length ? (
            <span className={clsx(css.opCount, writes && css.opCountWrites)} title={t('trajLayerfsCalls')}>{tool.ops.length}</span>
          ) : <span />}
          <span className={css.meta}>{recordMeta(record, t, h.now)}</span>
        </div>
      )
    }
    case 'op':
      return (
        <div className={clsx(css.row, css.opRow, row.parent === h.selected && css.selectedChild)} data-row={row.key}>
          <span />
          <button type="button" className={css.opMain} onClick={() => h.onSelect(row.parent, 'layerfs')}>
            <OpLine op={row.op} t={t} onOpen={h.onOpen} />
          </button>
        </div>
      )
    case 'orphan':
      return (
        <div className={clsx(css.row, row.key === h.selected && css.selected)} data-row={row.key}>
          <span />
          <button type="button" className={css.rowMain} onClick={() => h.onSelect(row.key, 'layerfs')}>
            <KindCell kind="layerfs" t={t} />
            <span className={css.text}><span className={css.muted}>{t('trajOrphan')}</span><span className={css.summary}>{row.callId}</span></span>
          </button>
          <span />
          <span className={css.meta}>{clock(row.ops[0]?.at)}</span>
          <div className={css.inlineOps}>{row.ops.map((op) => <OpLine key={op.id} op={op} t={t} onOpen={h.onOpen} />)}</div>
        </div>
      )
    case 'host':
      return (
        <div className={clsx(css.row, row.key === h.selected && css.selected, !row.shown.length && css.quiet)} data-row={row.key}>
          <span />
          <button type="button" className={css.rowMain} onClick={() => h.onSelect(row.key, 'layerfs')}>
            <KindCell kind="layerfs" t={t} />
            <span className={css.text}><span>{t('trajHost')}</span>{row.reads ? <span className={css.muted}>{t('trajReadsHidden', { n: row.reads })}</span> : null}</span>
          </button>
          <span />
          <span />
          {row.shown.length ? <div className={css.inlineOps}>{row.shown.map((op) => <OpLine key={op.id} op={op} t={t} onOpen={h.onOpen} />)}</div> : null}
        </div>
      )
    case 'checkpoint': {
      const { checkpoint } = row
      const version = checkpointVersion(checkpoint)
      return (
        <div className={clsx(css.row, css.checkpointRow, row.key === h.selected && css.selected)} data-row={row.key}>
          <span />
          <button type="button" className={css.rowMain} onClick={() => h.onSelect(row.key)}>
            <KindCell kind="checkpoint" t={t} />
            <span className={css.text}>
              <span className={css.checkpointLabel}>{t('trajCheckpoint', { kind: t(`trajCp_${checkpoint.kind}`) })}</span>
              <span className={css.plain}>{checkpoint.message}</span>
              {checkpoint.error
                ? <span className={css.warnText}>{t('trajFailed', { code: checkpoint.error.code })}</span>
                : SAVES.has(checkpoint.kind) ? <span className={css.muted}>{checkpoint.changed > 0 ? t('trajChanged', { n: checkpoint.changed }) : t('trajUnchanged')}</span> : null}
            </span>
          </button>
          {version ? <Versions versions={[version]} t={t} onOpen={h.onOpen} /> : <span />}
          <span className={css.meta}>{clock(checkpoint.at)}</span>
        </div>
      )
    }
  }
}

export function TrajectoryView(props: ViewProps): ReactNode {
  const { api, t, sessionId, sessions, openView, viewRequest, completeViewRequest } = props
  const { byId } = useSessionRows(sessions)
  const running = !!byId[sessionId]?.running
  const { answer: first, error, reload } = useTrajectory(api, sessionId, running)
  // Older pages loaded on request, merged under the first page they belong to.
  // A new first page (a change, or a reconnect) drops them.
  const [older, setOlder] = useState<{ base: TrajectoryAnswer, answer: TrajectoryAnswer } | null>(null)
  const [olderBusy, setOlderBusy] = useState(false)
  const answer = first && older?.base === first ? older.answer : first
  // The running step's text arrives on the session's live feed; the host answer
  // gains its record only after the step's message is logged.
  const live = useLiveSteps(props.liveStep)
  const turns = useMemo(() => answer ? mergeLiveSteps(answer.turns, live) : [], [answer, live])
  // A project session's LayerFS tabs have no composer; a normal session shown
  // beside one (split view) keeps it here, as DSH's stock Trajectory does.
  const layerfs = !!answer?.project
  useNoComposer(props.hideComposer, layerfs)

  const [onlyWrites, setOnlyWrites] = useState(false)
  const [query, setQuery] = useState('')
  const [turnsDefault, setTurnsDefault] = useState<'recent' | 'all' | 'none'>('recent')
  const [turnOverride, setTurnOverride] = useState<ReadonlyMap<number, boolean>>(new Map())
  const [callsDefault, setCallsDefault] = useState(true)
  const [callOverride, setCallOverride] = useState<ReadonlyMap<number, boolean>>(new Map())
  const [contextOpen, setContextOpen] = useState<ReadonlySet<number>>(new Set())
  const [selected, setSelected] = useState<Selection | null>(null)
  const [tab, setTab] = useState<InspectorTab>('summary')
  const [limit, setLimit] = useState(ROW_PAGE)
  const [scrollTo, setScrollTo] = useState<Selection | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const cache = useRef<DetailCache>(new Map()).current
  const diffs = useRef<PromptDiffCache>(new Map()).current

  // A new conversation starts over.
  useEffect(() => {
    setSelected(null); setTurnOverride(new Map()); setCallOverride(new Map()); setContextOpen(new Set()); setLimit(ROW_PAGE)
    setOlder(null); setOlderBusy(false)
    cache.clear(); diffs.clear()
  }, [sessionId, cache, diffs])

  /** Ask for the next older page; one request at a time, and only while this first page says there is one. */
  const loadOlder = useCallback(() => {
    if (!first || !answer || olderBusy || !answer.hasMore || answer.olderBefore === undefined) return
    const base = first
    const before = answer.olderBefore
    setOlderBusy(true)
    api.op<TrajectoryAnswer>('session.trajectory', { sessionId, before }).then((page) => {
      setOlder((prev) => ({ base, answer: mergeOlder(prev && prev.base === base ? prev.answer : base, page) }))
    }).catch(() => { /* the button stays; the next press retries */ }).finally(() => setOlderBusy(false))
  }, [api, sessionId, first, answer, olderBusy])

  const now = useMemo(() => Date.now(), [answer]) // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = useMemo(() => filterTurns(turns, { onlyWrites, query }), [turns, onlyWrites, query])
  const recent = useMemo(() => recentTurns(turns), [turns])
  const searching = query.trim().length > 0
  const turnOpen = useCallback((turn: number) => turnOverride.get(turn)
    ?? (searching || turnsDefault === 'all' ? true : turnsDefault === 'none' ? false : recent.has(turn)), [turnOverride, turnsDefault, recent, searching])
  const callOpen = useCallback((record: ToolRecord) => callOverride.get(record.seq) ?? callsDefault, [callOverride, callsDefault])
  const rows = useMemo(() => flattenRows(filtered, { turnOpen, callOpen, contextOpen: (turn) => contextOpen.has(turn) }, searching),
    [filtered, turnOpen, callOpen, contextOpen, searching])

  const select = useCallback((key: Selection, next?: InspectorTab) => {
    setSelected(key)
    if (next) setTab(next)
  }, [])
  const onOpen = useMemo<OpenVersion>(() => openView
    ? (v: TraceVersion) => { if (v.branch) openView(HISTORY_VIEW, JSON.stringify({ branch: v.branch, commit: v.id })) }
    : undefined, [openView])

  /** Make a selection visible: open its turn (and context), lift filters that hide it, then scroll to it. */
  const reveal = useCallback((key: Selection, record?: TrajectoryRecord) => {
    if (!answer) return
    const turn = selectionTurn(answer, key)
    if (turn !== null) setTurnOverride((m) => new Map(m).set(turn, true))
    if (record) {
      if (onlyWrites && !(record.kind === 'tool' && record.ops.some(opWrites))) setOnlyWrites(false)
      if (query.trim() && !recordMatches(record, query.trim().toLowerCase())) setQuery('')
      if (record.kind === 'context' && turn !== null) setContextOpen((s) => new Set(s).add(turn))
    }
    setScrollTo(key)
  }, [answer, onlyWrites, query])

  // Chat's "inspect" and `openView('trajectory', callId)`: take the request once, apply it when the call is loaded.
  const [pending, setPending] = useState<{ focus: string, missedOn: TrajectoryAnswer | null } | null>(null)
  /** Older pages read so far for the pending focus, which bounds a focus that names nothing. */
  const focusPages = useRef(0)
  useEffect(() => {
    if (!viewRequest || viewRequest.view !== TRAJECTORY_VIEW) return
    focusPages.current = 0
    setPending({ focus: viewRequest.focus, missedOn: null })
    completeViewRequest?.()
    reload()
  }, [viewRequest, completeViewRequest, reload])
  useEffect(() => {
    if (!pending || !answer) return
    const target = focusTarget(answer, pending.focus)
    if (!target) {
      // The call may be newer than this answer (wait for the reread asked above)
      // or older than the page: read the next older page, at most FOCUS_PAGES,
      // then give up.
      if (answer.hasMore && answer.olderBefore !== undefined) {
        if (!olderBusy && focusPages.current < FOCUS_PAGES) {
          focusPages.current++
          if (pending.missedOn !== answer) setPending({ ...pending, missedOn: answer })
          loadOlder()
        }
        return
      }
      if (!pending.missedOn) setPending({ ...pending, missedOn: answer })
      else if (pending.missedOn !== answer) setPending(null)
      return
    }
    setPending(null)
    const key = `r:${target.record.seq}` as const
    select(key, 'summary')
    reveal(key, target.record)
  }, [pending, answer, select, reveal, olderBusy, loadOlder])

  // Scroll a revealed row into view once it is rendered (raising the row cap when needed).
  useEffect(() => {
    if (!scrollTo) return
    const index = rows.findIndex((r) => r.key === scrollTo)
    if (index < 0) return
    if (index >= limit) { setLimit(index + ROW_PAGE / 2); return }
    const el = scroller.current?.querySelector(`[data-row="${CSS.escape(scrollTo)}"]`)
    if (el) { el.scrollIntoView({ block: 'center' }); setScrollTo(null) }
  }, [scrollTo, rows, limit])

  const onTimeline = useCallback((key: Selection) => { select(key); reveal(key) }, [select, reveal])

  const span = useMemo(() => timeSpan(filtered, now), [filtered, now])
  const allTurnsFolded = filtered.length > 0 && filtered.every((turn) => !turnOpen(turn.turn))
  const allCallsFolded = filtered.some((turn) => turn.records.some((r) => r.kind === 'tool' && r.ops.length))
    && filtered.every((turn) => turn.records.every((r) => r.kind !== 'tool' || !r.ops.length || !callOpen(r)))

  const inspected = answer && selected ? inspectedOf(answer, selected, t) : null
  const handlers: RowHandlers = {
    t, now, selected, onSelect: select, onOpen,
    onToggleTurn: (turn, open) => setTurnOverride((m) => new Map(m).set(turn, open)),
    onToggleCall: (record, open) => setCallOverride((m) => new Map(m).set(record.seq, open)),
    onToggleContext: (turn, open) => setContextOpen((s) => { const n = new Set(s); if (open) n.add(turn); else n.delete(turn); return n }),
  }

  if (!answer && error) return <div className={views.frame}><ErrorState title={t('readFailed')} error={error} retryLabel={t('retry')} onRetry={reload} /></div>
  if (!answer) return <div className={views.frame}><Loading label={t('loading')} /></div>
  const empty = !turns.some((turn) => turn.records.length || turn.orphanCalls.length || turn.hostOps.length || turn.checkpoints.length)
  return (
    <div className={clsx(views.frame, css.frame)}>
      <div className={css.controlsCard}>
        <div className={css.toolbar} role="toolbar" aria-label={t('trajToolbar')}>
          <div className={css.actions}>
            <FoldToggle folded={allTurnsFolded} label={t('trajTurns')} expand={t('trajExpandTurns')} collapse={t('trajCollapseTurns')}
              onClick={() => { setTurnsDefault(allTurnsFolded ? 'all' : 'none'); setTurnOverride(new Map()) }} />
            {layerfs ? (
              <>
                <FoldToggle folded={allCallsFolded} label={t('trajLayerfsCalls')} expand={t('trajExpandCalls')} collapse={t('trajCollapseCalls')}
                  onClick={() => { setCallsDefault(allCallsFolded); setCallOverride(new Map()) }} />
                <button type="button" role="checkbox" aria-checked={onlyWrites} className={css.action} onClick={() => setOnlyWrites(!onlyWrites)}>
                  <IconDatabaseOutlineRegular size={14} className={css.actionIcon} /><span>{t('trajOnlyWrites')}</span>
                </button>
              </>
            ) : null}
          </div>

          <label className={css.search}>
            <IconSearchOutlineRegular size={13} className={css.searchIcon} />
            <input type="search" className={css.searchInput} placeholder={t('trajSearchPlaceholder')} aria-label={t('trajSearch')}
              value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
          </label>
        </div>
        {!answer.logLoaded ? <p className={clsx(css.note, css.frameNote)}>{t('trajNoLog')}</p> : null}
        <div className={css.timelineHead}>
          <h2>{t('trajTimeline')}</h2>
          <span className={css.counts}>
            {[
              layerfs ? t('trajCounts', { n: answer.counts.versionsCreated, m: answer.counts.callsWithVersions }) : null,
              span ? t('trajTotal', { duration: durationText(t, span.end - span.start) }) : null,
            ].filter(Boolean).join(' · ')}
          </span>
        </div>
        <TrajectoryTimeline turns={filtered} now={now} span={span} selected={selected} onSelect={onTimeline} t={t} layerfs={layerfs} />
      </div>
      <div className={css.body}>
        <div className={css.table} ref={scroller}>
          {empty ? <EmptyState title={t('trajEmpty')}>{t('trajEmptyBody')}</EmptyState>
            : !rows.length ? <EmptyState title={t('trajNoMatch')} />
            : (
              <>
                {rows.slice(0, limit).map((row) => <TableRow key={row.key} row={row} h={handlers} />)}
                {rows.length > limit ? (
                  <div className={css.more}>
                    <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + ROW_PAGE)}>{t('trajShowMore', { n: rows.length - limit })}</Button>
                  </div>
                ) : answer.hasMore && answer.olderBefore !== undefined ? (
                  <div className={css.more}>
                    <Button variant="outline" size="sm" onClick={loadOlder} disabled={olderBusy}>
                      {olderBusy ? t('loading') : t('trajShowOlder', { n: Math.max(0, (answer.recordTotal ?? loadedRecords(answer)) - loadedRecords(answer)) })}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
        </div>
        {inspected ? (
          <TrajectoryInspector api={api} sessionId={sessionId} inspected={inspected} tab={tab} onTab={setTab} layerfs={layerfs}
            onClose={() => setSelected(null)} onOpen={onOpen} cache={cache} diffs={diffs} t={t}
            onOpenLogs={(tag) => openLogs(api, { tag })} />
        ) : null}
      </div>
    </div>
  )
}
