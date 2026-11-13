/**
 * dsh-layerfs shared page kit: the pieces LayerFS pages (Machines, Storage)
 * share so they read as native DSH pages. Every visible word arrives as a
 * prop from the caller's locale `t`; nothing here owns copy.
 */
import { useState, type HTMLAttributes, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconCopyOutlineRegular, IconEllipsisOutlineRegular,
  IconRefreshOutlineRegular, IconWarningOutlineRegular, Menu, StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ui.module.css'

export { css as uiCss }

// ---------- page shell ----------

/** The page's scroll container with its centered column. */
export function Page({ wide, children, label }: { wide?: boolean, children: ReactNode, label?: string }): ReactNode {
  return (
    <div className={css.page} data-wide={wide || undefined} role="region" aria-label={label}>
      <div className={css.column}>{children}</div>
    </div>
  )
}

/** One crumb step back. */
export interface CrumbStep {
  readonly label: string
  readonly onClick: () => void
  /** Accessible name, when the label alone is not enough ("Back to Machines"). */
  readonly ariaLabel?: string
}

/** The head every page shares: optional crumbs, the icon and title block, and actions at the end. */
export function PageHead({ title, intro, actions, crumbs, current, icon, badge, hideTitle }: {
  title: string
  /** The title is for assistive technology only (the tab or panel around the page already shows it). */
  hideTitle?: boolean
  intro?: ReactNode
  actions?: ReactNode
  /** Steps back, outermost first; `current` names the page itself after them. */
  crumbs?: readonly CrumbStep[]
  current?: string
  icon?: ReactNode
  /** Next to the title (a state chip). */
  badge?: ReactNode
}): ReactNode {
  return (
    <header className={css.head} data-window-drag>
      {/* The last crumb names the page; the title right below already does when they match. */}
      {crumbs && crumbs.length > 0 && <Crumbs steps={crumbs} current={current === title ? undefined : current} />}
      <div className={css.headRow}>
        <div className={css.heading}>
          {icon && <span className={css.headIcon} aria-hidden="true">{icon}</span>}
          <div className={css.headingText}>
            <div className={css.titleRow}>
              <h1 className={hideTitle ? css.srOnly : css.title} title={title}>{title}</h1>
              {badge}
            </div>
            {intro && <p className={css.intro}>{intro}</p>}
          </div>
        </div>
        {actions && <div className={css.toolbar}>{actions}</div>}
      </div>
    </header>
  )
}

/** Crumbs: each step leads back; the last names where the page is. */
export function Crumbs({ steps, current }: { steps: readonly CrumbStep[], current?: string }): ReactNode {
  return (
    <nav className={css.crumbs}>
      {steps.map((step, i) => (
        <span key={`${i}:${step.label}`} className={css.crumbs}>
          {i > 0 && <span className={css.crumbSep} aria-hidden="true">/</span>}
          <button type="button" className={css.crumb} aria-label={step.ariaLabel} onClick={step.onClick}>
            {i === 0 && <IconChevronDownOutlineRegular size={12} className={css.crumbIcon} aria-hidden="true" />}
            <span>{step.label}</span>
          </button>
        </span>
      ))}
      {current && <><span className={css.crumbSep} aria-hidden="true">/</span><span className={css.crumbCurrent}>{current}</span></>}
    </nav>
  )
}

/** A titled section with an optional count and actions at its end. */
export function Section({ title, count, actions, children, className, headless }: {
  title: string
  count?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  /** Name the section for assistive technology only. */
  headless?: boolean
}): ReactNode {
  return (
    <section className={clsx(css.section, className)} aria-label={title}>
      {!headless && (
        <div className={css.sectionHead}>
          <h2 className={css.sectionTitle}>{title}</h2>
          {count != null && <span className={css.sectionCount}>{count}</span>}
          {actions && <div className={css.sectionActions}>{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

/** The settings-card surface (R20, card fill and hairline stroke). */
export function Card({ tone, className, children, ...rest }: {
  tone?: 'danger' | 'warning' | undefined
  className?: string
  children?: ReactNode
} & HTMLAttributes<HTMLDivElement>): ReactNode {
  return <div {...rest} className={clsx(css.card, className)} data-tone={tone}>{children}</div>
}

// ---------- facts ----------

/** One fact row: label at the start, value at the end. An empty value shows `empty`. */
export function Fact({ label, children, mono, tone, title, empty = '—' }: {
  label: string
  children?: ReactNode
  mono?: boolean
  tone?: 'danger' | 'muted' | undefined
  title?: string | undefined
  empty?: string
}): ReactNode {
  const none = children === null || children === undefined || children === '' || children === false
  return (
    <div className={css.fact} data-tone={tone} data-empty={none || undefined}>
      <dt>{label}</dt>
      <dd className={clsx(mono && !none && css.mono)} title={title}>{none ? empty : children}</dd>
    </div>
  )
}

/** A list of fact rows inside a card. */
export function Facts({ children, label }: { children: ReactNode, label?: string }): ReactNode {
  return <dl className={css.facts} aria-label={label}>{children}</dl>
}

// ---------- state chip ----------

export type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info'

/** How a tone reads as a DSH state dot; a live (pulsing) state spins. */
function dotOf(tone: Tone, live: boolean): StateDotState {
  if (live) return 'ongoing'
  return tone === 'success' ? 'done' : tone === 'warning' ? 'warning' : tone === 'danger' ? 'error' : 'idle'
}

/**
 * A machine's, Store's or Sandbox's state as the SDK gives it: a state dot and
 * the word; an operation in flight follows in mono.
 */
export function StateChip({ tone, label, live, dashed, op, title, className }: {
  tone: Tone
  label: string
  live?: boolean | undefined
  dashed?: boolean | undefined
  /** The operation's words (`machine.start · boot`). */
  op?: string | null | undefined
  title?: string | undefined
  className?: string
}): ReactNode {
  return (
    <span className={clsx(css.chip, className)} data-tone={tone} data-dashed={dashed || undefined} title={title}>
      <span className={css.chipDot}><StateDot state={dotOf(tone, !!live)} /></span>
      <span className={css.chipLabel}>{label}</span>
      {op && <span className={css.chipOp}>· {op}</span>}
    </span>
  )
}

// ---------- notice ----------

/** A tinted strip for reasons, refusals and clearing calls. */
export function Notice({ tone, children, className, role }: { tone?: 'danger' | 'warning' | undefined, children: ReactNode, className?: string, role?: string }): ReactNode {
  return <div className={clsx(css.notice, className)} data-tone={tone} role={role}>{children}</div>
}

// ---------- refusal ----------

/** A refusal: LayerFS's code, its own words, and what is in the way. */
export interface RefusalShape {
  readonly code: string
  readonly message: string
  readonly detail?: any
  readonly transport?: string | undefined
}

/** The words a refusal needs; the caller's locale supplies them. */
export interface RefusalLabels {
  /** The heading for each transport class. */
  readonly category: (kind: 'refusal' | 'usage' | 'unavailable' | 'unknown') => string
  readonly inTheWay: string
  /** An entity kind in words (`sandbox` -> `Sandbox`). */
  readonly kind: (kind: string) => string
  readonly phase: (phase: string) => string
  readonly operation: (op: string) => string
}

/** The refusal an error carries, or a plain error's words. */
export function refusalOf(error: unknown): RefusalShape {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const e = error as { code: unknown, message: unknown, detail?: unknown, transport?: unknown }
    return { code: String(e.code), message: String(e.message), detail: e.detail ?? null, transport: typeof e.transport === 'string' ? e.transport : undefined }
  }
  return { code: 'Failed', message: error instanceof Error ? error.message : String(error), detail: null }
}

const EXTRA = ['authority', 'source', 'retired', 'needed', 'free', 'missing', 'vm_exists', 'execs']

/** A LayerFS refusal as it came: nothing is reworded. */
export function Refusal({ error, labels, compact, className }: { error: unknown, labels: RefusalLabels, compact?: boolean, className?: string }): ReactNode {
  const r = refusalOf(error)
  const d = r.detail && typeof r.detail === 'object' ? r.detail : null
  const related: { kind: string, name: string, why?: string }[] = Array.isArray(d?.related) ? d.related : []
  const category = r.transport === 'usage-incompatible' ? 'usage' : r.transport === 'unavailable' ? 'unavailable' : r.transport === 'transport-unknown' ? 'unknown' : 'refusal'
  const where = [
    d?.entity && `${labels.kind(String(d.entity.kind))} ${d.entity.name}`,
    d?.phase && labels.phase(String(d.phase)),
    typeof d?.op === 'string' && labels.operation(d.op),
  ].filter(Boolean)
  const extra = d ? Object.entries(d).filter(([key]) => EXTRA.includes(key)) : []
  return (
    <div role="alert" className={clsx(css.refusal, className)}>
      {!compact && <p className={css.refusalCategory}>{labels.category(category)}</p>}
      <p><span className={css.refusalCode}>{r.code}</span>: {r.message}</p>
      {!compact && where.length > 0 && <p className={css.refusalWhere}>{where.join(' · ')}</p>}
      {!compact && extra.map(([key, value]) => <p key={key} className={css.refusalExtra}>{key}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}</p>)}
      {related.length > 0 && (
        <>
          <p className={css.refusalWhere}>{labels.inTheWay}</p>
          <ul className={css.refusalRelated}>
            {related.map((x) => <li key={`${x.kind}:${x.name}`}>{labels.kind(x.kind)} {x.name}{x.why ? ` — ${x.why}` : ''}</li>)}
          </ul>
        </>
      )}
    </div>
  )
}

// ---------- loading / empty / error ----------

/** A read in flight. */
export function Loading({ label }: { label: string }): ReactNode {
  return <p className={css.status} role="status"><StateDot state="ongoing" />{label}</p>
}

/** Nothing to show, in a card. */
export function Empty({ title, children, icon }: { title: string, children?: ReactNode, icon?: ReactNode }): ReactNode {
  return (
    <Card className={css.empty}>
      {icon && <span className={css.emptyIcon} aria-hidden="true">{icon}</span>}
      <p className={css.emptyTitle}>{title}</p>
      {children && <p className={css.emptyBody}>{children}</p>}
    </Card>
  )
}

/** A read that failed: what was read, the refusal, and a retry. */
export function LoadError({ title, error, labels, retryLabel, onRetry }: { title: string, error: unknown, labels: RefusalLabels, retryLabel: string, onRetry?: () => void }): ReactNode {
  return (
    <Card tone="danger" className={css.error}>
      <p className={css.errorTitle}><IconWarningOutlineRegular size={16} />{title}</p>
      <Refusal error={error} labels={labels} />
      {onRetry && <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={onRetry}>{retryLabel}</Button>}
    </Card>
  )
}

// ---------- meter ----------

/** A share from 0 to 1 as a thin bar; its tone warns past 75 % and 90 %. */
export function Meter({ share, label, className }: { share: number, label: string, className?: string }): ReactNode {
  const clamped = Math.max(0, Math.min(1, share))
  const tone = clamped > 0.9 ? 'danger' : clamped > 0.75 ? 'warning' : undefined
  return (
    <span className={clsx(css.meter, className)} data-tone={tone} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped * 100)}>
      <span className={css.meterFill} style={{ width: `${clamped * 100}%` }} />
    </span>
  )
}

// ---------- forms and menus ----------

/** A labelled form field: its label, the control, then its error or hint. */
export function Field({ label, error, hint, children, className }: { label: string, error?: string | null | undefined, hint?: string | undefined, children: ReactNode, className?: string }): ReactNode {
  return (
    <label className={clsx(css.field, className)} data-invalid={error ? '' : undefined}>
      <span className={css.fieldLabel}>{label}</span>
      {children}
      {error ? <span className={css.fieldError} role="alert">{error}</span> : hint ? <span className={css.fieldHint}>{hint}</span> : null}
    </label>
  )
}

/** One choice of a {@link MenuSelect}. */
export interface Choice<V extends string> { readonly value: V, readonly label: string }

/** A selection: an outline button showing the choice, opening a DSH `Menu` of the options. */
export function MenuSelect<V extends string>({ value, options, onChange, label, disabled, placeholder, className }: {
  value: V | ''
  options: readonly Choice<V>[]
  onChange: (value: V) => void
  /** Accessible name. */
  label: string
  disabled?: boolean
  placeholder?: string
  className?: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const chosen = options.find((o) => o.value === value)
  return (
    <Menu open={open} onClose={() => setOpen(false)} portal autoFocus minWidthFromAnchor selection="check" selectedId={value || undefined}
      items={options.map((o) => ({ id: o.value, label: o.label }))}
      onSelect={(id) => { setOpen(false); onChange(id as V) }}
      anchor={(
        <button type="button" className={clsx(css.select, className)} disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => { if (!open && e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) } }}>
          <span className={clsx(css.selectValue, !chosen && css.selectPlaceholder)}>{chosen?.label ?? placeholder ?? ''}</span>
          <IconChevronDownOutlineRegular size={12} aria-hidden="true" />
        </button>
      )} />
  )
}

/** A `…` toolbar button opening a DSH `Menu` of `MenuItemButton` children. */
export function MoreMenu({ label, disabled, children, className }: { label: string, disabled?: boolean, children: (close: () => void) => ReactNode, className?: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  return (
    <Menu open={open} onClose={close} align="end" portal autoFocus
      anchor={(
        <Button variant="ghost" size="sm" className={clsx(css.iconButton, className)} disabled={disabled} aria-label={label} title={label}
          aria-haspopup="menu" aria-expanded={open} icon={<IconEllipsisOutlineRegular size={16} />}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }} />
      )}>
      {children(close)}
    </Menu>
  )
}

/** A copyable command line. */
export function CopyLine({ text, copyLabel, copiedLabel }: { text: string, copyLabel: string, copiedLabel: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <span className={css.copyLine}>
      <code className={css.copyText}>{text}</code>
      <Button variant="ghost" size="sm" className={css.iconButton} aria-label={copied ? copiedLabel : copyLabel} title={copied ? copiedLabel : copyLabel}
        icon={copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
        onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1000) }) }} />
    </span>
  )
}

/** A text button styled as a link. */
export function LinkButton({ children, onClick, title, className }: { children: ReactNode, onClick: () => void, title?: string, className?: string }): ReactNode {
  return <button type="button" className={clsx(css.link, className)} onClick={onClick} title={title}>{children}</button>
}
