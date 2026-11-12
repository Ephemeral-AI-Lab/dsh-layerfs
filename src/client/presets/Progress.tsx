/**
 * A preset job's progress: its real stage, completed/total counts from the
 * host (never a time estimate), per-project task counts and Mixed workspace
 * coverage. Unknown totals show an indeterminate segment.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { IconCheckOutlineRegular, IconWarningOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PresetJob, PresetProgress as Progress } from '../../shared/presets.ts'
import type { PresetsT } from './locale.ts'
import css from './presets.module.css'

export const count = (value: number): string => value.toLocaleString()

/** `m:ss` from `start` to `end` (or now). */
export function elapsed(start: number | undefined, end: number | undefined, now: number): string {
  if (!start) return ''
  const seconds = Math.max(0, Math.floor(((end ?? now) - start) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The current time, ticking each second while `live`. */
export function useClock(live: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])
  return now
}

const STAGE_KEYS = { checking: 'stageChecking', resetting: 'stageResetting', building: 'stageBuilding', verifying: 'stageVerifying' } as const

/** `layerfs sandbox close demo-x` reads as `Closing sandbox demo-x`; other labels pass through. */
function readable(value: string): string {
  const match = /^(?:Completed: )?layerfs (workspace|sandbox|store|machine) (\w+) ([^ ]+)/.exec(value)
  if (!match) return value
  const [, family, operation, name] = match
  const verb = { unmount: 'Unmounting', close: 'Closing', remove: 'Removing', disconnect: 'Disconnecting', stop: 'Stopping', start: 'Starting' }[operation!] ?? operation
  return `${verb} ${family} ${name}`
}

export function PresetProgress({ job, t }: { job: PresetJob, t: PresetsT }): ReactNode {
  const running = job.state === 'queued' || job.state === 'running'
  const complete = job.state === 'completed'
  const now = useClock(running)
  const stages = job.rebuild ? ['checking', 'resetting', 'building', 'verifying'] as const : ['checking', 'resetting', 'verifying'] as const
  const progress: Progress | undefined = job.progress
  const tasks = progress?.tasks ?? []
  const of = (state: string) => tasks.filter((task) => task.state === state).length
  const summary = tasks.length
    ? t('projectSummary', { running: of('running'), done: of('completed'), total: tasks.length })
      + (of('failed') ? t('projectFailed', { n: of('failed') }) : '')
      + (of('stopped') ? t('projectStopped', { n: of('stopped') }) : '')
      + (job.started ? t('elapsedSuffix', { time: elapsed(job.started, job.ended, now) }) : '')
    : null
  const stage = progress?.stage ?? 'checking'
  const index = Math.max(0, stages.findIndex((value) => value === stage))
  const known = progress?.total != null && progress.total >= 0
  const fraction = complete ? 1 : known ? (progress!.total === 0 ? 1 : Math.min(1, progress!.completed / progress!.total!)) : 0
  const label = complete ? t(job.rebuild ? 'buildComplete' : job.command === 'machine-stop' ? 'resetComplete' : 'legacyResetComplete') : readable(progress?.label ?? job.phase)
  const unit = progress?.historyTotal != null ? t('unitCommands') : stage === 'verifying' && tasks.length ? t('unitProjects') : t('unitSteps')
  const coverage = progress?.workspaceCoverage
  return (
    <div className={css.progress} aria-live="polite">
      <div className={css.progressHead}>
        {running ? <StateDot state="ongoing" /> : complete ? <IconCheckOutlineRegular size={14} className={css.ok} /> : <IconWarningOutlineRegular size={14} className={css.bad} />}
        <span className={css.progressLabel}>{label}</span>
        {running && known && <span className={css.progressCount}>{t('stepsCount', { done: count(progress!.historyCompleted ?? progress!.completed), total: count(progress!.historyTotal ?? progress!.total!), unit })}</span>}
      </div>
      {summary && <p className={css.progressNote}>{summary}</p>}
      {coverage && <p className={css.progressNote}>{t('workspaceCoverage', { done: count(coverage.completed), required: count(coverage.required), share: coverage.total ? (100 * coverage.completed / coverage.total).toFixed(1) : '0' })}</p>}
      {!complete && (
        <>
          <div className={css.rail} role="progressbar" aria-label={t('stagesLabel')} aria-valuemin={0} aria-valuemax={stages.length} aria-valuenow={known ? index + fraction : undefined}
            aria-valuetext={`${t(job.command === 'machine-stop' && stage === 'resetting' ? 'stageStopping' : STAGE_KEYS[stage])}${known ? `, ${progress!.completed} / ${progress!.total}` : ''}`}>
            {stages.map((value, step) => (
              <span key={value} className={css.segment} data-indeterminate={(step === index && running && !known) || undefined}>
                <span style={{ width: step < index ? '100%' : step === index ? `${fraction * 100}%` : '0%' }} />
              </span>
            ))}
          </div>
          <div className={css.stages}>{stages.map((value, step) => <span key={value} data-current={step === index || undefined}>{t(job.command === 'machine-stop' && value === 'resetting' ? 'stageStopping' : STAGE_KEYS[value])}</span>)}</div>
        </>
      )}
      {!running && !complete && <p className={css.error}>{job.error?.message ?? job.phase}</p>}
    </div>
  )
}
