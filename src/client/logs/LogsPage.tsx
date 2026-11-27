/**
 * The Logs page: the LayerFS call log (`logs.list`), newest first, with
 * filters, a "More" row for older pages, and Reset behind a confirm.
 * Reloads on the host's `logs` event, on reconnection and on window focus
 * (the native log is written by other processes too), coalesced and only
 * while the page is visible; a filtered scan (Only writes, a project search)
 * rereads only what was logged since its last scan. A filter can arrive
 * from outside through `openLogs` (a checkpoint's Calls). A row opens the
 * call's detail (click or Enter; ↑/↓ move between rows).
 */
import { usePageReading } from '../storage/PaneBar.tsx'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, Checkbox, IconCloseOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, Input, SegmentedControl, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import {
  LOGS_EVENT, operationOf, parseTag,
  type CallLabel, type LabeledLine, type LogsListAnswer, type LogsResetAnswer,
} from '../../shared/logs.ts'
import { Card, ConfirmDialog, Empty, LinkButton, LoadError, Loading, MenuSelect, Page, PageHead, Refusal, type RefusalLabels } from '../ui/index.tsx'
import { CallDetail } from './CallDetail.tsx'
import { argsOf, DEFAULT_FILTERS, emptyAction, refreshDelay, scansLog, SINCE_SKEW_MS, type ClientChoice, type Filters, type OutcomeChoice } from './filters.ts'
import { CommandCell } from './Command.tsx'
import { shortId } from '../files/format.ts'
import { clockTime, dateTime } from '../ui/locale-sync.ts'
import { absoluteTime, commandParts, duration, kindWords } from './format.ts'
import type { LogsT } from './locale.ts'
import { openLogs, onLogsRequest, peekLogsRequest, takeLogsRequest, type LogsRequest } from './request.ts'
import { sessionParts } from './session-words.ts'
import css from './logs.module.css'

/** A pre-filtered open shows exactly the tagged calls: every other filter is cleared. */
const fromRequest = (request: LogsRequest): Filters => ({ ...DEFAULT_FILTERS, writes: false, tag: request.tag })

interface Loaded {
  lines: LabeledLine[]
  next?: string | undefined
  hasMore: boolean
  /** The filtered scan stopped at its page budget; `hasMore` is "not proven empty", not a match. */
  partial: boolean
  skipped: number
  source: LogsListAnswer['source']
  /** Pages appended through More; a background reload keeps them. */
  pages: number
}

const lineKey = (line: LabeledLine) => `${line.at}|${line.tag ?? ''}|${line.argv.join('\u0000')}`
const merge = (a: readonly LabeledLine[], b: readonly LabeledLine[]) => [...new Map([...a, ...b].map((line) => [lineKey(line), line])).values()]
/** A saved id as LayerFS labels it short (its tag kept: a prefix `commit get` accepts); the full id is the tip. */
const shortHex = (id: string | undefined) => id ? shortId(id) : ''

function refusalLabels(t: LogsT): RefusalLabels {
  return {
    category: (kind) => kind === 'usage' ? t('refusalUsage') : kind === 'unavailable' ? t('refusalUnavailable') : kind === 'unknown' ? t('refusalUnknown') : t('refusalRefusal'),
    inTheWay: t('inTheWay'),
    kind: (kind) => kind.charAt(0).toUpperCase() + kind.slice(1),
    phase: (phase) => t('phase', { phase }),
    operation: (op) => t('operation', { op }),
  }
}

