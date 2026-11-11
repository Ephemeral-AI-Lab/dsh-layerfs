/** Loading, refusal and empty states shared by the LayerFS pages. */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
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
export function ErrorState({ title, error, retryLabel, onRetry, className }: { title: string, error: unknown, retryLabel?: string, onRetry?: () => void, className?: string }): ReactNode {
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
