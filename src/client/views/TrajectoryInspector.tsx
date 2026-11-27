/**
 * The LayerFS trajectory's inspector: the selected record in full (read on
 * demand through `session.trajectory.record`), with Summary, Payload, Result,
 * LayerFS and Timing tabs for a tool call. A record where the recorded prompt
 * changed also gets DSH's Diff tab (`session.trajectory.prompt-diff`), read
 * lazily when the tab opens.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { ErrorState, Loading } from '../files/States.tsx'
import { PREVIEW_MAX, TOOL_DESCRIPTION_MAX } from '../../shared/trajectory.ts'
import type { PromptDiffAnswer, ToolsChange, TraceCheckpoint, TraceOp, TraceVersion, TrajectoryDetail, TrajectoryRecord, TrajectoryTool } from '../../shared/trajectory.ts'
import { sessionTag } from '../../shared/logs.ts'
import type { Translate } from './locale.ts'
import { clock, durationText, KindCell, opOutcome, toolsDelta, Version, type OpenVersion } from './TrajectoryParts.tsx'
import { checkpointVersion, compactNumber, opCommand, prettyArgs, SAVES, toolEntries } from './trajectory-model.ts'
import css from './trajectory.module.css'
import { dateTime } from '../ui/locale-sync.ts'

/** What the inspector shows. */
export type Inspected =
  | { kind: 'record', turn: number, record: TrajectoryRecord }
  | { kind: 'checkpoint', turn: number, checkpoint: TraceCheckpoint }
  | { kind: 'ops', turn: number, title: string, ops: TraceOp[] }

type Tab = 'summary' | 'payload' | 'result' | 'layerfs' | 'tools' | 'diff' | 'timing'

/** Details read once per record and result: a running call's detail is read again once it ends. */
export type DetailCache = Map<string, TrajectoryDetail>
/** Prompt diffs read once per record: the host recomputes the line diff on demand. */
export type PromptDiffCache = Map<string, PromptDiffAnswer>

const detailKey = (sessionId: string, record: TrajectoryRecord) => `${sessionId}:${record.seq}:${record.kind === 'tool' ? record.resultSeq ?? '' : ''}`
const promptDiffKey = (sessionId: string, seq: number) => `${sessionId}:${seq}`

function useDetail(api: LayerfsApi, sessionId: string, record: TrajectoryRecord | null, cache: DetailCache) {
  const key = record ? detailKey(sessionId, record) : null
  const [state, setState] = useState<{ key: string | null, detail?: TrajectoryDetail, error?: unknown }>({ key: null })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!record || !key) return
    const hit = cache.get(key)
    if (hit) { setState({ key, detail: hit }); return }
    let live = true
    setState({ key })
    api.op<TrajectoryDetail>('session.trajectory.record', { sessionId, seq: record.seq }).then(
      (detail) => { cache.set(key, detail); if (live) setState({ key, detail }) },
      (error) => { if (live) setState({ key, error }) },
    )
    return () => { live = false }
    // The record object changes on every refresh; its key says when the detail does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionId, key, cache, tick])
  return { ...(state.key === key ? state : { key }), retry: () => setTick((n) => n + 1) }
}

/** The Diff tab's lazy read: only while it is open, kept in the per-session cache by session and seq. */
function usePromptDiff(api: LayerfsApi, sessionId: string, record: TrajectoryRecord | null, cache: PromptDiffCache, enabled: boolean) {
  const changed = record && (record.kind === 'system' || record.kind === 'request') ? record.promptChanged : undefined
  const key = enabled && changed && record ? promptDiffKey(sessionId, record.seq) : null
  const seq = record?.seq
  const [state, setState] = useState<{ key: string | null, diff?: PromptDiffAnswer, error?: unknown }>({ key: null })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (key === null || seq === undefined) return
    const hit = cache.get(key)
    if (hit) { setState({ key, diff: hit }); return }
    let live = true
    setState({ key })
    api.op<PromptDiffAnswer>('session.trajectory.prompt-diff', { sessionId, seq }).then(
      (diff) => { cache.set(key, diff); if (live) setState({ key, diff }) },
      (error) => { if (live) setState({ key, error }) },
    )
    return () => { live = false }
  }, [api, sessionId, key, seq, cache, tick])
  return { ...(state.key === key ? state : { key }), retry: () => setTick((n) => n + 1) }
}

