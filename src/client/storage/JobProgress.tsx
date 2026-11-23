/** A Storage job on its Store: what it does, its step, bytes and a bar; how it ended, with Retry and Dismiss. */
import { useContext, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import type { StorageT } from './locale.ts'
import { doingWords, endedWords, holderTab, jobEnd, jobPercent, kindWords, movePushFailed, placeWords, stepsOf, stepWords } from './model.ts'
import type { StorageJob, StoreRow } from './types.ts'
import { FixAction, FixContext, resolveFix } from '../ui/index.tsx'
import { refusalLabels } from './parts.tsx'
import { useMachinesMaybe, type MachinesContext } from '../machines/context.tsx'
import type { MachineSandbox as Sandbox } from '../machines/model.ts'
import css from './Storage.module.css'

type JobPanelProps = { job: StorageJob, t: StorageT, compact?: boolean, onRetry?: (() => void) | undefined, onDismiss?: (() => void) | undefined }

/** A job on its Store; where the page knows the Sandboxes (the Machines context), an in-use refusal names what holds the Store. */
export function JobPanel(props: JobPanelProps): ReactNode {
  const mc = useMachinesMaybe()
  return mc ? <FleetJobPanel {...props} mc={mc} /> : <JobPanelView {...props} sandboxes={[]} />
}

function FleetJobPanel({ mc, ...props }: JobPanelProps & { mc: MachinesContext }): ReactNode {
  const sandboxes = mc.useMachines((s) => (s.data?.available ? s.data.sandboxes : NONE))
  return <JobPanelView {...props} sandboxes={sandboxes} onOpen={mc.openStorageTab} />
}

const NONE: readonly Sandbox[] = []

function JobPanelView({ job: j, t, compact, onRetry, onDismiss, sandboxes, onOpen }: JobPanelProps & { sandboxes: readonly Sandbox[], onOpen?: (id: string) => void }): ReactNode {
  const fixes = useContext(FixContext)
  const running = !j.ended
  const failed = !!j.ended && (!!j.error || j.outcome === 'failed' || j.outcome === 'unknown' || j.outcome === 'interrupted')
  const steps = stepsOf(j)
  const at = Math.max(0, steps.findIndex((s) => s.state === 'now' || s.state === 'failed')) + 1
  const pct = jobPercent(j)
  const stepText = j.kind === 'move'
    ? t(j.half === 'push' ? 'jobMovePushStep' : 'jobMovePullStep', { at, of: steps.length, step: stepWords(j.phase, t) })
    : t('jobStep', { at, of: steps.length, step: stepWords(j.phase, t) })
  const bytesText = j.total ? t('jobBytes', { done: bytes(j.done ?? 0), total: bytes(j.total) }) : null
  // the same tip and one action as Home's notice (UI pass 3 F10): the fix where the page runs it, else Open <holder> while in use, else Retry
  const { holders: [holder], tip } = jobEnd(j, sandboxes, t, fixes ? (line) => fixes.tip(line) : undefined)
  const resolved = failed && fixes ? resolveFix(fixes, j.error?.fix) : null
  const pushOnlyRetry = movePushFailed(j)
  const action = !failed ? null
    : resolved?.fix && fixes ? <FixAction line={resolved.line} fix={resolved.fix} runner={fixes} labels={refusalLabels(t)} />
      : holder && onOpen ? <Button variant="outline" size="sm" onClick={() => onOpen(holderTab(holder))}>{t('jobOpenSandbox', { name: holder.name })}</Button>
        : onRetry ? (
          <Button variant="outline" size="sm" title={pushOnlyRetry ? t('jobRetryPushTip', { place: placeWords(j.target, t) }) : undefined} onClick={onRetry}>
            {t(pushOnlyRetry ? 'jobRetryPush' : 'jobRetry')}
          </Button>
        ) : null
  const label = running ? doingWords(j, t) : endedWords(j, t, bytes)
  return (
    <div className={css.job} data-state={running ? 'running' : failed ? 'failed' : 'done'} data-compact={compact || undefined} role="status">
      <div className={css.jobLine}>
        <StateDot state={running ? 'ongoing' : failed ? 'error' : 'done'} size={running ? 13 : 10} />
        {/* how it ended is the word; what holds the Store, LayerFS's code, words and fix are its tip (UI pass 3 F10: no raw refusal under it) */}
        <span className={css.jobTitle} title={tip ?? (compact ? label : undefined)}>{label}</span>
        {running && !compact ? <span className={css.jobMeta}>{stepText}</span> : null}
        {running && !compact && bytesText ? <span className={css.jobMeta}>{bytesText}</span> : null}
        <span className={css.jobEnd}>
          {running ? <span className={css.jobPct}>{`${pct}%`}</span> : null}
          {action}
          {!running && onDismiss ? <Button variant="ghost" size="sm" onClick={onDismiss}>{t('dismiss')}</Button> : null}
        </span>
      </div>
      {running && compact ? (
        <div className={css.jobCompactMeta} title={[stepText, bytesText].filter(Boolean).join(' · ')}>
          <span>{stepText}</span>
          {bytesText ? <span>{bytesText}</span> : null}
        </div>
      ) : null}
      {running ? <span className={css.jobBar}><span className={css.jobFill} style={{ width: `${pct}%` }} /></span> : null}
    </div>
  )
}

/** An operation another client runs on the Store (store.list's `op`). */
export function OpPanel({ store, t, compact }: { store: StoreRow, t: StorageT, compact?: boolean }): ReactNode {
  if (!store.op) return null
  const label = t('opRunning', { op: `${store.op.name} · ${store.op.phase}` })
  return (
    <div className={css.job} data-state="running" data-compact={compact || undefined} role="status">
      <div className={css.jobLine}>
        <StateDot state="ongoing" size={compact ? 11 : 13} />
        <span className={css.jobTitle} title={label}>{label}</span>
      </div>
    </div>
  )
}

/** This session's jobs on a Store, newest first. */
export function JobList({ jobs, t, now }: { jobs: readonly StorageJob[], t: StorageT, now: number }): ReactNode {
  return (
    <ul className={css.rows}>
      {jobs.map((j) => (
        <li key={j.id} className={css.row}>
          <StateDot state={!j.ended ? 'ongoing' : j.error ? 'error' : 'done'} size={!j.ended ? 13 : 10} />
          <span className={css.rowMain}>
            <span className={css.rowTitle}>{j.ended ? endedWords(j, t, bytes) : doingWords(j, t)}</span>
            <span className={css.rowSub}>{kindWords(j.kind, t)} {j.target} · {ago(j.ended ?? j.started, now, t as Translate)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}
