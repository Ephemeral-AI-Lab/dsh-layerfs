/**
 * The PostgreSQL password field Storage's dialogs share: typed (the host
 * writes it to an owner-only file), a reference, or (`same`, a Store on the
 * same server) that Store's. One row: the input beside the how-toggle.
 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { Field } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import css from './Storage.module.css'

/** A PostgreSQL password reference: any env: name (the server's environment) or a file. */
const PG_REFERENCE = /^(env:[A-Za-z_][A-Za-z0-9_]*|file:\/.+)$/
/** A PostgreSQL URL that holds a password (user:password@, or a password parameter). */
export const PG_URL_PASSWORD = /^postgres(?:ql)?:\/\/[^/@?]*:[^/@?]*@|[?&][^=&]*password=/i

type How = 'same' | 'entered' | 'reference'

export function usePgPassword(initial: 'entered' | 'reference' = 'entered', reference = '', same: string | null = null) {
  const [how, setHow] = useState<How>(same ? 'same' : initial)
  const [value, setValue] = useState('')
  const [ref, setRef] = useState(reference)
  return {
    how, setHow, value, setValue, ref, setRef, same,
    /** Nothing given yet. */
    missing: how === 'same' ? false : how === 'entered' ? !value : !ref.trim(),
    error: (t: StorageT) => (how === 'reference' && ref.trim() && !PG_REFERENCE.test(ref.trim()) ? t('passwordInvalid') : null),
    /** The route's body fields. */
    body: (): { passwordValue: string } | { password: string } | { passwordFrom: string } =>
      (how === 'same' && same ? { passwordFrom: same } : how === 'entered' ? { passwordValue: value } : { password: ref.trim() }),
  }
}

export function PgPasswordFields({ id, pw, t }: { id: string, pw: ReturnType<typeof usePgPassword>, t: StorageT }): ReactNode {
  const hint = pw.how === 'same' ? undefined : pw.how === 'entered' ? t('pgPasswordNote') : t('pgEnvHint')
  return (
    <Field label={t('pgPasswordHow')} hint={hint} error={pw.error(t)}>
      <div className={css.inline}>
        {pw.how === 'same' ? (
          <span className={clsx(css.grow, css.formNote)}>{t('pgPasswordSameNote', { store: pw.same ?? '' })}</span>
        ) : pw.how === 'entered' ? (
          <Input key="entered" className={clsx(css.monoInput, css.grow)} value={pw.value} onChange={(e) => pw.setValue(e.target.value)} type="password" autoComplete="off" spellCheck={false} />
        ) : (
          <Input key="reference" className={clsx(css.monoInput, css.grow)} value={pw.ref} onChange={(e) => pw.setRef(e.target.value)} placeholder="env:LAYERFS_PG_PASSWORD"
            aria-label={t('pgPasswordReferenceLabel')} autoComplete="off" spellCheck={false} />
        )}
        <SegmentedControl<How> id={id} className={css.noShrink} value={pw.how} onChange={pw.setHow} label={t('pgPasswordHow')}
          options={[
            ...(pw.same ? [{ value: 'same' as const, label: t('pgPasswordSame', { store: pw.same }) }] : []),
            { value: 'entered' as const, label: t('pgPasswordEntered') }, { value: 'reference' as const, label: t('pgPasswordReference') },
          ]} />
      </div>
    </Field>
  )
}