/** One diff section: the stock unified hunks, `+`/`-`/space prefixes kept. */
function PromptDiffSectionView({ title, section }: { title: string, section: NonNullable<PromptDiffAnswer['system']> }): ReactNode {
  return (
    <section className={css.promptDiffSection}>
      <h3 className={css.promptDiffTitle}>{title}</h3>
      <pre className={css.promptDiff}>
        {section.lines.map((line, index) => (
          <span key={index} className={clsx(css.promptDiffLine, css[`diff_${line.kind}`])}>{line.text || ' '}{'\n'}</span>
        ))}
      </pre>
    </section>
  )
}

/** A record's prompt diff: system and/or tools sections, with a note when the host cut it. */
export function PromptDiffBody({ state, t }: { state: ReturnType<typeof usePromptDiff>, t: Translate }): ReactNode {
  if (state.error) return <ErrorState title={t('trajDiffFailed')} error={state.error} retryLabel={t('retry')} onRetry={state.retry} />
  if (!state.diff) return <Loading label={t('loading')} />
  const diff = state.diff
  return (
    <>
      <div className={css.promptDiffSections}>
        {diff.system ? PromptDiffSectionView({ title: t('trajDiffSystem'), section: diff.system }) : null}
        {diff.tools ? PromptDiffSectionView({ title: t('trajDiffTools'), section: diff.tools }) : null}
      </div>
      {diff.truncated ? <p className={css.note}>{t('trajDiffTruncated')}</p> : null}
    </>
  )
}

function Field({ label, children }: { label: string, children: ReactNode }): ReactNode {
  return <><dt className={css.fieldLabel}>{label}</dt><dd className={css.fieldValue}>{children}</dd></>
}

function Truncated({ detail, field, t }: { detail: TrajectoryDetail | undefined, field: 'args' | 'result' | 'text' | 'thinking' | 'header', t: Translate }): ReactNode {
  return detail?.truncated?.includes(field) ? <p className={css.note}>{t('trajTruncated')}</p> : null
}

/** A version with an explicit "Open in History" action. */
function VersionLine({ version, t, onOpen }: { version: TraceVersion, t: Translate, onOpen: OpenVersion }): ReactNode {
  return (
    <li className={css.versionLine}>
      <Version version={version} t={t} onOpen={onOpen} />
      <span className={css.muted}>{t(`trajEffect_${version.effect}`)}</span>
      {version.branch ? <span className={css.muted}>{t('trajBranch')} {version.branch}</span> : null}
      {version.effect === 'created' && version.branch && onOpen
        ? <Button variant="ghost" size="sm" className={css.openHistory} onClick={() => onOpen(version)}>{t('trajOpenInHistory')}</Button>
        : null}
    </li>
  )
}

/** A call's LayerFS calls, each with its outcome, time and versions (exported for its own test). */
export function OpsList({ ops, sessionId, t, onOpen, onOpenLogs }: {
  ops: readonly TraceOp[], sessionId: string, t: Translate, onOpen: OpenVersion
  /** Opens the Logs page filtered to this call's receipt tag; refused and failed calls offer it. */
  onOpenLogs?: ((tag: string) => void) | undefined
}): ReactNode {
  if (!ops.length) return <p className={css.note}>{t('trajNoLayerfs')}</p>
  return (
    <ol className={css.opsList}>
      {ops.map((op) => {
        const outcome = opOutcome(t, op)
        const failed = op.outcome !== 'success' || (op.exit ?? 0) !== 0
        return (
          <li key={op.id} className={css.opItem}>
            <code className={css.opCommand}>{opCommand(op)}</code>
            <span className={css.opMeta}>
              {outcome ? <span className={clsx(failed && css.refused)}>{outcome}</span> : null}
              {op.at ? <span>{clock(op.at)}</span> : null}
              {op.ms !== undefined ? <span>{durationText(t, op.ms)}</span> : null}
            </span>
            {failed && onOpenLogs
              ? <Button variant="ghost" size="sm" className={css.openHistory} onClick={() => onOpenLogs(sessionTag(sessionId, op.id))}>{t('trajOpenInLogs')}</Button>
              : null}
            {op.versions.length ? <ul className={css.versionList}>{op.versions.map((v) => <VersionLine key={`${v.effect}:${v.id}`} version={v} t={t} onOpen={onOpen} />)}</ul> : null}
          </li>
        )
      })}
    </ol>
  )
}

