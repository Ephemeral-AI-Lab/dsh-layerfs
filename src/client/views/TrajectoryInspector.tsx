/**
 * The LayerFS trajectory's inspector: the selected record in full (read on
 * demand through `session.trajectory.record`), with Summary, Payload, Result,
 * LayerFS and Timing tabs for a tool call.
 */
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { ErrorState, Loading } from '../files/States.tsx'
import type { TraceCheckpoint, TraceOp, TraceVersion, TrajectoryDetail, TrajectoryRecord } from '../../shared/trajectory.ts'
import type { Translate } from './locale.ts'
import { clock, durationText, KindCell, opOutcome, Version, type OpenVersion } from './TrajectoryParts.tsx'
import { checkpointVersion, opCommand, prettyArgs, SAVES } from './trajectory-model.ts'
import css from './trajectory.module.css'

/** What the inspector shows. */
export type Inspected =
  | { kind: 'record', turn: number, record: TrajectoryRecord }
  | { kind: 'checkpoint', turn: number, checkpoint: TraceCheckpoint }
  | { kind: 'ops', turn: number, title: string, ops: TraceOp[] }

type Tab = 'summary' | 'payload' | 'result' | 'layerfs' | 'timing'

/** Details read once per record and result: a running call's detail is read again once it ends. */
export type DetailCache = Map<string, TrajectoryDetail>

const detailKey = (sessionId: string, record: TrajectoryRecord) => `${sessionId}:${record.seq}:${record.kind === 'tool' ? record.resultSeq ?? '' : ''}`

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

function Field({ label, children }: { label: string, children: ReactNode }): ReactNode {
  return <><dt className={css.fieldLabel}>{label}</dt><dd className={css.fieldValue}>{children}</dd></>
}

function Truncated({ detail, field, t }: { detail: TrajectoryDetail | undefined, field: 'args' | 'result' | 'text' | 'thinking', t: Translate }): ReactNode {
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

/** A call's LayerFS calls, each with its outcome, time and versions. */
function OpsList({ ops, t, onOpen }: { ops: readonly TraceOp[], t: Translate, onOpen: OpenVersion }): ReactNode {
  if (!ops.length) return <p className={css.note}>{t('trajNoLayerfs')}</p>
  return (
    <ol className={css.opsList}>
      {ops.map((op) => {
        const outcome = opOutcome(t, op)
        return (
          <li key={op.id} className={css.opItem}>
            <code className={css.opCommand}>{opCommand(op)}</code>
            <span className={css.opMeta}>
              {outcome ? <span className={clsx(op.outcome !== 'success' && css.refused)}>{outcome}</span> : null}
              {op.at ? <span>{clock(op.at)}</span> : null}
              {op.ms !== undefined ? <span>{durationText(t, op.ms)}</span> : null}
            </span>
            {op.versions.length ? <ul className={css.versionList}>{op.versions.map((v) => <VersionLine key={`${v.effect}:${v.id}`} version={v} t={t} onOpen={onOpen} />)}</ul> : null}
          </li>
        )
      })}
    </ol>
  )
}

function Timing({ t, start, end, running }: { t: Translate, start: number | undefined, end?: number | undefined, running?: boolean }): ReactNode {
  const none = t('trajNotRecorded')
  return (
    <dl className={css.fields}>
      <Field label={t('trajStarted')}>{start ? new Date(start).toLocaleString() : none}</Field>
      {end !== undefined || running !== undefined ? <Field label={t('trajEnded')}>{end ? new Date(end).toLocaleString() : running ? t('trajStatusRunning') : none}</Field> : null}
      {start && end ? <Field label={t('trajDuration')}>{durationText(t, end - start)}</Field> : null}
    </dl>
  )
}

function DetailState({ state, t }: { state: ReturnType<typeof useDetail>, t: Translate }): ReactNode {
  if (state.error) return <ErrorState title={t('trajDetailFailed')} error={state.error} retryLabel={t('retry')} onRetry={state.retry} />
  if (!state.detail) return <Loading label={t('loading')} />
  return null
}

function ToolBody({ record, tab, detail, t, onOpen, layerfs }: { record: Extract<TrajectoryRecord, { kind: 'tool' }>, tab: Tab, detail: ReturnType<typeof useDetail>, t: Translate, onOpen: OpenVersion, layerfs: boolean }): ReactNode {
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
  if (tab === 'layerfs') return <OpsList ops={record.ops} t={t} onOpen={onOpen} />
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
      {layerfs ? <Field label={t('trajLayerfsCalls')}>{record.ops.length}</Field> : null}
      {created.length ? <Field label={t('trajVersionsMade')}><ul className={css.versionList}>{created.map((v) => <VersionLine key={`${v.effect}:${v.id}`} version={v} t={t} onOpen={onOpen} />)}</ul></Field> : null}
    </dl>
  )
}

