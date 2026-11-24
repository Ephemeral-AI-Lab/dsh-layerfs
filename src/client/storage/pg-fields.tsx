/**
 * Shared PostgreSQL URL checks (ProjectDialog's new PostgreSQL Store). URLs
 * never carry a user, password or passfile: the user and password are given
 * apart, the password to LayerFS on stdin.
 */
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Notice } from '../ui/index.tsx'
import css from './Storage.module.css'

/** A PostgreSQL URL that holds a user, a password or a password file (spec v23 V23-13). */
export const PG_URL_LOGIN = /^postgres(?:ql)?:\/\/[^/@?]*@|[?&]([^=&]*password|user|passfile)=/i

/** Add `postgresql://` when the person omitted the scheme, matching `parsePgUrl`. */
export const withPgScheme = (raw: string): string => {
  const s = raw.trim()
  return !s ? '' : /^postgres(?:ql)?:\/\//i.test(s) ? s : `postgresql://${s}`
}

/** Whether `raw` names a login (user@, user:pass@, user=, *password=, passfile=), even without a scheme. */
export const hasPgUrlLogin = (raw: string): boolean => {
  const s = raw.trim()
  return !!s && PG_URL_LOGIN.test(withPgScheme(s))
}

/** Whether `raw` points at `localhost` on Linux without an explicit `hostaddr=` (PG-CONN-REVIEW E5). */
export function isLinuxLocalhostUrl(raw: string, hostOs?: string): boolean {
  if (hostOs !== 'linux') return false
  const s = raw.trim()
  if (!s) return false
  try {
    const u = new URL(withPgScheme(s))
    return u.hostname.toLowerCase() === 'localhost' && !u.searchParams.has('hostaddr')
  } catch {
    return false
  }
}

/** Replace a `localhost` hostname in a PostgreSQL URL with `127.0.0.1`, keeping scheme, port, database and options. */
export function replaceLocalhostWithIpv4(raw: string): string {
  const s = raw.trim()
  if (!s) return s
  return s.replace(/^((?:postgres(?:ql)?:\/\/)?(?:[^/@?]*@)?)localhost(?=(?::\d+)?(?:\/|\?|$))/i, '$1127.0.0.1')
}

/** Linux `localhost` warning with one-click replacement to `127.0.0.1` (while LayerFS PR #760 is not in the pinned runtime). */
export function PgLocalhostNotice({ message, actionLabel, onReplace }: {
  message: string, actionLabel: string, onReplace: () => void
}): ReactNode {
  return (
    <Notice tone="warning" role="status" data-localhost-notice>
      <div className={css.localhostRow}>
        <span className={css.localhostText}>{message}</span>
        <Button type="button" variant="outline" size="sm" onClick={onReplace}>{actionLabel}</Button>
      </div>
    </Notice>
  )
}