/** A tool's change mark's tint and its spoken label. */
function toolMark(mark: '+' | '−' | '~'): { className: string, label: string } {
  if (mark === '+') return { className: css.markAdded, label: 'trajToolAdded' }
  if (mark === '−') return { className: css.markRemoved, label: 'trajToolRemoved' }
  return { className: css.markChanged, label: 'trajToolChanged' }
}

/** One tool's parameter schema as readable pretty JSON, or a note when the header logged none. */
export function ToolSchema({ tool, t }: { tool: TrajectoryTool | undefined, t: Translate }): ReactNode {
  if (tool?.parameters === undefined) return <p className={css.note}>{t('trajToolNoSchema')}</p>
  return <pre className={css.pre}>{JSON.stringify(tool.parameters, null, 2)}</pre>
}

/**
 * The Tools tab's list: a request's tool catalog, each tool expandable to its
 * parameter schema, with `+`/`−`/`~` marks for what changed since the previous
 * request and a changed or removed tool's earlier description and schema when
 * the previous catalog was read.
 */
export function ToolsList({ tools, change, previous, truncated, t }: {
  tools: readonly TrajectoryTool[]
  change?: ToolsChange | undefined
  previous?: readonly TrajectoryTool[] | undefined
  /** The catalog was cut at the detail cap. */
  truncated?: boolean | undefined
  t: Translate
}): ReactNode {
  const entries = toolEntries(tools, change, previous)
  if (!entries.length) return <p className={css.note}>{t('trajToolsEmpty')}</p>
  return (
    <>
      <ul className={css.toolsList}>
        {entries.map((entry) => {
          const shown = entry.tool ?? entry.previous
          const mark = entry.mark ? toolMark(entry.mark) : null
          return (
            <li key={`${entry.mark ?? '='}:${entry.name}`} className={css.toolItem}>
              <details className={css.toolDetails}>
                <summary>
                  {mark
                    ? <span className={clsx(css.toolMark, mark.className)} title={t(mark.label)} aria-label={t(mark.label)}>{entry.mark}</span>
                    : <span className={css.toolMarkNone} aria-hidden="true" />}
                  <code className={css.toolName}>{entry.name}</code>
                  {shown?.parameterCount !== undefined ? <span className={css.toolMeta}>{t('trajToolParams', { n: shown.parameterCount })}</span> : null}
                  {shown?.description ? <span className={css.toolDescription}>{shown.description}</span> : null}
                </summary>
                {entry.mark === '−'
                  ? <p className={css.note}>{t('trajToolRemovedNote')}</p>
                  : ToolSchema({ tool: entry.tool, t })}
                {entry.tool?.descriptionTruncated ? <p className={css.note}>{t('trajToolDescriptionCut', { n: TOOL_DESCRIPTION_MAX })}</p> : null}
                {entry.previous ? (
                  <details className={css.toolPrevious}>
                    <summary>{t('trajToolsPrevious')}</summary>
                    {entry.previous.description ? <p className={css.toolPreviousDescription}>{entry.previous.description}</p> : null}
                    {ToolSchema({ tool: entry.previous, t })}
                  </details>
                ) : null}
              </details>
            </li>
          )
        })}
      </ul>
      {truncated ? <p className={css.note}>{t('trajToolsTruncated')}</p> : null}
    </>
  )
}

/** What the Tools tab needs to read the previous request's catalog on demand. */
export interface RequestToolsSource {
  api: LayerfsApi
  sessionId: string
  cache: DetailCache
}

