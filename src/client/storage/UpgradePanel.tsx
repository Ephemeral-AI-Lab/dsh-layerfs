/**
 * A Store upgrade on its Store (LayerFS #804 §10): while it runs, a phase
 * stepper with the elapsed time and Cancel (Stopping… once asked; disabled at
 * `commit` with the tip "finishing, can't cancel"); when it ends, one signal
 * and its tip: Upgraded green, Cancelled neutral, Failed red with LayerFS's
 * words (which name the check), Unknown or Interrupted amber with Check
 * (`store get --with format`), which then reads Upgraded or Outdated.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { StatusDot } from '../ui/StatusDot.tsx'
import type { StorageT } from './locale.ts'
import { doingWords, elapsedWords, stepsOf, stepWords, upgradeEnd, upgradeFinishing } from './model.ts'
import { Signal } from './Signal.tsx'
import type { StorageJob } from './types.ts'
import css from './Storage.module.css'
import own from './UpgradePanel.module.css'

export interface UpgradePanelProps {
  job: StorageJob
  t: StorageT
  compact?: boolean | undefined
  /** Cancel: the host sends SIGTERM to the CLI; its reply decides. */
  onStop?: (() => Promise<unknown> | void) | undefined
  /** Check after an unknown end: the host reads the Store's format. */
  onCheck?: (() => Promise<unknown> | void) | undefined
  onRetry?: (() => void) | undefined
  onDismiss?: (() => void) | undefined
}

export function UpgradePanel(props: UpgradePanelProps): ReactNode {
  return props.job.ended ? <UpgradeEnded {...props} /> : <UpgradeRunning {...props} />
}

function UpgradeRunning({ job: j, t, compact, onStop }: UpgradePanelProps): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const steps = stepsOf(j)
  const finishing = upgradeFinishing(j)
  const stopping = !!j.stopping || asking
  const elapsed = t('upgradeElapsed', { time: elapsedWords(now - j.started) })
  const stop = () => {
    if (!onStop || stopping || finishing) return
    setAsking(true)
    void Promise.resolve(onStop()).catch(() => {}).finally(() => setAsking(false))
  }
  return (
    <div className={css.job} data-state="running" data-compact={compact || undefined} data-upgrade="running" role="status">
      <div className={css.jobLine}>
        <StatusDot state="ongoing" size={compact ? 11 : 13} />
        <span className={css.jobTitle}>{doingWords(j, t)}</span>
        {!compact ? <span className={css.jobMeta}>{elapsed}</span> : null}
        <span className={css.jobEnd}>
          {onStop ? (
            <Button variant="outline" size="sm" disabled={stopping || finishing} data-upgrade-cancel={finishing ? 'finishing' : stopping ? 'stopping' : 'ready'}
              title={finishing ? t('upgradeFinishingTip') : undefined} onClick={stop}>
              {stopping && !finishing ? t('upgradeStopping') : t('upgradeCancel')}
            </Button>
          ) : null}
        </span>
      </div>
      <ol className={own.steps} aria-label={t('upgradeSteps')}>
        {steps.map((s) => (
          <li key={s.step} className={own.step} data-step={s.step} data-state={s.state} aria-current={s.state === 'now' ? 'step' : undefined}>
            <StatusDot state={s.state === 'done' ? 'done' : s.state === 'now' ? 'ongoing' : s.state === 'failed' ? 'error' : 'idle'} size={8} />
            <span>{stepWords(s.step, t)}</span>
          </li>
        ))}
      </ol>
      {compact ? <span className={css.jobMeta}>{elapsed}</span> : null}
    </div>
  )
}

function UpgradeEnded({ job: j, t, compact, onCheck, onRetry, onDismiss }: UpgradePanelProps): ReactNode {
  const [checking, setChecking] = useState(false)
  const end = upgradeEnd(j, t)
  const check = () => {
    if (!onCheck || checking) return
    setChecking(true)
    void Promise.resolve(onCheck()).catch(() => {}).finally(() => setChecking(false))
  }
  const action = end.check && onCheck
    ? <Button variant="outline" size="sm" disabled={checking} onClick={check}>{checking ? t('upgradeChecking') : t('upgradeCheck')}</Button>
    : end.state === 'error' && !end.check && onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>{t('jobRetry')}</Button>
      : null
  return (
    <div className={css.job} data-state={end.state === 'error' ? 'failed' : 'done'} data-compact={compact || undefined} data-upgrade={end.state} role="status">
      <div className={css.jobLine}>
        <Signal state={end.state} title={end.word} detail={end.tip ? <span className={own.tip}>{end.tip}</span> : undefined}
          anchorText={<span className={own.word}><StatusDot state={end.state === 'ok' ? 'done' : end.state} size={10} />{end.word}</span>} />
        <span className={css.jobEnd}>
          {action}
          {onDismiss ? <Button variant="ghost" size="sm" onClick={onDismiss}>{t('dismiss')}</Button> : null}
        </span>
      </div>
    </div>
  )
}
