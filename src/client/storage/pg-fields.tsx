/**
 * Shared PostgreSQL URL checks and login fields (Connect a database, Edit
 * connection, Save a login, and ProjectDialog). Passwords go to LayerFS on
 * stdin (`store save-auth`); URLs never carry a user, password or passfile.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { Field, MenuSelect, Notice } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import type { PgAuth } from './types.ts'
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

/**
 * LayerFS's fix for a URL that names a login (V23-13): save the login apart,
 * then connect the address without it. When `machine` is set (own address),
 * only the machine's clean address command is needed.
 */
export function loginInUrlFix(url: string, store: string, opts?: { machine?: string | undefined }): string {
  let address = '', user = ''
  try {
    const u = new URL(withPgScheme(url))
    const rawUser = u.username
    const paramUser = u.searchParams.get('user') ?? ''
    u.username = ''; u.password = ''
    for (const key of [...u.searchParams.keys()]) if (/password|^user$|^passfile$/i.test(key)) u.searchParams.delete(key)
    address = u.toString()
    try { user = (rawUser ? decodeURIComponent(rawUser) : '') || paramUser } catch { user = rawUser || paramUser }
  } catch {
    return ''
  }
  const target = store || '<store>'
  if (opts?.machine) return `layerfs store connect ${target} ${address} --machine ${opts.machine}`
  return `layerfs store save-auth <auth> --user ${user || '<user>'} --password-stdin && layerfs store connect ${target} ${address} --auth <auth>`
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

/** Format `host` and optional `port` (`[::1]:5432`, `127.0.0.1:15200`). */
export function formatHostPort(host: string | null | undefined, port?: number | null): string {
  if (!host) return ''
  if (/^(?:\[[^\]]+\]|[^:]+):\d+$/.test(host)) return host
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return port ? `${bracketed}:${port}` : bracketed
}

/** LayerFS's CLI fix rendered under a refused URL, with a one-click Copy button. */
export function PgLoginInUrlFix({ url, store, machine, label, copyLabel, copiedLabel }: {
  url: string, store: string, machine?: string | undefined
  label: string, copyLabel: string, copiedLabel: string
}): ReactNode {
  const [copied, setCopied] = useState(false)
  const cmd = loginInUrlFix(url, store, machine ? { machine } : undefined)
  if (!cmd) return null
  const copy = () => {
    void navigator.clipboard?.writeText(cmd).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }, () => {})
  }
  return (
    <div className={css.loginFixBox} data-login-fix>
      <div className={css.loginFixHead}>
        <span className={css.loginFixLabel}>{label}</span>
        <Button type="button" variant="ghost" size="sm" onClick={copy}>{copied ? copiedLabel : copyLabel}</Button>
      </div>
      <code className={css.loginFixCode}>{cmd}</code>
    </div>
  )
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

type How = 'same' | 'entered' | 'saved'

/** GET /api/store-auths with optional gating and reload (shared by Storage dialogs and ProjectDialog). */
export function usePgAuthsQuery(api: LayerfsApi, enabled = true): { auths: PgAuth[], reload: () => void } {
  const [auths, setAuths] = useState<PgAuth[]>([])
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])
  useEffect(() => {
    if (!enabled) return
    let live = true
    api.call<{ items: PgAuth[] }>('GET', '/api/store-auths').then((r) => { if (live) setAuths(Array.isArray(r?.items) ? r.items : []) }, () => {})
    return () => { live = false }
  }, [api, enabled, tick])
  return { auths, reload }
}

/** GET /api/store-auths once: the saved logins (never a password); empty when the read failed. */
export function usePgAuths(api: LayerfsApi): PgAuth[] {
  return usePgAuthsQuery(api, true).auths
}

export type PgLoginBody = { passwordFrom: string } | { authName?: string, user: string, passwordValue: string } | { auth: string }

/**
 * The login state: `same` (a Store on the same server, its login reused),
 * `entered` (user + password, saved now) or `saved` (a login by name).
 */