/**
 * A request's Tools tab. The change marks come from the record preview; for a
 * changed or removed tool the previous catalog is read (once, kept in the same
 * detail cache) so its earlier description and schema can be shown.
 */
export function ToolsBody({ record, detail, source, t }: {
  record: Extract<TrajectoryRecord, { kind: 'request' }>
  detail: ReturnType<typeof useDetail>
  source: RequestToolsSource
  t: Translate
}): ReactNode {
  const change = record.toolsChanged
  const previousSeq = detail.detail?.previousRequestSeq
  const changed = !!change && (change.changed.length > 0 || change.removed.length > 0)
  const [previous, setPrevious] = useState<readonly TrajectoryTool[] | undefined>(undefined)
  useEffect(() => {
    setPrevious(undefined)
    if (!changed || previousSeq === undefined) return
    const key = `${source.sessionId}:${previousSeq}:`
    const hit = source.cache.get(key)
    if (hit) { setPrevious(hit.tools); return }
    let live = true
    source.api.op<TrajectoryDetail>('session.trajectory.record', { sessionId: source.sessionId, seq: previousSeq }).then(
      (found) => { source.cache.set(key, found); if (live) setPrevious(found.tools) },
      () => { /* the previous value stays unavailable */ },
    )
    return () => { live = false }
  }, [source.api, source.sessionId, source.cache, previousSeq, changed])
  if (!detail.detail) return <DetailState state={detail} t={t} />
  if (!detail.detail.tools) return <p className={css.note}>{t('trajToolsNotRecorded')}</p>
  return (
    <ToolsList tools={detail.detail.tools} change={change} previous={previous}
      truncated={detail.detail.truncated?.includes('tools')} t={t} />
  )
}

function Timing({ t, start, end, running }: { t: Translate, start: number | undefined, end?: number | undefined, running?: boolean }): ReactNode {
  const none = t('trajNotRecorded')
  return (
    <dl className={css.fields}>
      <Field label={t('trajStarted')}>{start ? dateTime(start) : none}</Field>
      {end !== undefined || running !== undefined ? <Field label={t('trajEnded')}>{end ? dateTime(end) : running ? t('trajStatusRunning') : none}</Field> : null}
      {start && end ? <Field label={t('trajDuration')}>{durationText(t, end - start)}</Field> : null}
    </dl>
  )
}

function DetailState({ state, t }: { state: ReturnType<typeof useDetail>, t: Translate }): ReactNode {
  if (state.error) return <ErrorState title={t('trajDetailFailed')} error={state.error} retryLabel={t('retry')} onRetry={state.retry} />
  if (!state.detail) return <Loading label={t('loading')} />
  return null
}

