/** Small pieces Storage's views share: refusal words, the Store glyph, and a form in a DSH modal. */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Input, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { Field, Refusal, type RefusalLabels } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import css from './Storage.module.css'

/** The words a LayerFS refusal needs, from Storage's dictionary. */
export function refusalLabels(t: StorageT): RefusalLabels {
  return {
    category: (kind) => kind === 'usage' ? t('refusalUsage') : kind === 'unavailable' ? t('refusalUnavailable') : kind === 'unknown' ? t('refusalUnknown') : t('refusalRefusal'),
    inTheWay: t('inTheWay'),
    kind: (kind) => kind.charAt(0).toUpperCase() + kind.slice(1),
    phase: (phase) => t('phase', { phase }),
    operation: (op) => t('operation', { op }),
  }
}

/** A Store's glyph: a database for SQLite, stacked servers for PostgreSQL. */
export function StoreGlyph({ kind, size = 18 }: { kind: 'sqlite' | 'postgresql' | string, size?: number }): ReactNode {
  return kind === 'postgresql' ? (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1.25" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1.25" />
      <circle cx="5" cy="4.75" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="5" cy="11.25" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      <ellipse cx="8" cy="3.75" rx="5" ry="1.75" />
      <path d="M3 3.75v8.5c0 .97 2.24 1.75 5 1.75s5-.78 5-1.75v-8.5" />
      <path d="M3 8c0 .97 2.24 1.75 5 1.75S13 8.97 13 8" />
    </svg>
  )
}

/** A bucket's glyph. */
export function BucketGlyph({ size = 18 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      <ellipse cx="8" cy="3.5" rx="5.5" ry="1.5" />
      <path d="M2.5 3.5l1.3 9.1c.1.8 2 1.4 4.2 1.4s4.1-.6 4.2-1.4l1.3-9.1" />
    </svg>
  )
}

export interface FormModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string | undefined
  /** The submit button's words. */
  action: string
  /** Whether the form can be submitted. */
  valid: boolean
  /** Runs the action; a refusal stays under the form. Resolves to close. */
  submit: () => Promise<unknown>
  /** Why the action is not ready yet. */
  hint?: string | undefined
  t: StorageT
  danger?: boolean
  children: ReactNode
}

/** A form in a DSH modal: its fields, one submit whose refusal shows under them. */
export function FormModal({ open, onClose, title, description, action, valid, submit, hint, t, danger, children }: FormModalProps): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const go = async () => {
    if (!valid || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await submit()
      onClose()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={() => { if (!busy) onClose() }} title={title} description={description} closeLabel={t('close')} className={css.modal}
      footer={(
        <div className={css.modalFooter}>
          {hint ? <span className={css.modalHint}>{hint}</span> : <span />}
          <div className={css.modalActions}>
            <Button variant="outline" onClick={onClose} disabled={busy}>{t('cancel')}</Button>
            <Button variant="primary" className={danger ? css.dangerPrimary : undefined} disabled={!valid || busy} aria-busy={busy}
              icon={busy ? <StateDot state="ongoing" size={13} /> : undefined} onClick={() => { void go() }}>{action}</Button>
          </div>
        </div>
      )}>
      <form className={css.form} onSubmit={(e) => { e.preventDefault(); void go() }}>
        {children}
        {error !== undefined ? <Refusal error={error} labels={refusalLabels(t)} /> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  )
}

/** A labelled text input. */
export function TextField({ label, value, onChange, hint, error, placeholder, mono, autoFocus, type }: {
  label: string
  value: string
  onChange: (v: string) => void
  hint?: string | undefined
  error?: string | null | undefined
  placeholder?: string | undefined
  mono?: boolean
  autoFocus?: boolean
  type?: string
}): ReactNode {
  return (
    <Field label={label} hint={hint} error={error}>
      <Input className={mono ? css.monoInput : undefined} value={value} placeholder={placeholder} type={type} autoComplete="off" spellCheck={false}
        data-modal-autofocus={autoFocus ? '' : undefined} onChange={(e) => onChange(e.target.value)} />
    </Field>
  )
}

/** Two to three exclusive options as tiles (a kind of Store, a provider). */
export function TileChoice<V extends string>({ label, value, onChange, options }: {
  label: string
  value: V
  onChange: (v: V) => void
  options: readonly { value: V, label: string, body?: string | undefined, icon?: ReactNode, disabled?: string | null | undefined }[]
}): ReactNode {
  return (
    <div role="radiogroup" aria-label={label} className={css.tiles} style={{ '--tile-count': options.length } as CSSProperties}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} aria-disabled={!!o.disabled || undefined}
          className={css.tile} data-checked={value === o.value || undefined} onClick={() => { if (!o.disabled) onChange(o.value) }}>
          {o.icon ? <span className={css.tileIcon}>{o.icon}</span> : null}
          <span className={css.tileText}>
            <span className={css.tileLabel}>{o.label}</span>
            {o.disabled || o.body ? <span className={css.tileBody}>{o.disabled ?? o.body}</span> : null}
          </span>
        </button>
      ))}
    </div>
  )
}
