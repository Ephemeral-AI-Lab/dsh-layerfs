/** Small pieces the LayerFS trajectory's table and inspector share: kind pills, version chips, LayerFS call lines, times. */
import { Fragment, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { shortId } from '../files/format.ts'
import type { ToolsChange, TraceOp, TraceVersion, TrajectoryAnswer, TrajectoryRecord, TrajectoryUsage } from '../../shared/trajectory.ts'
import type { Translate } from './locale.ts'
import { compactNumber, durationParts, olderRecords, opCommand, totalRecords } from './trajectory-model.ts'
import css from './trajectory.module.css'
import { clockTime } from '../ui/locale-sync.ts'

export type OpenVersion = ((v: TraceVersion) => void) | undefined

/** A local clock time, or empty without one. */
export const clock = (at: number | undefined): string =>
  at ? clockTime(at, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''

/** A duration in the reader's words. */
export function durationText(t: Translate, ms: number): string {
  const d = durationParts(ms)
  return d.unit === 'ms' ? t('dur_ms', { n: d.n }) : d.unit === 's' ? t('dur_s', { n: d.n }) : t('dur_m', { m: d.m, s: d.s })
}

/** A step's usage compactly, `in 1.2k · out 340`; empty when neither count was reported. */
export function usageText(t: Translate, usage: TrajectoryUsage): string {
  const parts: string[] = []
  if (usage.input !== undefined) parts.push(t('trajUsageIn', { n: compactNumber(usage.input) }))
  if (usage.output !== undefined) parts.push(t('trajUsageOut', { n: compactNumber(usage.output) }))
  return parts.join(' · ')
}

const MARK: Record<TraceVersion['effect'], string> = { created: '+', unchanged: '=', referenced: '→' }

/**
 * How a request's tool catalog changed since the previous one: `+2 −1 ~1`,
 * in the reader's words, or nothing when it did not change. A plain function,
 * not a component: the row and the Summary call it directly.
 */
export function toolsDelta(change: ToolsChange | undefined, t: Translate): ReactNode {
  if (!change) return null
  const parts: { key: 'added' | 'removed' | 'changed', text: string }[] = []
  if (change.added.length) parts.push({ key: 'added', text: t('trajToolsAdded', { n: change.added.length }) })
  if (change.removed.length) parts.push({ key: 'removed', text: t('trajToolsRemoved', { n: change.removed.length }) })
  if (change.changed.length) parts.push({ key: 'changed', text: t('trajToolsChanged', { n: change.changed.length }) })
  if (!parts.length) return null
  return (
    <span className={css.toolsDelta}>
      {parts.map((part, i) => (
        <Fragment key={part.key}>
          {i ? ' ' : null}
          <span className={css[`delta_${part.key}`]}>{part.text}</span>
        </Fragment>
      ))}
    </span>
  )
}

/** The words a version's tooltip and accessible name use. */
export function versionTitle(t: Translate, version: TraceVersion): string {
  const effect = t(`trajEffect_${version.effect}`)
  const id = shortId(version.id)
  return version.branch ? t('trajVersionTitle', { effect, id, branch: version.branch }) : t('trajVersionNoBranch', { effect, id })
}

/** One saved version: `+` created, `=` unchanged, `→` referenced; opens History at it when its branch is known. */
export function Version({ version, t, onOpen }: { version: TraceVersion, t: Translate, onOpen: OpenVersion }): ReactNode {
  const title = versionTitle(t, version)
  return (
    <button type="button" className={clsx(css.version, css[version.effect])} title={`${title}\n${version.id}`} aria-label={title}
      disabled={!version.branch || !onOpen} onClick={(e) => { e.stopPropagation(); onOpen?.(version) }}>
      {MARK[version.effect]} {shortId(version.id)}
    </button>
  )
}

export function Versions({ versions, t, onOpen }: { versions: readonly TraceVersion[], t: Translate, onOpen: OpenVersion }): ReactNode {
  if (!versions.length) return null
  return <span className={css.versions}>{versions.map((v) => <Version key={`${v.effect}:${v.id}`} version={v} t={t} onOpen={onOpen} />)}</span>
}

/** A LayerFS call's outcome: exit code, result kind or refusal. */
export function opOutcome(t: Translate, op: TraceOp): string {
  if (op.outcome === 'refusal') return t('trajRefused', { code: op.code ?? '?' })
  if (op.outcome === 'unknown') return t('trajUnknownOutcome')
  if (op.exit !== undefined && op.exit !== null) return t('trajExit', { code: op.exit })
  return op.kind ?? ''
}

/** One LayerFS call on one line: the CLI words, its outcome and versions. */
export function OpLine({ op, t, onOpen, className }: { op: TraceOp, t: Translate, onOpen: OpenVersion, className?: string }): ReactNode {
  const command = opCommand(op)
  const outcome = opOutcome(t, op)
  return (
    <span className={clsx(css.opLine, className)}>
      <span className={css.command} title={command}>{command}</span>
      {outcome ? <span className={clsx(css.outcome, (op.outcome !== 'success' || (op.exit ?? 0) !== 0) && css.refused)}>{outcome}</span> : null}
      <Versions versions={op.versions} t={t} onOpen={onOpen} />
    </span>
  )
}

/** A record's kind as DSH's tinted pill (the inspector header uses it too). */
export function KindCell({ kind, t }: { kind: TrajectoryRecord['kind'] | 'checkpoint' | 'layerfs', t: Translate }): ReactNode {
  return <span className={clsx(css.kind, css[`kind_${kind}`])}>{t(`trajKind_${kind}`)}</span>
}

/**
 * The table's older-records affordance: a plain function, not a component, so
 * the view's tree carries its button (and the mini hook runtime can find it).
 * A windowed answer (a cold first page of a long session) says how many records
 * its window holds and offers the whole log; its window numbers are never shown
 * as session totals. A whole answer keeps "Load older records (n not loaded)".
 */
export function OlderFooter({ answer, busy, t, onLoadOlder }: {
  answer: TrajectoryAnswer
  busy: boolean
  t: Translate
  onLoadOlder: () => void
}): ReactNode {
  if (answer.windowed) {
    return (
      <div className={css.more}>
        <span className={css.note}>{t('trajWindowRecords', { n: totalRecords(answer) })}</span>
        <span className={css.note} aria-hidden="true">·</span>
        <Button variant="outline" size="sm" onClick={onLoadOlder} disabled={busy}>
          {busy ? t('loading') : t('trajLoadFullHistory')}
        </Button>
      </div>
    )
  }
  return (
    <div className={css.more}>
      <Button variant="outline" size="sm" onClick={onLoadOlder} disabled={busy}>
        {busy ? t('loading') : t('trajShowOlder', { n: olderRecords(answer) })}
      </Button>
    </div>
  )
}