function ToolBody({ record, tab, detail, t, onOpen, layerfs, sessionId, onOpenLogs }: {
  record: Extract<TrajectoryRecord, { kind: 'tool' }>, tab: Tab, detail: ReturnType<typeof useDetail>, t: Translate, onOpen: OpenVersion, layerfs: boolean
  sessionId: string, onOpenLogs?: ((tag: string) => void) | undefined
}): ReactNode {
  const running = record.result === undefined && record.endedAt === undefined
  if (tab === 'payload') {
    return detail.detail
      ? <>{detail.detail.args ? <pre className={css.pre}>{prettyArgs(detail.detail.args)}</pre> : <p className={css.note}>{t('trajNoPayload')}</p>}<Truncated detail={detail.detail} field="args" t={t} /></>
      : <DetailState state={detail} t={t} />
  }
  if (tab === 'result') {
    if (running) return <p className={css.note}>{t('trajRunning')}</p>
    const text = detail.detail?.result ?? record.result
    return (
      <>
        {text ? <pre className={clsx(css.pre, record.isError && css.errorText)}>{text}</pre> : detail.detail ? <p className={css.note}>{t('trajNoOutput')}</p> : <DetailState state={detail} t={t} />}
        <Truncated detail={detail.detail} field="result" t={t} />
      </>
    )
  }
  if (tab === 'layerfs') {
    const older = record.opsTotal !== undefined ? record.opsTotal - record.ops.length : 0
    return (
      <>
        <OpsList ops={record.ops} sessionId={sessionId} t={t} onOpen={onOpen} onOpenLogs={onOpenLogs} />
        {older > 0 ? <p className={css.note}>{t('trajCallsNotLoaded', { n: older })}</p> : null}
      </>
    )
  }
  if (tab === 'timing') return <Timing t={t} start={record.at} end={record.endedAt} running={running} />
  const created = record.ops.flatMap((op) => op.versions)
  return (
    <dl className={css.fields}>
      <Field label={t('trajStatus')}>
        <span className={clsx(record.isError && css.errorText)}>{running ? t('trajStatusRunning') : record.isError ? t('trajStatusFailed') : t('trajStatusDone')}</span>
      </Field>
      <Field label={t('trajCallId')}><code className={css.mono}>{record.callId}</code></Field>
      {record.summary ? <Field label={t('trajTab_payload')}><code className={css.mono}>{record.summary}</code></Field> : null}
      {record.result ? <Field label={t('trajTab_result')}><span className={clsx(css.clamp, record.isError && css.errorText)}>{record.result}</span></Field> : null}
      {layerfs ? <Field label={t('trajLayerfsCalls')}>{record.opsTotal !== undefined ? `${record.ops.length} / ${record.opsTotal}` : record.ops.length}</Field> : null}
      {created.length ? <Field label={t('trajVersionsMade')}><ul className={css.versionList}>{created.map((v) => <VersionLine key={`${v.effect}:${v.id}`} version={v} t={t} onOpen={onOpen} />)}</ul></Field> : null}
    </dl>
  )
}

type MessageRecord = Extract<TrajectoryRecord, { kind: 'user' | 'context' | 'assistant' }>

function MessageBody({ record, tab, detail, t }: { record: MessageRecord, tab: Tab, detail: ReturnType<typeof useDetail>, t: Translate }): ReactNode {
  if (tab === 'timing') return record.kind === 'assistant' ? <Timing t={t} start={record.startedAt ?? record.at} end={record.at} /> : <Timing t={t} start={record.at} />
  const text = detail.detail?.text
  return (
    <>
      <dl className={css.fields}>
        {record.kind === 'context' ? <Field label={t('trajSource')}>{record.source}</Field> : null}
        {record.kind === 'assistant' ? <Field label={t('trajToolCalls')}>{record.toolCalls}</Field> : null}
        {record.kind === 'assistant' && record.interrupted ? <Field label={t('trajStatus')}>{t('trajInterrupted')}</Field> : null}
        {record.kind === 'assistant' && record.usage?.input !== undefined ? <Field label={t('trajUsageInput')}>{compactNumber(record.usage.input)}</Field> : null}
        {record.kind === 'assistant' && record.usage?.output !== undefined ? <Field label={t('trajUsageOutput')}>{compactNumber(record.usage.output)}</Field> : null}
        {record.kind === 'assistant' && record.usage?.cacheRead !== undefined ? <Field label={t('trajUsageCacheRead')}>{compactNumber(record.usage.cacheRead)}</Field> : null}
        {record.kind === 'assistant' && record.usage?.cacheWrite !== undefined ? <Field label={t('trajUsageCacheWrite')}>{compactNumber(record.usage.cacheWrite)}</Field> : null}
      </dl>
      {record.kind === 'assistant' && detail.detail?.thinking ? (
        <details className={css.thinking}>
          <summary>{t('trajThinking')}</summary>
          <pre className={css.pre}>{detail.detail.thinking}</pre>
          <Truncated detail={detail.detail} field="thinking" t={t} />
        </details>
      ) : null}
      {detail.detail
        ? text ? <pre className={clsx(css.pre, css.prose)}>{text}</pre> : <p className={css.note}>{record.kind === 'assistant' && record.toolCalls ? t('trajToolCallOnly') : t('trajNoText')}</p>
        : <DetailState state={detail} t={t} />}
      <Truncated detail={detail.detail} field="text" t={t} />
    </>
  )
}

