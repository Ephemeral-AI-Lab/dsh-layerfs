/**
 * The Overview's header and tabs. The header is one row: the LayerFS × DSH
 * lockup over the pinned runtime, then what needs you most (named,
 * with the verb that fixes it) or that all is well, then the home's pages
 * (Health with its findings count, Logs, Settings) and Refresh as icon
 * buttons. Counts are not repeated here: the tabs under it carry them.
 * The tab bar (Projects, Stores, Machines, Backups) shows each tab's count
 * and a dot when something in it needs you, with the selected tab's actions
 * at its right end; it stays at the top of the scroll while the selected
 * tab's cards scroll under it.
 */
import type { KeyboardEvent, ReactNode } from 'react'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
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

/** The LayerFS × DSH lockup: each mark beside its name (brand names, not copy). */
export function BrandLockup(): ReactNode {
  return (
    <span className={css.lockup}>
      <LayerfsGlyph size={22} />
      <span className={css.word}>Layer<span className={css.fs}>FS</span></span>
      <span className={css.times}>×</span>
      <span className={css.fish}><FishLogo size={24} /></span>
      <span className={css.word}>DSH</span>
    </span>
  )
}

export function HomeHero({ identity, signal, headline, actions, tools, toolsLabel, tabs, active, onSelect, tabsLabel, tabActions, banner }: {
  /** The lockup over the pinned runtime. */
  identity: ReactNode
  /** The state as one dot (its reason on hover). */
  signal: ReactNode
  /** What needs you most, or that all is well. */
  headline: ReactNode
  /** The verb that fixes the headline, and how many more need you. */
  actions?: ReactNode
  /** The home's pages and Refresh, as icon buttons. */
  tools: ReactNode
  toolsLabel: string
  tabs: readonly HeroTab[]
  active: string
  onSelect: (key: string) => void
  tabsLabel: string
  /** The selected tab's actions, at the right end of the tab bar. */
  tabActions?: ReactNode
  /** The runtime card when open, between the header and the tabs. */
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
        <div className={css.identity}>{identity}</div>
        <span className={css.rule} aria-hidden="true" />
        <div className={css.status}>
          <span className={css.signal}>{signal}</span>
          <h1 className={css.title}>{headline}</h1>
          {actions}
        </div>
        <nav className={css.tools} aria-label={toolsLabel}>{tools}</nav>
      </header>
      {banner}
      <div className={css.tabBar}>
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
        {tabActions ? <div className={css.tabActions}>{tabActions}</div> : null}
      </div>
    </>
  )
}
