/** The PostgreSQL password fields Storage's dialogs share: typed (the host writes it to an owner-only file) or a reference. */
import { useState, type ReactNode } from 'react'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { Field } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { TextField } from './parts.tsx'
import css from './Storage.module.css'

/** A PostgreSQL password reference: any env: name (the server's environment) or a file. */
const PG_REFERENCE = /^(env:[A-Za-z_][A-Za-z0-9_]*|file:\/.+)$/
/** A PostgreSQL URL that holds a password (user:password@, or a password parameter). */
export const PG_URL_PASSWORD = /^postgres(?:ql)?:\/\/[^/@?]*:[^/@?]*@|[?&][^=&]*password=/i

export function usePgPassword(initial: 'entered' | 'reference' = 'entered', reference = '') {
  const [how, setHow] = useState<'entered' | 'reference'>(initial)
  const [value, setValue] = useState('')
  const [ref, setRef] = useState(reference)
  return {
    how, setHow, value, setValue, ref, setRef,
    /** Nothing given yet. */
    missing: how === 'entered' ? !value : !ref.trim(),
    error: (t: StorageT) => (how === 'reference' && ref.trim() && !PG_REFERENCE.test(ref.trim()) ? t('passwordInvalid') : null),
    /** The route's body fields. */
    body: (): { passwordValue: string } | { password: string } => (how === 'entered' ? { passwordValue: value } : { password: ref.trim() }),
  }
}

export function PgPasswordFields({ id, pw, t }: { id: string, pw: ReturnType<typeof usePgPassword>, t: StorageT }): ReactNode {
  return (
    <>
      <Field label={t('pgPasswordHow')}>
        <SegmentedControl<'entered' | 'reference'> id={id} className={css.selfStart} value={pw.how} onChange={pw.setHow} label={t('pgPasswordHow')}
          options={[{ value: 'entered', label: t('pgPasswordEntered') }, { value: 'reference', label: t('pgPasswordReference') }]} />
      </Field>
      {pw.how === 'entered' ? (
        <>
          <TextField label={t('pgPasswordValue')} value={pw.value} onChange={pw.setValue} mono type="password" />
          <p className={css.formNote}>{t('pgPasswordNote')}</p>
        </>
      ) : (
        <TextField label={t('pgPasswordReferenceLabel')} value={pw.ref} onChange={pw.setRef} mono placeholder="env:LAYERFS_PG_PASSWORD" hint={t('pgEnvHint')} error={pw.error(t)} />
      )}
    </>
  )
}