export function SystemBody({ record, tab, detail, t }: {
  record: Extract<TrajectoryRecord, { kind: 'system' }>, tab: Tab, detail: ReturnType<typeof useDetail>, t: Translate
}): ReactNode {
  if (tab === 'timing') return <Timing t={t} start={record.at} />
  if (tab === 'payload') {
    return detail.detail
      ? <>{detail.detail.text ? <pre className={clsx(css.pre, css.prose)}>{detail.detail.text}</pre> : <p className={css.note}>{t('trajNoText')}</p>}<Truncated detail={detail.detail} field="text" t={t} /></>
      : <DetailState state={detail} t={t} />
  }
  return (
    <dl className={css.fields}>
      <Field label={t('trajSource')}>{record.source ?? t('trajNotRecorded')}</Field>
      <Field label={t('trajPreview')}>{record.truncated ? t('trajPreviewCut', { n: PREVIEW_MAX }) : t('trajPreviewWhole')}</Field>
    </dl>
  )
}

export function RequestBody({ record, tab, detail, t, tools }: {
  record: Extract<TrajectoryRecord, { kind: 'request' }>, tab: Tab, detail: ReturnType<typeof useDetail>, t: Translate
  /** The Tools tab's read side; without it the catalog shows without earlier values. */
  tools?: RequestToolsSource | undefined
}): ReactNode {
  if (tab === 'timing') return <Timing t={t} start={record.at} />
  if (tab === 'tools') {
    return tools
      ? <ToolsBody key={record.seq} record={record} detail={detail} source={tools} t={t} />
      : detail.detail
        ? <ToolsList tools={detail.detail.tools ?? []} change={record.toolsChanged} truncated={detail.detail.truncated?.includes('tools')} t={t} />
        : <DetailState state={detail} t={t} />
  }
  if (tab === 'payload') {
    return detail.detail
      ? <>{detail.detail.header ? <pre className={css.pre}>{detail.detail.header}</pre> : <p className={css.note}>{t('trajNoPayload')}</p>}<Truncated detail={detail.detail} field="header" t={t} /></>
      : <DetailState state={detail} t={t} />
  }
  return (
    <dl className={css.fields}>
      {record.provider ? <Field label={t('trajRequestProvider')}>{record.provider}</Field> : null}
      {record.model ? <Field label={t('trajRequestModel')}>{record.model}</Field> : null}
      <Field label={t('trajRequestTools')}>
        <span>{t('trajRequestToolsCount', { n: record.tools })}</span>
        {toolsDelta(record.toolsChanged, t)}
      </Field>
      {record.reason ? <Field label={t('trajRequestReason')}>{record.reason}</Field> : null}
    </dl>
  )
}

export function UnknownBody({ kind, t }: { kind: string, t: Translate }): ReactNode {
  return <p className={css.note}>{t('trajUnknownRecord')} ({kind})</p>
}

function RecordBody({ record, tab, detail, t, onOpen, layerfs, sessionId, onOpenLogs, tools, promptDiff }: {
  record: TrajectoryRecord, tab: Tab, detail: ReturnType<typeof useDetail>, t: Translate, onOpen: OpenVersion
  layerfs: boolean, sessionId: string, onOpenLogs?: ((tag: string) => void) | undefined
  tools?: RequestToolsSource | undefined
  promptDiff: ReturnType<typeof usePromptDiff>
}): ReactNode {
  if (tab === 'diff') return PromptDiffBody({ state: promptDiff, t })
  switch (record.kind) {
    case 'tool':
      return <ToolBody record={record} tab={tab} detail={detail} t={t} onOpen={onOpen} layerfs={layerfs} sessionId={sessionId} onOpenLogs={onOpenLogs} />
    case 'system':
      return <SystemBody record={record} tab={tab} detail={detail} t={t} />
    case 'request':
      return <RequestBody record={record} tab={tab} detail={detail} t={t} tools={tools} />
    case 'user':
    case 'context':
    case 'assistant':
      return <MessageBody record={record} tab={tab} detail={detail} t={t} />
    default:
      return <UnknownBody kind={String((record as { kind?: unknown }).kind ?? 'unknown')} t={t} />
  }
}

