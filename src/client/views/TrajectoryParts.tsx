/** Small pieces the LayerFS trajectory's table and inspector share: kind pills, version chips, LayerFS call lines, times. */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { shortId } from '../files/format.ts'
import type { TraceOp, TraceVersion, TrajectoryRecord } from '../../shared/trajectory.ts'
import type { Translate } from './locale.ts'
import { durationParts, opCommand } from './trajectory-model.ts'
import css from './trajectory.module.css'

export type OpenVersion = ((v: TraceVersion) => void) | undefined

/** A local clock time, or empty without one. */
export const clock = (at: number | undefined): string =>
  at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''

/** A duration in the reader's words. */
export function durationText(t: Translate, ms: number): string {
  const d = durationParts(ms)
  return d.unit === 'ms' ? t('dur_ms', { n: d.n }) : d.unit === 's' ? t('dur_s', { n: d.n }) : t('dur_m', { m: d.m, s: d.s })
}

const MARK: Record<TraceVersion['effect'], string> = { created: '+', unchanged: '=', referenced: '→' }

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
    <button type="button" className={clsx(css.version, css[version.effect])} title={title} aria-label={title}
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
