/** Small pieces Storage's views share: refusal words, the Store glyph, and a form in a DSH modal. */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Input, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { StoreKindGlyph } from '../machines/icons.tsx'
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

/** A Store's glyph: its kind's mark, the SQLite feather or the PostgreSQL elephant (`mono` draws it in the text color). */
export function StoreGlyph({ kind, size = 18, mono }: { kind: 'sqlite' | 'postgresql' | string, size?: number, mono?: boolean }): ReactNode {
  return <StoreKindGlyph kind={kind} size={size} mono={mono} />
}

/** A Store's backup mark in the explorer: a small cloud. */
export function CloudGlyph({ size = 12 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.6 12.5h7a2.9 2.9 0 0 0 .4-5.77A4 4 0 0 0 4.3 7.6a2.45 2.45 0 0 0 .3 4.9z" />
    </svg>
  )
}

/** The LayerFS Home's glyph in the explorer: a house. */
export function HomeGlyph({ size = 15 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 7.25 8 2.75l5.5 4.5" />
      <path d="M4 6.1v7.15h8V6.1" />
      <path d="M6.75 13.25v-3.5h2.5v3.5" />
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
  /** What the footer says while the action runs. */
  busyHint?: string | undefined
  t: StorageT
  danger?: boolean
  children: ReactNode
}

/** A form in a DSH modal: its fields, one submit whose refusal shows under them. */
export function FormModal({ open, onClose, title, description, action, valid, submit, hint, busyHint, t, danger, children }: FormModalProps): ReactNode {
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
          {busy && busyHint ? <span className={css.modalHint} role="status">{busyHint}</span> : hint ? <span className={css.modalHint}>{hint}</span> : <span />}
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

/** Push: an arrow up out of a tray (a Store leaves for a machine). */
export function PushGlyph({ size = 13 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 10.5V2.5M5 5.5l3-3 3 3" />
      <path d="M2.75 10v2.25c0 .7.55 1.25 1.25 1.25h8c.7 0 1.25-.55 1.25-1.25V10" />
    </svg>
  )
}

/** Pull: an arrow down into a tray (a Store comes home). */
export function PullGlyph({ size = 13 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5v8M5 7.5l3 3 3-3" />
      <path d="M2.75 10v2.25c0 .7.55 1.25 1.25 1.25h8c.7 0 1.25-.55 1.25-1.25V10" />
    </svg>
  )
}

/** Detach: a broken link. */
export function UnlinkGlyph({ size = 13 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" aria-hidden="true">
      <path d="M6.5 4.5 7.75 3.25a2.47 2.47 0 0 1 3.5 3.5L10 8" />
      <path d="M9.5 11.5 8.25 12.75a2.47 2.47 0 0 1-3.5-3.5L6 8" />
      <path d="M2.5 2.5l1.5 1.5M12 12l1.5 1.5" />
    </svg>
  )
}
