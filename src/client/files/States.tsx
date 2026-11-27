/** Loading, refusal and empty states shared by the LayerFS pages. */
import { useContext, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { StatusDot } from '../ui/StatusDot.tsx'
import type { RunnableFix } from '../../shared/doctor.ts'
import { FixAction, FixContext, refusalOf, resolveFix, type RefusalLabels } from '../ui/index.tsx'
import { errorCode, errorText } from './use-query.ts'
import css from './States.module.css'

/** A read in progress: a spinning dot and its words. */
export function Loading({ label, className }: { label: string, className?: string }): ReactNode {
  return <p className={clsx(css.status, className)} role="status"><StatusDot state="ongoing" size={13} />{label}</p>
}

/**
 * A refused read: a status word with LayerFS's words, code and fix as its tip, and one action: the fix where the page runs it, else Retry.
 * @param props.title - what could not be read, in the caller's words.
 * @param props.error - the refusal.
 * @param props.retryLabel - localized Retry.
 * @param props.onRetry - reads again.
 */
export function ErrorState({ title, error, retryLabel, onRetry, className, fixWord, blockedWord, fixLabel, inTheWay }: {
  title: string, error: unknown, retryLabel?: string, onRetry?: () => void, className?: string
  /** A refusal whose fix the page runs: the status word for that fix (default: `title`). */
  fixWord?: ((fix: RunnableFix) => string | null) | undefined
  /** A blocked refusal (its cause in `detail.blocked_by`): the status word for it (default: `title`). */
  blockedWord?: ((blocked: { machine: string | null, reason: string | null } | null) => string | null) | undefined
  /** "Fix", before a fix line the page cannot run, in its tip. */
  fixLabel?: string | undefined
  /** "In the way", for a refused fix's own refusal. */
  inTheWay?: string | undefined
}): ReactNode {
  const fixes = useContext(FixContext)
  // a blocked read is worded by what blocks it, on either path below: LayerFS puts `blocked_by` beside `error`
  // (an SDK error carries it so); the host keeps it in `detail` (cli.ts refusalOf, router errorAnswer)
  title = blockedWord?.(blockedOf(error) ?? blockedOf(refusalOf(error).detail)) ?? title
  const resolved = fixes ? resolveFix(fixes, refusalOf(error).fix) : null
  // a refusal with a fix the page runs (Center): the word, LayerFS's message as its tip, the fix as the one action; no code chip, no Retry
  if (resolved?.fix && fixes) {
    return (
      <div className={clsx(css.failure, className)} role="alert" data-fix={resolved.fix.kind}>
        <div className={css.failureText}>
          <p className={css.failureTitle} title={errorText(error)}><StatusDot state="error" />{fixWord?.(resolved.fix) ?? title}</p>
        </div>
        <FixAction line={resolved.line} fix={resolved.fix} runner={fixes} labels={compactLabels(inTheWay ?? '')} />
      </div>
    )
  }
  // anything else (UI pass 3 R FAIL 3): the word, LayerFS's own words, code and fix line as its tip, Retry as the one action;
  // never the code word or the sentence inline. A blocked read names what blocks it (`blockedWord`).
  const code = errorCode(error)
  const r = refusalOf(error)
  const tip = [code && code !== r.message ? `${code}: ${r.message}` : r.message, r.fix ? `${fixLabel ?? 'Fix'}: ${r.fix}` : null].filter(Boolean).join('\n')
  return (
    <div className={clsx(css.failure, className)} role="alert" data-code={code || undefined}>
      <div className={css.failureText}>
        <p className={css.failureTitle} title={tip}><StatusDot state="error" />{title}</p>
      </div>
      {onRetry && retryLabel ? <Button variant="outline" size="sm" onClick={onRetry}>{retryLabel}</Button> : null}
    </div>
  )
}

/** What a blocked refusal names as its cause (`blocked_by` / `blockedBy` on the object given, the error or its `detail`: a machine and its reason), or null. */
export function blockedOf(detail: unknown): { machine: string | null, reason: string | null } | null {
  const d = detail && typeof detail === 'object' ? detail as Record<string, any> : null
  const b = d?.blocked_by ?? d?.blockedBy
  if (!b || typeof b !== 'object') return null
  return { machine: typeof b.machine === 'string' ? b.machine : null, reason: typeof b.reason === 'string' ? b.reason : null }
}

/** The words a fix's own refusal needs when it shows compact (only "in the way" is read). */
const compactLabels = (inTheWay: string): RefusalLabels => ({ category: () => '', inTheWay, kind: (k) => k, phase: (p) => p, operation: (o) => o })

/** Nothing to show: a title, a sentence and an optional action. */
export function EmptyState({ title, children, action, actionClassName, icon, className }: { title: string, children?: ReactNode, action?: ReactNode, actionClassName?: string, icon?: ReactNode, className?: string }): ReactNode {
  return (
    <div className={clsx(css.empty, className)}>
      {icon ? <span className={css.emptyIcon} aria-hidden="true">{icon}</span> : null}
      <p className={css.emptyTitle}>{title}</p>
      {children ? <p className={css.emptyBody}>{children}</p> : null}
      {action ? <div className={clsx(css.emptyAction, actionClassName)}>{action}</div> : null}
    </div>
  )
}