function CheckpointBody({ checkpoint, tab, t, onOpen, sessionId, onOpenLogs }: {
  checkpoint: TraceCheckpoint, tab: Tab, t: Translate, onOpen: OpenVersion, sessionId: string
  onOpenLogs?: ((tag: string) => void) | undefined
}): ReactNode {
  if (tab === 'layerfs') return <OpsList ops={checkpoint.op ? [checkpoint.op] : []} sessionId={sessionId} t={t} onOpen={onOpen} onOpenLogs={onOpenLogs} />
  if (tab === 'timing') return <Timing t={t} start={checkpoint.op?.at ?? checkpoint.at} end={checkpoint.op?.at !== undefined && checkpoint.op.ms !== undefined ? checkpoint.op.at + checkpoint.op.ms : undefined} />
  const version = checkpointVersion(checkpoint)
  return (
    <dl className={css.fields}>
      <Field label={t('trajMessage')}>{checkpoint.message}</Field>
      {checkpoint.error
        ? <Field label={t('trajStatus')}><span className={css.warnText}>{t('trajFailed', { code: checkpoint.error.code })} {checkpoint.error.message}</span></Field>
        : SAVES.has(checkpoint.kind) ? <Field label={t('trajStatus')}>{checkpoint.changed > 0 ? t('trajChanged', { n: checkpoint.changed }) : t('trajUnchanged')}</Field> : null}
      {checkpoint.branch ? <Field label={t('trajBranch')}>{checkpoint.branch}</Field> : null}
      {version ? <Field label={t('trajVersion')}><ul className={css.versionList}><VersionLine version={version} t={t} onOpen={onOpen} /></ul></Field> : null}
    </dl>
  )
}

const TOOL_TABS: Tab[] = ['summary', 'payload', 'result', 'layerfs', 'timing']
const MESSAGE_TABS: Tab[] = ['summary', 'timing']
/** A system record: the summary, its full payload and when it was logged. */
const PARITY_TABS: Tab[] = ['summary', 'payload', 'timing']
/** A request record: also its parsed tool catalog and what changed in it. */
const REQUEST_TABS: Tab[] = ['summary', 'payload', 'tools', 'timing']