export function LogsPage({ api, t, refreshKey = 0 }: { refreshKey?: number, api: LayerfsApi, t: LogsT }): ReactNode {
  const [filters, setFilters] = useState<Filters>(() => { const r = peekLogsRequest(); return r ? fromRequest(r) : DEFAULT_FILTERS })
  const [search, setSearch] = useState(filters.project)
  const [data, setData] = useState<Loaded>()
  const [error, setError] = useState<unknown>()
  const [loading, setLoading] = useState(true)
  usePageReading(loading)
  const [more, setMore] = useState(false)
  const [ops, setOps] = useState<ReadonlySet<string>>(() => new Set())
  const [confirming, setConfirming] = useState(false)
  const [removed, setRemoved] = useState<number>()
  const [now, setNow] = useState(() => Date.now())
  /** The row whose detail is open, by key (it survives reloads that keep the line). */
  const [detail, setDetail] = useState<string>()
  const tbody = useRef<HTMLTableSectionElement>(null)
  const generation = useRef(0)
  const current = useRef({ filters, data })
  current.current = { filters, data }

  /**
   * The log changed (new lines, a reset) or may have (focus, a reconnection):
   * the whole-log emptiness learned before it is stale. Bumped once per refresh,
   * not per event.
   */
  const versionRef = useRef(0)
  const [logVersion, setLogVersion] = useState(0)
  const bumpVersion = useCallback(() => { versionRef.current++; setLogVersion(versionRef.current) }, [])
  /**
   * Whether the whole log is empty, and the log version it was learned at:
   * known from an unfiltered read, a scan's newest-line read, else asked with a
   * one-line probe when a filtered read shows nothing. `value` is undefined while unknown.
   */
  const [logEmpty, setLogEmpty] = useState<{ value: boolean | undefined, version: number }>({ value: undefined, version: -1 })
  /** The log version the emptiness was last asked at (one probe per version, a failed one included). */
  const askedEmpty = useRef(-1)
  const learnEmpty = useCallback((version: number, value: boolean | undefined) => {
    askedEmpty.current = Math.max(askedEmpty.current, version)
    // An answer about an older log never overwrites one about the current log.
    if (version === versionRef.current) setLogEmpty({ value, version })
  }, [])
  /** What the last full or incremental scan covered: its filters and the log's newest line just before it. */
  const scanned = useRef<{ args: string, newest: string, at: number | undefined } | null>(null)

  /** `replace` starts over; `refresh` keeps appended pages and puts new lines on top. */
  // A refresh never cancels a read in flight, or a page slower than its window
  // would never land: it queues one more read.
  const inFlight = useRef(false)
  const queued = useRef(false)
  const load = useCallback(async (mode: 'replace' | 'refresh'): Promise<void> => {
    if (mode === 'refresh' && inFlight.current) { queued.current = true; return }
    if (mode === 'replace') queued.current = false
    inFlight.current = true
    const mine = ++generation.current
    const { filters: f, data: before } = current.current
    const version = versionRef.current
    setLoading(true)
    try {
      const args = argsOf(f)
      const argsKey = JSON.stringify(args)
      let since: number | undefined
      let seen: typeof scanned.current = null
      if (scansLog(f)) {
        // A scan reads up to FILTER_BUDGET native pages. First the log's newest
        // line (one line): it says whether the log is empty, and a refresh with
        // nothing logged since the last scan has nothing new that could match.
        const probe = await api.op<LogsListAnswer>('logs.list', { limit: 1 })
        if (mine !== generation.current) return
        learnEmpty(version, probe.lines.length === 0 && !probe.has_more)
        const newest = probe.lines[0]
        seen = { args: argsKey, newest: newest ? lineKey(newest) : '', at: newest?.at }
        const last = scanned.current
        if (mode === 'refresh' && before && last?.args === argsKey) {
          if (last.newest === seen.newest) { setError(undefined); return }
          // Only what was logged since the last scan's newest line.
          if (last.at !== undefined) since = last.at - SINCE_SKEW_MS
        }
      }
      let answer = await api.op<LogsListAnswer>('logs.list', since === undefined ? args : { ...args, since })
      if (mine !== generation.current) return
      if (since !== undefined && answer.has_more) {
        // More new matches than one page: a fresh first page, so More continues from it.
        since = undefined
        answer = await api.op<LogsListAnswer>('logs.list', args)
        if (mine !== generation.current) return
      }
      if (since !== undefined && before) {
        // The new lines go on top of what is shown; its pages and cursor stay.
        setData({ ...before, lines: merge(answer.lines, before.lines), source: answer.source })
      } else {
        const keep = mode === 'refresh' && before && before.pages > 1
        setData({
          lines: keep ? merge(answer.lines, before.lines) : answer.lines,
          next: keep ? before.next : answer.next,
          hasMore: keep ? before.hasMore : answer.has_more,
          partial: keep ? before.partial : answer.partial === true,
          skipped: answer.skipped,
          source: answer.source,
          pages: keep ? before.pages : 1,
        })
      }
      if (seen) scanned.current = seen
      setError(undefined)
      setNow(Date.now())
    } catch (e) {
      if (mine === generation.current) setError(e)
    } finally {
      if (mine === generation.current) {
        inFlight.current = false
        if (queued.current) { queued.current = false; void load('refresh') }
        else setLoading(false)
      }
    }
  }, [api, learnEmpty])

  /**
   * One refresh per window of events (`refreshDelay`: 500 ms, 3 s for a scan),
   * and none while the page is hidden: a hidden page refreshes once when it shows again.
   */
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const missed = useRef(false)
  const requestRefresh = useCallback(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { missed.current = true; return }
    if (refreshTimer.current !== undefined) return
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined
      bumpVersion()
      void load('refresh')
    }, refreshDelay(current.current.filters))
  }, [load, bumpVersion])
  useEffect(() => () => { clearTimeout(refreshTimer.current); refreshTimer.current = undefined }, [])

  const loadMore = async () => {
    const before = current.current.data
    if (!before?.next || more) return
    const mine = generation.current
    setMore(true)
    try {
      const answer = await api.op<LogsListAnswer>('logs.list', { ...argsOf(current.current.filters), cursor: before.next })
      // A reload or filter change since makes this page stale.
      if (mine !== generation.current) return
      setData({ lines: merge(before.lines, answer.lines), next: answer.next, hasMore: answer.has_more, partial: answer.partial === true, skipped: before.skipped + answer.skipped, source: answer.source, pages: before.pages + 1 })
    } catch (e) {
      if (mine === generation.current) setError(e)
    } finally { setMore(false) }
  }

  useEffect(() => { void load('replace') }, [load, filters])
  const lastRefresh = useRef(refreshKey)
  useEffect(() => {
    if (lastRefresh.current !== refreshKey) { lastRefresh.current = refreshKey; bumpVersion(); void load('refresh') }
  }, [load, refreshKey, bumpVersion])
  // The search box settles before it filters.
  useEffect(() => {
    if (search === filters.project) return
    const id = setTimeout(() => setFilters((f) => ({ ...f, project: search })), 300)
    return () => clearTimeout(id)
  }, [search, filters.project])
  useEffect(() => {
    const refresh = () => { requestRefresh() }
    const shown = () => { if (document.visibilityState !== 'hidden' && missed.current) { missed.current = false; requestRefresh() } }
    // The request this page opened with was read in the first render; it is consumed now.
    takeLogsRequest()
    const offs = [
      api.onEvent(LOGS_EVENT, refresh),
      api.onEvent('connection', (e) => { if ((e.data as { connected?: boolean } | undefined)?.connected) refresh() }),
      onLogsRequest(() => { const r = takeLogsRequest(); if (r) { setFilters(fromRequest(r)); setSearch('') } }),
    ]
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', shown)
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      for (const off of offs) off()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', shown)
      clearInterval(tick)
    }
  }, [api, requestRefresh])
  // Op choices come from what has been seen, so they stay while an op is chosen.
  useEffect(() => {
    if (!data) return
    setOps((seen) => {
      const next = new Set(seen)
      for (const line of data.lines) { next.add(line.argv[0] ?? ''); next.add(operationOf(line.argv)) }
      next.delete('')
      return next.size === seen.size ? seen : next
    })
  }, [data])

  const shown = useMemo(() => (data?.lines ?? []).filter((line) => filters.outcome !== 'refused' || line.outcome !== 'ok'), [data, filters.outcome])
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }))
  const detailIndex = detail === undefined ? -1 : shown.findIndex((line) => lineKey(line) === detail)
  const detailLine = detailIndex >= 0 ? shown[detailIndex] : undefined
  const labels = useMemo(() => refusalLabels(t), [t])
  /** Back on the table after the detail closes or moves: focus the row it showed. */
  const focusRow = (key: string | undefined) => {
    if (key === undefined) return
    requestAnimationFrame(() => {
      const row = [...(tbody.current?.querySelectorAll<HTMLElement>('tr[data-key]') ?? [])].find((el) => el.dataset.key === key)
      row?.focus({ preventScroll: false })
    })
  }
  // A detail whose line is gone (a filter change, Reset) closes instead of reopening later.
  useEffect(() => { if (detail !== undefined && data && detailIndex < 0) setDetail(undefined) }, [detail, data, detailIndex])
  const closeDetail = () => { const key = detail; setDetail(undefined); focusRow(key) }
  // Arrow keys move focus between rows.
  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, key: string) => {
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(key); return }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const row = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling
    if (row instanceof HTMLElement) { e.preventDefault(); row.focus() }
  }
  /** Filters other than Writes only (and the tag, which has its own empty state). */
  const filtered = filters.project.trim() !== '' || filters.op !== 'all' || filters.client !== 'all' || filters.outcome !== 'all'
  useEffect(() => {
    if (!data) return
    const args = argsOf(filters)
    const unfiltered = Object.keys(args).every((k) => k === 'limit') && filters.outcome === 'all'
    const stale = logEmpty.version !== logVersion
    const action = emptyAction({ lines: data.lines.length, hasMore: data.hasMore, unfiltered, tag: !!filters.tag, known: logEmpty.value, stale })
    if (action === 'nonempty' || action === 'empty') {
      const value = action === 'empty'
      if (stale || logEmpty.value !== value) learnEmpty(logVersion, value)
      return
    }
    if (action !== 'probe' || askedEmpty.current >= logVersion) return
    const version = logVersion
    askedEmpty.current = version
    // The answer is about the log at this version: it is kept even when the view moved on.
    api.op<LogsListAnswer>('logs.list', { limit: 1 })
      .then((answer) => learnEmpty(version, answer.lines.length === 0 && !answer.has_more))
      .catch(() => learnEmpty(version, undefined))
  }, [api, data, filters, logEmpty, logVersion, learnEmpty])

  const reset = async () => {
    const answer = await api.op<LogsResetAnswer>('logs.reset', {})
    setRemoved(answer.removed)
    bumpVersion()
    await load('replace')
  }

  const opOptions = useMemo(() => [
    { value: 'all', label: t('opAll') },
    ...[...ops].sort().map((op) => ({ value: op, label: op })),
  ], [ops, t])

  return (
    <Page wide label={t('title')}>
      <PageHead title={t('title')}
        actions={(
          <>
            <Button variant="ghost" size="sm" className={css.headerAction} icon={<IconRefreshOutlineRegular size={14} />} disabled={loading} onClick={() => { void load('replace') }}>{t('refresh')}</Button>
            <Button variant="outline" size="sm" className={css.headerAction} disabled={!data || logEmpty.value === true} onClick={() => setConfirming(true)}>{t('reset')}</Button>
          </>
        )} />
      {removed !== undefined && <p className={css.note} role="status">{t('resetDone', { n: removed })}</p>}

      <div className={css.filters} role="group" aria-label={t('filters')}>
        <Input className={css.search} icon={<IconSearchOutlineRegular size={14} />} placeholder={t('searchProject')} aria-label={t('searchProject')}
          value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && search) { e.preventDefault(); setSearch('') } }} />
        <MenuSelect value={filters.op} label={t('op')} options={opOptions} onChange={(op) => set({ op })} className={css.opSelect} />
        <SegmentedControl<ClientChoice> id="lfs-logs-client" value={filters.client} label={t('client')} onChange={(client) => set({ client })}
          options={[{ value: 'all', label: t('clientAll') }, { value: 'cli', label: 'Cli' }, { value: 'node', label: 'Node' }, { value: 'python', label: 'Python' }, { value: 'rust', label: 'Rust' }]} />
        <SegmentedControl<OutcomeChoice> id="lfs-logs-outcome" value={filters.outcome} label={t('outcome')} onChange={(outcome) => set({ outcome })}
          options={[{ value: 'all', label: t('outcomeAll') }, { value: 'ok', label: t('outcomeOk') }, { value: 'refused', label: t('outcomeRefused') }]} />
        <Checkbox checked={filters.writes} onChange={(writes) => set({ writes })} label={t('writesOnly')} />
        {filters.tag && <TagChip t={t} tag={filters.tag} onClear={() => set({ tag: undefined })} />}
      </div>

      {error !== undefined && !data && <LoadError title={t('loadFailed')} error={error} labels={refusalLabels(t)} retryLabel={t('retry')} onRetry={() => { void load('replace') }} />}
      {error !== undefined && data && <Refusal error={error} labels={refusalLabels(t)} compact />}
      {!data && loading && error === undefined && <Loading label={t('loading')} />}
      {data && (shown.length === 0 && !data.hasMore ? (
        filters.tag ? <Empty title={t('emptyTag')}>{t('emptyTagBody')}</Empty>
          : filtered ? <Empty title={t('emptyFiltered')}>{t('emptyFilteredBody')}</Empty>
            : filters.writes && logEmpty.value !== true ? (
              <Empty title={t('emptyWrites')}>
                {t('emptyWritesBody')} <LinkButton onClick={() => set({ writes: false })}>{t('showReads')}</LinkButton>
              </Empty>
            ) : <Empty title={t('empty')}>{t('emptyBody')}</Empty>
      ) : (
        <Card className={css.tableCard}>
          <table role="table" className={css.table} aria-busy={loading || more} aria-label={t('tableLabel')}>
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" className={css.wTime}>{t('colTime')}</th>
                <th role="columnheader" className={css.wClient}>{t('colClient')}</th>
                <th role="columnheader">{t('colCommand')}</th>
                <th role="columnheader" className={css.wOutcome}>{t('colOutcome')}</th>
                <th role="columnheader" className={clsx(css.wMs, css.num)}>{t('colMs')}</th>
                <th role="columnheader" className={css.wSaved}>{t('colSaved')}</th>
                <th role="columnheader" className={css.wSession}>{t('colSession')}</th>
              </tr>
            </thead>
            <tbody role="rowgroup" ref={tbody}>
              {shown.map((line) => {
                const key = lineKey(line)
                return <Row key={key} rowKey={key} api={api} t={t} line={line} now={now} detailOpen={detail !== undefined}
                  onOpen={() => setDetail(key)} onKeyDown={(e) => onRowKey(e, key)} />
              })}
            </tbody>
          </table>
          <div className={css.moreRow}>
            {data.partial && <p className={css.note} role="status">{t('partialScan')}</p>}
            {data.next && data.hasMore
              ? <Button variant="outline" size="sm" disabled={more} aria-busy={more} onClick={() => { void loadMore() }}>{more ? t('loadingMore') : t('more')}</Button>
              : <p className={css.note}>{t('allLoaded')}</p>}
            {data.skipped > 0 && <p className={css.note}>{t('skipped', { n: data.skipped })}</p>}
          </div>
        </Card>
      ))}

      <CallDetail api={api} t={t} line={detailLine} labels={labels} onClose={closeDetail}
        onCalls={(tag) => { setDetail(undefined); openLogs(api, { tag }) }}
        nav={{
          index: detailIndex,
          total: shown.length,
          prev: detailIndex > 0 ? () => setDetail(lineKey(shown[detailIndex - 1]!)) : undefined,
          next: detailIndex >= 0 && detailIndex < shown.length - 1 ? () => setDetail(lineKey(shown[detailIndex + 1]!)) : undefined,
        }} />

      {confirming ? (
        <ConfirmDialog
          onClose={() => setConfirming(false)}
          title={t('confirmReset')}
          body={t(data?.source === 'layerfs' ? 'confirmResetLayerfs' : 'confirmResetPlugin')}
          action={t('resetAction')}
          labels={{ cancel: t('cancel'), close: t('close'), refusal: labels }}
          run={reset}
        />
      ) : null}
    </Page>
  )
}

