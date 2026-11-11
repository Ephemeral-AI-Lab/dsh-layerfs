/** A Storage job on its Store: what it does, its step, bytes and a bar; how it ended, with Retry and Dismiss. */
import type { ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import type { StorageT } from './locale.ts'
import { doingWords, endedWords, kindWords, shareOf, stepsOf, stepWords } from './model.ts'
import type { StorageJob, StoreRow } from './types.ts'
import css from './Storage.module.css'

export function JobPanel({ job: j, t, onRetry, onDismiss }: { job: StorageJob, t: StorageT, onRetry?: (() => void) | undefined, onDismiss?: (() => void) | undefined }): ReactNode {
  const running = !j.ended
  const failed = !!j.ended && (!!j.error || j.outcome === 'failed' || j.outcome === 'unknown' || j.outcome === 'interrupted')
  const steps = stepsOf(j)
  const at = Math.max(0, steps.findIndex((s) => s.state === 'now' || s.state === 'failed')) + 1
  return (
    <div className={css.job} data-state={running ? 'running' : failed ? 'failed' : 'done'} role="status">
      <div className={css.jobLine}>
        <StateDot state={running ? 'ongoing' : failed ? 'error' : 'done'} size={running ? 13 : 10} />
        <span className={css.jobTitle}>{running ? doingWords(j, t) : endedWords(j, t)}</span>
        {running ? <span className={css.jobMeta}>{t('jobStep', { at, of: steps.length, step: stepWords(j.phase, t) })}</span> : null}
        {running && j.total ? <span className={css.jobMeta}>{t('jobBytes', { done: bytes(j.done ?? 0), total: bytes(j.total) })}</span> : null}
        <span className={css.jobEnd}>
          {failed && onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>{t('jobRetry')}</Button> : null}
          {!running && onDismiss ? <Button variant="ghost" size="sm" onClick={onDismiss}>{t('dismiss')}</Button> : null}
        </span>
      </div>
      {running ? <span className={css.jobBar}><span className={css.jobFill} style={{ width: `${Math.round(shareOf(j) * 100)}%` }} /></span> : null}
      {j.error ? <p className={css.jobError}><code>{j.error.code}</code> {j.error.message}</p> : null}
    </div>
  )
}

/** An operation another client runs on the Store (store.list's `op`). */
export function OpPanel({ store, t }: { store: StoreRow, t: StorageT }): ReactNode {
  if (!store.op) return null
  return (
    <div className={css.job} data-state="running" role="status">
      <div className={css.jobLine}>
        <StateDot state="ongoing" size={13} />
        <span className={css.jobTitle}>{t('opRunning', { op: `${store.op.name} · ${store.op.phase}` })}</span>
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
            <span className={css.rowTitle}>{j.ended ? endedWords(j, t) : doingWords(j, t)}</span>
            <span className={css.rowSub}>{kindWords(j.kind, t)} {j.target} · {ago(j.ended ?? j.started, now, t as Translate)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}