export function TrajectoryInspector({ api, sessionId, inspected, tab, onTab, onClose, onOpen, onOpenLogs, cache, diffs, t, layerfs = true }: {
  api: LayerfsApi
  sessionId: string
  inspected: Inspected
  tab: Tab
  onTab: (tab: Tab) => void
  onClose: () => void
  onOpen: OpenVersion
  /** Opens the Logs page filtered to one call's receipt tag (a refused call's "check Logs"). */
  onOpenLogs?: ((tag: string) => void) | undefined
  cache: DetailCache
  /** Prompt diffs read by the Diff tab; the caller keeps them across tab switches. */
  diffs?: PromptDiffCache | undefined
  t: Translate
  /** A project session: tool calls get the LayerFS tab. */
  layerfs?: boolean
}): ReactNode {
  const record = inspected.kind === 'record' ? inspected.record : null
  const diffTab = !!record && (record.kind === 'system' || record.kind === 'request') && !!record.promptChanged && record.previousSeq !== undefined
  const withDiff = (base: Tab[]): Tab[] => diffTab ? ['diff', ...base] : base
  const tabs: Tab[] = record
    ? record.kind === 'tool' ? (layerfs ? TOOL_TABS : TOOL_TABS.filter((x) => x !== 'layerfs'))
      : record.kind === 'system' ? withDiff(PARITY_TABS)
        : record.kind === 'request' ? withDiff(REQUEST_TABS) : MESSAGE_TABS
    : inspected.kind === 'checkpoint' ? (inspected.checkpoint.op ? ['summary', 'layerfs', 'timing'] : MESSAGE_TABS) : ['layerfs']
  const current = tabs.includes(tab) ? tab : tabs[0]!
  // The diff tab needs no record detail: do not read one just to show it.
  const detail = useDetail(api, sessionId, current === 'diff' ? null : record, cache)
  const localDiffs = useRef<PromptDiffCache>(new Map()).current
  const diffCache = diffs ?? localDiffs
  const promptDiff = usePromptDiff(api, sessionId, record, diffCache, current === 'diff')
  const uid = useId()
  const kind = record ? record.kind : inspected.kind === 'checkpoint' ? 'checkpoint' : 'layerfs'
  const where = [
    inspected.turn > 0 ? t('trajTurn', { n: inspected.turn }) : t('trajBeforeTurns'),
    record?.step !== undefined ? t('trajStep', { n: record.step }) : null,
    record?.kind === 'tool' ? record.name
      : record?.kind === 'system' ? record.source ?? t('trajKind_system')
      : record?.kind === 'request' ? record.model ?? record.provider ?? t('trajKind_request')
      : inspected.kind === 'checkpoint' ? t('trajCheckpoint', { kind: t(`trajCp_${inspected.checkpoint.kind}`) })
      : inspected.kind === 'ops' ? inspected.title : null,
  ].filter(Boolean).join(' · ')
  const tabId = (value: Tab) => `${uid}-tab-${value}`
  // A phone's tab row scrolls sideways: keep the selected tab in sight when it
  // opens, when the tab changes and when the drawer resizes.
  const tabRow = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const row = tabRow.current
    const el = row?.querySelector<HTMLElement>(`[data-tab="${current}"]`)
    if (!row || !el) return
    const reveal = () => {
      const r = el.getBoundingClientRect(), box = row.getBoundingClientRect()
      const left = r.left - box.left + row.scrollLeft
      const right = left + r.width
      if (left < row.scrollLeft) row.scrollLeft = Math.max(0, left - 8)
      else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth + 8
    }
    reveal()
    window.addEventListener('resize', reveal)
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(reveal) : null
    if (watch) watch.observe(row)
    return () => { window.removeEventListener('resize', reveal); watch?.disconnect() }
  }, [current, tabs.length])
  /** Arrow keys move between tabs (the WAI-ARIA tabs pattern). */
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = tabs[(tabs.indexOf(current) + step + tabs.length) % tabs.length]!
    onTab(next)
    document.getElementById(tabId(next))?.focus()
  }
  return (
    <aside className={css.inspector} aria-label={t('trajDetails')}>
      <header className={css.inspectorHead}>
        <KindCell kind={kind} t={t} />
        <span className={css.inspectorTitle} title={where}>{where}</span>
        <Button variant="ghost" size="sm" icon={<IconCloseOutlineRegular size={14} />} aria-label={t('trajClose')} title={t('trajClose')} onClick={onClose} />
      </header>
      {tabs.length > 1 ? (
        <div className={css.tabs} role="tablist" aria-label={t('trajDetails')} onKeyDown={onTabKey} ref={tabRow}>
          {tabs.map((value) => (
            <button key={value} type="button" role="tab" id={tabId(value)} data-tab={value} className={css.tab} aria-selected={value === current}
              aria-controls={`${uid}-panel`} tabIndex={value === current ? 0 : -1} onClick={() => onTab(value)}>
              {t(`trajTab_${value}`)}
            </button>
          ))}
        </div>
      ) : null}
      <div id={`${uid}-panel`} role={tabs.length > 1 ? 'tabpanel' : undefined} aria-labelledby={tabs.length > 1 ? tabId(current) : undefined} className={css.inspectorBody}>
        {record ? <RecordBody record={record} tab={current} detail={detail} t={t} onOpen={onOpen} layerfs={layerfs} sessionId={sessionId} onOpenLogs={onOpenLogs} tools={{ api, sessionId, cache }} promptDiff={promptDiff} />
          : inspected.kind === 'checkpoint' ? <CheckpointBody checkpoint={inspected.checkpoint} tab={current} t={t} onOpen={onOpen} sessionId={sessionId} onOpenLogs={onOpenLogs} />
          : inspected.kind === 'ops' ? <OpsList ops={inspected.ops} sessionId={sessionId} t={t} onOpen={onOpen} onOpenLogs={onOpenLogs} /> : null}
      </div>
    </aside>
  )
}

export type { Tab as InspectorTab }
