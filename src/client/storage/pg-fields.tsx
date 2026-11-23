/**
 * The PostgreSQL login field Storage's dialogs share (LayerFS 2.0 saved
 * logins, `store save-auth` / `store auths`): a user and password typed now
 * (the host saves them as a login; the password goes to LayerFS on stdin),
 * a login saved before, or (`same`, a Store on the same server) that Store's
 * login. One row: the inputs beside the how-toggle, which drops under them
 * when the row is too narrow. The toggle's segments are equally wide, so no
 * label carries a Store's name.
 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { Field, MenuSelect } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import type { PgAuth } from './types.ts'
import css from './Storage.module.css'

/** A PostgreSQL URL that holds a password (user:password@, or a password parameter). */
export const PG_URL_PASSWORD = /^postgres(?:ql)?:\/\/[^/@?]*:[^/@?]*@|[?&][^=&]*password=/i
/**
 * LayerFS's fix for an address that names a login (V23-13, M FAIL 2): save the
 * login, then connect the address without it. `user` from the URL (its user
 * part or `user=`), else a placeholder; the address keeps its other options.
 */
export function loginInUrlFix(url: string, store: string): string {
  let address = url.trim(), user = ''
  try {
    const u = new URL(/^postgres(?:ql)?:\/\//i.test(address) ? address : `postgresql://${address}`)
    user = decodeURIComponent(u.username) || u.searchParams.get('user') || ''
    u.username = ''; u.password = ''
    for (const key of [...u.searchParams.keys()]) if (/password|^user$|^passfile$/i.test(key)) u.searchParams.delete(key)
    address = u.toString()
  } catch { /* the address as typed */ }
  return `layerfs store save-auth <auth> --user ${user || '<user>'} --password-stdin && layerfs store connect ${store || '<store>'} ${address} --auth <auth>`
}
/** A PostgreSQL URL that holds a user, a password or a password file: a Store's address carries none in 2.0 (the saved login does; spec v23 V23-13). */
export const PG_URL_LOGIN = /^postgres(?:ql)?:\/\/[^/@?]*@|[?&]([^=&]*password|user|passfile)=/i

type How = 'same' | 'entered' | 'saved'

/** GET /api/store-auths once: the saved logins (never a password); seeded from StorageView when already read. */
export function usePgAuths(api: LayerfsApi, seed?: readonly PgAuth[]): PgAuth[] {
  const [auths, setAuths] = useState<PgAuth[]>(() => (seed ? [...seed] : []))
  useEffect(() => {
    let live = true
    api.call<{ items: PgAuth[] }>('GET', '/api/store-auths').then((r) => { if (live) setAuths(Array.isArray(r?.items) ? r.items : []) }, () => {})
    return () => { live = false }
  }, [api])
  return auths
}

/**
 * The login state: `same` (a Store on the same server, its login reused),
 * `entered` (user + password, saved now) or `saved` (a login by name).
 * `user` starts as the one given (a pasted URL's, a known server's).
 */
export function usePgPassword(initial: 'entered' | 'saved' = 'entered', savedAuth = '', same: string | null = null, givenUser = '') {
  const [how, setHow] = useState<How>(same ? 'same' : initial)
  const [value, setValue] = useState('')
  const [user, setUser] = useState(givenUser)
  const [auth, setAuth] = useState(savedAuth)
  return {
    how, setHow, value, setValue, user, setUser, auth, setAuth, same,
    /** Nothing given yet. */
    missing: how === 'same' ? false : how === 'entered' ? !value || !user.trim() : !auth,
    error: (_t: StorageT): string | null => null,
    /** The route's body fields. */
    body: (): { passwordFrom: string } | { user: string, passwordValue: string } | { auth: string } =>
      (how === 'same' && same ? { passwordFrom: same } : how === 'entered' ? { user: user.trim(), passwordValue: value } : { auth }),
  }
}

export function PgPasswordFields({ id, pw, t, auths = [] }: { id: string, pw: ReturnType<typeof usePgPassword>, t: StorageT, auths?: readonly PgAuth[] }): ReactNode {
  const hint = pw.how === 'same' ? t('pgPasswordSameNote', { store: pw.same ?? '' }) : pw.how === 'entered' ? t('pgPasswordNote') : t('pgAuthHint')
  const options: { value: How, label: string }[] = [
    ...(pw.same ? [{ value: 'same' as const, label: t('pgPasswordSame') }] : []),
    { value: 'entered' as const, label: t('pgPasswordEntered') },
    ...(auths.length ? [{ value: 'saved' as const, label: t('pgPasswordReference') }] : []),
  ]
  // each input under its own label (User, Password); the saved logins' picker shows only when there is one
  return (
    <Field label={pw.how === 'entered' ? t('pgLoginField') : t('pgPasswordHow')} hint={hint} error={pw.error(t)}>
      <div className={css.passwordRow}>
        {pw.how === 'same' ? null : pw.how === 'entered' ? (
          <>
            <label className={css.passwordPart}>
              <span className={css.passwordLabel}>{t('pgUser')}</span>
              <Input key="user" className={clsx(css.monoInput, css.passwordInput)} value={pw.user} onChange={(e) => pw.setUser(e.target.value)} placeholder={t('pgUser')}
                aria-label={t('pgUser')} autoComplete="off" spellCheck={false} />
            </label>
            <label className={css.passwordPart}>
              <span className={css.passwordLabel}>{t('pgPasswordValue')}</span>
              <Input key="entered" className={clsx(css.monoInput, css.passwordInput)} value={pw.value} onChange={(e) => pw.setValue(e.target.value)} type="password"
                aria-label={t('pgPasswordValue')} autoComplete="off" spellCheck={false} />
            </label>
          </>
        ) : (
          <MenuSelect value={pw.auth} label={t('pgPasswordReferenceLabel')} placeholder={t('pgPasswordReferenceLabel')}
            options={auths.map((a) => ({ value: a.auth, label: a.user ? `${a.auth} (${a.user})` : a.auth }))} onChange={pw.setAuth} />
        )}
        {options.length > 1 ? <SegmentedControl<How> id={id} className={css.noShrink} value={pw.how} onChange={pw.setHow} label={t('pgPasswordHow')} options={options} /> : null}
      </div>
    </Field>
  )
}