export function usePgPassword(initial: 'entered' | 'saved' = 'entered', savedAuth = '', same: string | null = null, givenUser = '') {
  const [how, setHow] = useState<How>(same ? 'same' : initial)
  const [value, setValue] = useState('')
  const [user, setUser] = useState(givenUser)
  const [auth, setAuth] = useState(savedAuth)
  return {
    how, setHow, value, setValue, user, setUser, auth, setAuth, same,
    missing: how === 'same' ? false : how === 'entered' ? !value || !user.trim() : !auth,
    error: (_t?: StorageT): string | null => null,
    body: (authName?: string): PgLoginBody =>
      (how === 'same' && same ? { passwordFrom: same } : how === 'entered' ? { ...(authName ? { authName } : {}), user: user.trim(), passwordValue: value } : { auth }),
  }
}

export interface PgFieldsCopy {
  loginField: string
  passwordSame: string
  passwordEntered: string
  passwordSaved: string
  user: string
  password: string
  savedLabel: string
  sameNote: (store: string) => string
  enteredNote: string
  savedHint: string
}

export const storagePgFieldsCopy = (t: StorageT): PgFieldsCopy => ({
  loginField: t('pgLoginField'),
  passwordSame: t('pgPasswordSame'),
  passwordEntered: t('pgPasswordEntered'),
  passwordSaved: t('pgPasswordReference'),
  user: t('pgUser'),
  password: t('pgPasswordValue'),
  savedLabel: t('pgPasswordReferenceLabel'),
  sameNote: (store) => t('pgPasswordSameNote', { store }),
  enteredNote: t('pgPasswordNote'),
  savedHint: t('pgAuthHint'),
})

export function PgPasswordFields({ id, pw, t, copy, auths = [], enteredNote }: {
  id: string
  pw: ReturnType<typeof usePgPassword>
  t?: StorageT | undefined
  copy?: PgFieldsCopy | undefined
  auths?: readonly PgAuth[]
  enteredNote?: string | undefined
}): ReactNode {
  const c = copy ?? storagePgFieldsCopy(t!)
  const hint = pw.how === 'same' ? c.sameNote(pw.same ?? '') : pw.how === 'entered' ? (enteredNote ?? c.enteredNote) : c.savedHint
  const options: { value: How, label: string }[] = [
    ...(pw.same ? [{ value: 'same' as const, label: c.passwordSame }] : []),
    { value: 'entered' as const, label: c.passwordEntered },
    ...(auths.length ? [{ value: 'saved' as const, label: c.passwordSaved }] : []),
  ]
  return (
    <Field label={c.loginField} hint={hint} error={pw.error(t)}>
      <div className={css.passwordRow}>
        {pw.how === 'same' ? null : pw.how === 'entered' ? (
          <>
            <label className={css.passwordPart}>
              <span className={css.passwordLabel}>{c.user}</span>
              <Input key="user" className={clsx(css.monoInput, css.passwordInput)} value={pw.user} onChange={(e) => pw.setUser(e.target.value)} placeholder={c.user}
                aria-label={c.user} autoComplete="off" spellCheck={false} />
            </label>
            <label className={css.passwordPart}>
              <span className={css.passwordLabel}>{c.password}</span>
              <Input key="entered" className={clsx(css.monoInput, css.passwordInput)} value={pw.value} onChange={(e) => pw.setValue(e.target.value)} type="password"
                aria-label={c.password} autoComplete="new-password" spellCheck={false} />
            </label>
          </>
        ) : (
          <MenuSelect value={pw.auth} label={c.savedLabel} placeholder={c.savedLabel}
            options={auths.map((a) => ({ value: a.auth, label: a.user ? `${a.auth} (${a.user})` : a.auth }))} onChange={pw.setAuth} />
        )}
        {options.length > 1 ? <SegmentedControl<How> id={id} className={css.noShrink} value={pw.how} onChange={pw.setHow} label={c.loginField} options={options} /> : null}
      </div>
    </Field>
  )
}
