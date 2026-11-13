/**
 * The Overview's header and tabs. The header is one compact card: the
 * LayerFS mark, the home's status pills, a health headline (what needs you,
 * or that all is well), one line of counts, and the page's actions. Under it
 * sits the tab bar (Projects, Stores, Machines, Backups), each tab with its
 * count and a dot when something in it needs you; it stays at the top of
 * the scroll while the selected tab's cards scroll under it.
 */
import type { KeyboardEvent, ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import css from './HomeHero.module.css'

export interface HeroTab {
  key: string
  label: string
  count: ReactNode
  /** A dot when something in this tab needs you. */
  tone?: 'warning' | 'danger' | undefined
}

/** The id of a tab's panel, for `aria-controls`. */
export const panelId = (key: string) => `ov-panel-${key}`

export function HomeHero({ eyebrow, headline, onHeadline, tone, sub, actions, tabs, active, onSelect, tabsLabel, banner }: {
  eyebrow: ReactNode
  /** What needs you, or that all is well. */
  headline: string
  /** When set, the headline is a button (it jumps to what it counts). */
  onHeadline?: (() => void) | undefined
  tone: 'success' | 'warning' | 'danger'
  /** One line of counts under the headline. */
  sub: string
  actions: ReactNode
  tabs: readonly HeroTab[]
  active: string
  onSelect: (key: string) => void
  tabsLabel: string
  /** What needs you, between the header and the tabs. */
  banner?: ReactNode
}): ReactNode {
  /** Arrow keys, Home and End move between the tabs, as a tablist does. */
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((x) => x.key === active)
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null
    if (to === null) return
    e.preventDefault()
    const next = tabs[(to + tabs.length) % tabs.length]!
    onSelect(next.key)
    e.currentTarget.querySelector<HTMLElement>(`[data-key="${next.key}"]`)?.focus()
  }
  return (
    <>
      <header className={css.hero}>
        <span className={css.mark} aria-hidden="true"><LayerfsGlyph size={30} /></span>
        <div className={css.copy}>
          <div className={css.eyebrow}>{eyebrow}</div>
          <h1 className={css.title}>
            <StateDot state={tone === 'success' ? 'done' : tone === 'danger' ? 'error' : 'warning'} size={9} />
            {onHeadline ? <button type="button" className={css.titleLink} onClick={onHeadline}>{headline}</button> : headline}
          </h1>
          <p className={css.sub}>{sub}</p>
        </div>
        <div className={css.actions}>{actions}</div>
      </header>
      {banner}
      <div className={css.tabs} role="tablist" aria-label={tabsLabel} onKeyDown={onKey}>
        {tabs.map((x) => {
          const on = x.key === active
          return (
            <button type="button" key={x.key} data-key={x.key} className={css.tab} data-active={on || undefined}
              role="tab" aria-selected={on} aria-controls={panelId(x.key)} tabIndex={on ? 0 : -1} onClick={() => onSelect(x.key)}>
              <span>{x.label}</span>
              <span className={css.count}>{x.count}</span>
              {x.tone ? <span className={css.dot} data-tone={x.tone} aria-hidden="true" /> : null}
            </button>
          )
        })}
      </div>
    </>
  )
}