function MessageBody({ record, tab, detail, t }: { record: Exclude<TrajectoryRecord, { kind: 'tool' }>, tab: Tab, detail: ReturnType<typeof useDetail>, t: Translate }): ReactNode {
  if (tab === 'timing') return record.kind === 'assistant' ? <Timing t={t} start={record.startedAt ?? record.at} end={record.at} /> : <Timing t={t} start={record.at} />
  const text = detail.detail?.text
  return (
    <>
      <dl className={css.fields}>
        {record.kind === 'context' ? <Field label={t('trajSource')}>{record.source}</Field> : null}
        {record.kind === 'assistant' ? <Field label={t('trajToolCalls')}>{record.toolCalls}</Field> : null}
        {record.kind === 'assistant' && record.interrupted ? <Field label={t('trajStatus')}>{t('trajInterrupted')}</Field> : null}
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

function CheckpointBody({ checkpoint, tab, t, onOpen }: { checkpoint: TraceCheckpoint, tab: Tab, t: Translate, onOpen: OpenVersion }): ReactNode {
  if (tab === 'layerfs') return <OpsList ops={checkpoint.op ? [checkpoint.op] : []} t={t} onOpen={onOpen} />
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

export function TrajectoryInspector({ api, sessionId, inspected, tab, onTab, onClose, onOpen, cache, t, layerfs = true }: {
  api: LayerfsApi
  sessionId: string
  inspected: Inspected
  tab: Tab
  onTab: (tab: Tab) => void
  onClose: () => void
  onOpen: OpenVersion
  cache: DetailCache
  t: Translate
  /** A project session: tool calls get the LayerFS tab. */
  layerfs?: boolean
}): ReactNode {
  const record = inspected.kind === 'record' ? inspected.record : null
  const detail = useDetail(api, sessionId, record, cache)
  const uid = useId()
  const tabs: Tab[] = record ? (record.kind === 'tool' ? (layerfs ? TOOL_TABS : TOOL_TABS.filter((x) => x !== 'layerfs')) : MESSAGE_TABS)
    : inspected.kind === 'checkpoint' ? (inspected.checkpoint.op ? ['summary', 'layerfs', 'timing'] : MESSAGE_TABS) : ['layerfs']
  const current = tabs.includes(tab) ? tab : tabs[0]!
  const kind = record ? record.kind : inspected.kind === 'checkpoint' ? 'checkpoint' : 'layerfs'
  const where = [
    inspected.turn > 0 ? t('trajTurn', { n: inspected.turn }) : t('trajBeforeTurns'),
    record?.step !== undefined ? t('trajStep', { n: record.step }) : null,
    record?.kind === 'tool' ? record.name
      : inspected.kind === 'checkpoint' ? t('trajCheckpoint', { kind: t(`trajCp_${inspected.checkpoint.kind}`) })
      : inspected.kind === 'ops' ? inspected.title : null,
  ].filter(Boolean).join(' · ')
  const tabId = (value: Tab) => `${uid}-tab-${value}`
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
        <div className={css.tabs} role="tablist" aria-label={t('trajDetails')} onKeyDown={onTabKey}>
          {tabs.map((value) => (
            <button key={value} type="button" role="tab" id={tabId(value)} className={css.tab} aria-selected={value === current}
              aria-controls={`${uid}-panel`} tabIndex={value === current ? 0 : -1} onClick={() => onTab(value)}>
              {t(`trajTab_${value}`)}
            </button>
          ))}
        </div>
      ) : null}
      <div id={`${uid}-panel`} role={tabs.length > 1 ? 'tabpanel' : undefined} aria-labelledby={tabs.length > 1 ? tabId(current) : undefined} className={css.inspectorBody}>
        {record?.kind === 'tool' ? <ToolBody record={record} tab={current} detail={detail} t={t} onOpen={onOpen} layerfs={layerfs} />
          : record ? <MessageBody record={record} tab={current} detail={detail} t={t} />
          : inspected.kind === 'checkpoint' ? <CheckpointBody checkpoint={inspected.checkpoint} tab={current} t={t} onOpen={onOpen} />
          : inspected.kind === 'ops' ? <OpsList ops={inspected.ops} t={t} onOpen={onOpen} /> : null}
      </div>
    </aside>
  )
}

export type { Tab as InspectorTab }
