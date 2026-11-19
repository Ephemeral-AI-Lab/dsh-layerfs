/** Loading, refusal and empty states shared by the LayerFS pages. */
import { useContext, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RunnableFix } from '../../shared/doctor.ts'
import { FixAction, FixContext, refusalOf, resolveFix, type RefusalLabels } from '../ui/index.tsx'
import { errorCode, errorText } from './use-query.ts'
import css from './States.module.css'

/** A read in progress: a spinning dot and its words. */
export function Loading({ label, className }: { label: string, className?: string }): ReactNode {
  return <p className={clsx(css.status, className)} role="status"><StateDot state="ongoing" size={13} />{label}</p>
}

/**
 * A refused read: what failed, LayerFS's words and code, and Retry.
 * @param props.title - what could not be read, in the caller's words.
 * @param props.error - the refusal.
 * @param props.retryLabel - localized Retry.
 * @param props.onRetry - reads again.
 */
export function ErrorState({ title, error, retryLabel, onRetry, className, fixWord, inTheWay }: {
  title: string, error: unknown, retryLabel?: string, onRetry?: () => void, className?: string
  /** A refusal whose fix the page runs: the status word for that fix (default: `title`). */
  fixWord?: ((fix: RunnableFix) => string | null) | undefined
  /** "In the way", for a refused fix's own refusal. */
  inTheWay?: string | undefined
}): ReactNode {
  const fixes = useContext(FixContext)
  const resolved = fixes ? resolveFix(fixes, refusalOf(error).fix) : null
  // a refusal with a fix the page runs (Center): the word, LayerFS's message as its tip, the fix as the one action; no code chip, no Retry
  if (resolved?.fix && fixes) {
    return (
      <div className={clsx(css.failure, className)} role="alert" data-fix={resolved.fix.kind}>
        <div className={css.failureText}>
          <p className={css.failureTitle} title={errorText(error)}><StateDot state="error" />{fixWord?.(resolved.fix) ?? title}</p>
        </div>
        <FixAction line={resolved.line} fix={resolved.fix} runner={fixes} labels={compactLabels(inTheWay ?? '')} />
      </div>
    )
  }
  const code = errorCode(error)
  return (
    <div className={clsx(css.failure, className)} role="alert">
      <div className={css.failureText}>
        <p className={css.failureTitle}><StateDot state="error" />{title}</p>
        <p className={css.failureDetail}>{errorText(error)}{code ? <code className={css.code}>{code}</code> : null}</p>
      </div>
      {onRetry && retryLabel ? <Button variant="outline" size="sm" onClick={onRetry}>{retryLabel}</Button> : null}
    </div>
  )
}

/** The words a fix's own refusal needs when it shows compact (only "in the way" is read). */
const compactLabels = (inTheWay: string): RefusalLabels => ({ category: () => '', inTheWay, kind: (k) => k, phase: (p) => p, operation: (o) => o })

/** Nothing to show: a title, a sentence and an optional action. */
export function EmptyState({ title, children, action, icon, className }: { title: string, children?: ReactNode, action?: ReactNode, icon?: ReactNode, className?: string }): ReactNode {
  return (
    <div className={clsx(css.empty, className)}>
      {icon ? <span className={css.emptyIcon} aria-hidden="true">{icon}</span> : null}
      <p className={css.emptyTitle}>{title}</p>
      {children ? <p className={css.emptyBody}>{children}</p> : null}
      {action ? <div className={css.emptyAction}>{action}</div> : null}
    </div>
  )
}