/** The outside filter, removable. */
/** What a tag filter holds, in words: one call, a session (its id without DSH's `session-` prefix), else the tag. */
export function tagWords(tag: string, t: LogsT): string {
  const parsed = parseTag(tag)
  return parsed ? t('tagCall', { id: parsed.receiptId.slice(0, 8) })
    : tag.startsWith('dsh:') && tag.endsWith(':') ? t('tagSession', { id: tag.slice(4, -1).replace(/^session-/, '').slice(0, 12) }) : tag
}

function TagChip({ t, tag, onClear }: { t: LogsT, tag: string, onClear: () => void }): ReactNode {
  const what = tagWords(tag, t)
  return (
    <span className={css.chip} title={tag}>
      <span className={css.chipLabel}>{t('tagFilter', { what })}</span>
      <button type="button" className={css.chipClear} aria-label={t('clearTag')} title={t('clearTag')} onClick={onClear}>
        <IconCloseOutlineRegular size={12} />
      </button>
    </span>
  )
}

function when(at: number, now: number, t: LogsT): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return t('justNow')
  if (s < 3600) return t('minutesAgo', { n: Math.max(1, Math.round(s / 60)) })
  if (s < 6 * 3600) return t('hoursAgo', { n: Math.round(s / 3600) })
  const date = new Date(at)
  const today = new Date(now).toDateString() === date.toDateString()
  return today ? clockTime(date, { timeStyle: 'short' }) : dateTime(date, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Clicks on the row's own controls, or ending a text selection, do not open the detail. */
function opensDetail(e: MouseEvent<HTMLTableRowElement>): boolean {
  if ((e.target as HTMLElement).closest('button, a, input, [role=tooltip]')) return false
  const selection = window.getSelection()
  return !(selection && !selection.isCollapsed && e.currentTarget.contains(selection.anchorNode))
}

function Row({ api, t, line, now, rowKey, detailOpen, onOpen, onKeyDown }: {
  api: LayerfsApi
  t: LogsT
  line: LabeledLine
  now: number
  rowKey: string
  detailOpen: boolean
  onOpen: () => void
  onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => void
}): ReactNode {
  const parts = commandParts(line.argv)
  const ok = line.outcome === 'ok'
  const version = line.commit ?? line.layer
  const [focused, setFocused] = useState(false)
  const popoverId = useId()
  return (
    <tr role="row" className={css.row} tabIndex={0} data-key={rowKey} aria-describedby={focused ? popoverId : undefined}
      onClick={(e) => { if (opensDetail(e)) onOpen() }} onKeyDown={onKeyDown}
      onFocus={(e) => { if (e.target === e.currentTarget && e.currentTarget.matches(':focus-visible')) setFocused(true) }}
      onBlur={(e) => { if (e.target === e.currentTarget) setFocused(false) }}>
      <td role="cell">
        <Tooltip label={absoluteTime(line.at)} side="top" portal delayMs={400}>
          <span className={css.time}>{when(line.at, now, t)}</span>
        </Tooltip>
      </td>
      <td role="cell" className={clsx(css.muted, css.wClient)}>{line.client}</td>
      <td role="cell" className={css.commandCell}><CommandCell parts={parts} focusOpen={focused} popoverId={popoverId} disabled={detailOpen} /></td>
      <td role="cell" title={ok ? undefined : line.outcome}>{ok ? <span className={css.ok}>{t('outcomeOk')}</span> : <Tag tone="danger" className={css.codeTag}>{line.outcome}</Tag>}</td>
      <td role="cell" className={clsx(css.num, css.duration)}>{duration(line.ms, t)}</td>
      <td role="cell" className={clsx(css.saved, css.wSaved)}>
        {version ? <>{line.kind && <span className={css.kind} title={line.kind}>{kindWords(line.kind, t)}</span>}<code className={css.hex} title={version}>{shortHex(version)}</code></> : <span className={css.muted}>—</span>}
      </td>
      <td role="cell">{line.dsh ? <SessionLabel api={api} t={t} label={line.dsh} /> : <span className={css.muted}>—</span>}</td>
    </tr>
  )
}

/** Which session, turn and checkpoint a line belongs to; the name opens the session. */
function SessionLabel({ api, t, label }: { api: LayerfsApi, t: LogsT, label: CallLabel }): ReactNode {
  const name = label.title?.trim() || label.sessionId.slice(0, 8)
  const parts = sessionParts(label, t)
  return (
    <span className={css.sessionLabel}>
      <LinkButton className={css.sessionName} title={t('openSession', { name: label.title?.trim() || label.sessionId })} onClick={() => api.openSession(label.sessionId)}>{name}</LinkButton>
      {parts.length > 0 && <span className={css.muted}>{parts.join(' · ')}</span>}
    </span>
  )
}
