/**
 * The Storage page's navigation, in one bar over the page: Back and Forward
 * through the pages visited, a breadcrumb from Center (the Overview) down to
 * the page, Jump to (⌘K / Ctrl+K), the running transfers, the Health, Logs
 * and Settings pages, Refresh and Add.
 *
 * A crumb with siblings carries a switcher: the current page's crumb opens a
 * menu of the pages beside it (the other Stores, machines, projects in the
 * Store…), and an ancestor's chevron does the same for its level, so you move
 * sideways without going back. Jump to lists every machine, Store, project,
 * Sandbox and bucket with where it lives, filtered as you type.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
  IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, Menu, MenuItemButton, Modal, ShortcutKeys, StateDot,
  modalSelector,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StorageT } from './locale.ts'
import { doingWords, shareOf } from './model.ts'
import type { TabId } from './tabs.ts'
import type { StorageJob } from './types.ts'
import css from './Nav.module.css'

/** How many pages Back remembers. */
const HISTORY_MAX = 50

/** Back and Forward over the pages visited. */
export interface NavHistory {
  current: TabId
  canBack: boolean
  canForward: boolean
  /** Show `id`, dropping anything Forward held (no-op when it already shows). */
  open: (id: TabId) => void
  back: () => void
  forward: () => void
  /** Drop pages that no longer exist (a removed Store and its projects); the page showing falls back to the one before. */
  forget: (gone: (id: TabId) => boolean) => void
}

export function useNavHistory(initial: TabId): NavHistory {
  const [h, setH] = useState<{ stack: TabId[], at: number }>({ stack: [initial], at: 0 })
  const open = useCallback((id: TabId) => setH((s) => {
    if (s.stack[s.at] === id) return s
    const stack = [...s.stack.slice(0, s.at + 1), id].slice(-HISTORY_MAX)
    return { stack, at: stack.length - 1 }
  }), [])
  const back = useCallback(() => setH((s) => (s.at > 0 ? { ...s, at: s.at - 1 } : s)), [])
  const forward = useCallback(() => setH((s) => (s.at < s.stack.length - 1 ? { ...s, at: s.at + 1 } : s)), [])
  const forget = useCallback((gone: (id: TabId) => boolean) => setH((s) => {
    const stack: TabId[] = []
    let at = -1
    s.stack.forEach((id, i) => {
      if (!gone(id) && stack[stack.length - 1] !== id) stack.push(id)
      if (i === s.at) at = stack.length - 1
    })
    if (stack.length === 0) return { stack: ['overview'], at: 0 }
    return { stack, at: Math.max(0, at) }
  }), [])
  return {
    current: h.stack[h.at] ?? 'overview',
    canBack: h.at > 0,
    canForward: h.at < h.stack.length - 1,
    open, back, forward, forget,
  }
}

/** A page beside another, for a crumb's switcher. */
export interface Sibling {
  id: TabId
  label: string
  /** Where it lives or what it is, in a few words. */
  meta?: string | undefined
  /** Starts a group under this heading. */
  group?: string | undefined
}

/** One crumb: the last one is the page showing. */
export interface Crumb {
  key: string
  label: string
  icon?: ReactNode
  /** Where clicking the crumb leads (none on the page showing). */
  go?: (() => void) | undefined
  /** The pages beside this one, for its switcher; `id` marks which is this one. */
  siblings?: readonly Sibling[] | undefined
  id?: TabId | undefined
}

/** Something Jump to can open. */
export interface JumpItem {
  id: TabId
  /** Its group heading (Projects, Stores, …). */
  group: string
  label: string
  /** Where it lives, so a name reads without a tree around it. */
  where: string
  icon?: ReactNode
}

/** An entry in the Add menu. */
export interface AddItem {
  id: string
  label: string
  icon?: ReactNode
  run: () => void
}

/** A page with its own button in the bar (Health, Logs, Settings). */
export interface NavPage {
  id: TabId
  label: string
  icon: ReactNode
  /** A number beside the icon (Health's findings). */
  count?: number | undefined
  /** The button's tooltip when it says more than the label. */
  title?: string | undefined
}

export interface NavBarProps {
  t: StorageT
  history: NavHistory
  crumbs: readonly Crumb[]
  jump: readonly JumpItem[]
  jobs: readonly StorageJob[]
  refreshing: boolean
  onRefresh: () => void
  add: readonly AddItem[]
  onOpen: (id: TabId) => void
  /** The pages with their own button, between Jump to and Refresh. */
  pages: readonly NavPage[]
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

export function NavBar({ t, history, crumbs, jump, jobs, refreshing, onRefresh, add, onOpen, pages }: NavBarProps): ReactNode {
  const [jumping, setJumping] = useState(false)
  const barRef = useRef<HTMLElement>(null)
  // ⌘K / Ctrl+K opens Jump to while this page shows and nothing modal is open over it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(isMac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return
      const bar = barRef.current
      if (!bar || bar.getClientRects().length === 0 || document.querySelector(modalSelector)) return
      e.preventDefault()
      setJumping(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const running = jobs.filter((j) => !j.ended)
  return (
    <header ref={barRef} className={css.bar} aria-label={t('navLabel')}>
      <span className={css.history}>
        <Button variant="ghost" size="sm" className={css.iconButton} aria-label={t('navBack')} title={t('navBack')} disabled={!history.canBack}
          icon={<IconChevronLeftOutlineRegular size={16} />} onClick={history.back} />
        <Button variant="ghost" size="sm" className={css.iconButton} aria-label={t('navForward')} title={t('navForward')} disabled={!history.canForward}
          icon={<IconChevronRightOutlineRegular size={16} />} onClick={history.forward} />
      </span>
      <nav className={css.crumbs} aria-label={t('crumbsLabel')}>
        <ol className={css.crumbList}>
          {crumbs.map((c, i) => (
            <li key={c.key} className={css.crumbItem}>
              {i > 0 ? <IconChevronRightOutlineRegular size={12} className={css.crumbSep} aria-hidden="true" /> : null}
              <CrumbView crumb={c} current={i === crumbs.length - 1} t={t} onOpen={onOpen} />
            </li>
          ))}
        </ol>
      </nav>
      <span className={css.tools}>
        {running.length > 0 ? <Jobs jobs={running} t={t} onOpen={onOpen} /> : null}
        <button type="button" className={css.jumpField} onClick={() => setJumping(true)} aria-haspopup="dialog" aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}>
          <IconSearchOutlineRegular size={14} className={css.jumpIcon} aria-hidden="true" />
          <span className={css.jumpText}>{t('jumpTo')}</span>
          <ShortcutKeys keys={[isMac ? '⌘' : 'Ctrl', 'K']} className={css.jumpKeys} />
        </button>
        <span className={css.pages}>
          {pages.map((p) => {
            const on = history.current === p.id
            return (
              <Button key={p.id} variant="ghost" size="sm" className={clsx(css.iconButton, p.count ? css.pageCounted : null, on && css.pageOn)}
                aria-label={p.title ?? p.label} title={p.title ?? p.label} aria-current={on ? 'page' : undefined}
                icon={p.icon} onClick={() => onOpen(p.id)}>
                {p.count ? <span className={css.pageCount}>{p.count}</span> : null}
              </Button>
            )
          })}
        </span>
        <Button variant="ghost" size="sm" className={css.iconButton} aria-label={t('refresh')} title={t('refresh')} disabled={refreshing}
          icon={refreshing ? <StateDot state="ongoing" size={13} /> : <IconRefreshOutlineRegular size={15} />} onClick={onRefresh} />
        <AddMenu items={add} t={t} />
      </span>
      {jumping ? <JumpDialog items={jump} t={t} onClose={() => setJumping(false)} onOpen={(id) => { setJumping(false); onOpen(id) }} /> : null}
    </header>
  )
}

/** A crumb: a link, the page showing, and a switcher when it has siblings. */
function CrumbView({ crumb: c, current, t, onOpen }: { crumb: Crumb, current: boolean, t: StorageT, onOpen: (id: TabId) => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const switcher = !!c.siblings && c.siblings.length > 1
  const body = (
    <>
      {c.icon ? <span className={css.crumbIcon} aria-hidden="true">{c.icon}</span> : null}
      <span className={css.crumbLabel}>{c.label}</span>
    </>
  )
  const menu = (anchor: ReactNode) => (
    <Menu open={open} onClose={() => setOpen(false)} portal autoFocus dense anchor={anchor} listClassName={css.switchList}>
      {(c.siblings ?? []).map((s, i) => (
        <MenuItemButton key={s.id} current={s.id === c.id} separatorBefore={i > 0 && !!s.group && s.group !== c.siblings?.[i - 1]?.group}
          onSelect={() => { setOpen(false); if (s.id !== c.id) onOpen(s.id) }}>
          <span className={css.sibling}>
            <span className={css.siblingName}>{s.label}</span>
            {s.meta ? <span className={css.siblingMeta}>{s.meta}</span> : null}
          </span>
        </MenuItemButton>
      ))}
    </Menu>
  )
  if (current) {
    if (!switcher) return <span className={clsx(css.crumb, css.crumbCurrent)} aria-current="page">{body}</span>
    return menu(
      <button type="button" className={clsx(css.crumb, css.crumbCurrent)} aria-current="page" aria-haspopup="menu" aria-expanded={open}
        title={t('crumbSwitch', { name: c.label })} onClick={() => setOpen((v) => !v)}>
        {body}<IconChevronDownOutlineRegular size={12} className={css.crumbCaret} aria-hidden="true" />
      </button>,
    )
  }
  return (
    <span className={css.crumbPair}>
      <button type="button" className={css.crumb} onClick={c.go}>{body}</button>
      {switcher ? menu(
        <button type="button" className={css.crumbMore} aria-label={t('crumbSwitch', { name: c.label })} title={t('crumbSwitch', { name: c.label })}
          aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <IconChevronDownOutlineRegular size={12} aria-hidden="true" />
        </button>,
      ) : null}
    </span>
  )
}

/** The running transfers: one opens its Store; several open a list. */
function Jobs({ jobs, t, onOpen }: { jobs: readonly StorageJob[], t: StorageT, onOpen: (id: TabId) => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const first = jobs[0]!
  const pct = (j: StorageJob) => Math.round(shareOf(j) * 100)
  const label = jobs.length === 1 ? `${first.store} · ${doingWords(first, t)}` : t('jobsMore', { n: jobs.length })
  const button = (
    <button type="button" className={css.jobs} title={jobs.map((j) => `${j.store} · ${doingWords(j, t)} ${pct(j)}%`).join('\n')}
      aria-haspopup={jobs.length > 1 ? 'menu' : undefined} aria-expanded={jobs.length > 1 ? open : undefined}
      onClick={() => (jobs.length === 1 ? onOpen(`store:${first.store}`) : setOpen((v) => !v))}>
      <span className={css.jobsLabel}>{label}</span>
      <span className={css.jobsShare}>{`${pct(first)}%`}</span>
      <span className={css.jobsTrack} aria-hidden="true"><span className={css.jobsFill} style={{ width: `${pct(first)}%` }} /></span>
    </button>
  )
  if (jobs.length === 1) return button
  return (
    <Menu open={open} onClose={() => setOpen(false)} portal autoFocus align="end" anchor={button}>
      {jobs.map((j) => (
        <MenuItemButton key={j.id} onSelect={() => { setOpen(false); onOpen(`store:${j.store}`) }}>
          <span className={css.sibling}>
            <span className={css.siblingName}>{j.store}</span>
            <span className={css.siblingMeta}>{`${doingWords(j, t)} · ${pct(j)}%`}</span>
          </span>
        </MenuItemButton>
      ))}
    </Menu>
  )
}

function AddMenu({ items, t }: { items: readonly AddItem[], t: StorageT }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <Menu open={open} onClose={() => setOpen(false)} portal autoFocus align="end"
      items={items.map((x) => ({ id: x.id, label: x.label, icon: x.icon }))}
      onSelect={(id) => { setOpen(false); items.find((x) => x.id === id)?.run() }}
      anchor={(
        <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={13} />} aria-haspopup="menu" aria-expanded={open}
          onClick={() => setOpen((v) => !v)}>{t('addMenu')}</Button>
      )} />
  )
}

/** The most results Jump to lists at once. */
const JUMP_MAX = 60

/** Jump to: a filtered list of everything, opened with Enter or a click. */
function JumpDialog({ items, t, onClose, onOpen }: { items: readonly JumpItem[], t: StorageT, onClose: () => void, onOpen: (id: TabId) => void }): ReactNode {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const hits = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const scored = items
      .filter((x) => { const hay = `${x.label} ${x.where}`.toLowerCase(); return words.every((w) => hay.includes(w)) })
      // a name that starts with the query first, then the rest in their groups' order
      .map((x, i) => ({ x, i, lead: words.length > 0 && x.label.toLowerCase().startsWith(words[0]!) ? 0 : 1 }))
    const groups = [...new Set(items.map((x) => x.group))]
    return scored
      .sort((a, b) => groups.indexOf(a.x.group) - groups.indexOf(b.x.group) || a.lead - b.lead || a.i - b.i)
      .slice(0, JUMP_MAX).map((s) => s.x)
  }, [items, q])
  useEffect(() => { setAt(0) }, [q])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at])
  const optionId = (i: number) => `lfs-jump-${i}`
  return (
    <Modal open headless onClose={onClose} title={t('jumpTitle')} className={css.jumpDialog}>
      <div className={css.jumpQuery}>
        <IconSearchOutlineRegular size={16} className={css.jumpIcon} aria-hidden="true" />
        <input className={css.jumpInput} value={q} autoFocus spellCheck={false} autoComplete="off" placeholder={t('jumpPlaceholder')}
          role="combobox" aria-expanded="true" aria-controls="lfs-jump-list" aria-label={t('jumpTitle')}
          aria-activedescendant={hits.length ? optionId(at) : undefined}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(hits.length - 1, i + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)) }
            else if (e.key === 'Enter') { e.preventDefault(); const hit = hits[at]; if (hit) onOpen(hit.id) }
          }} />
      </div>
      <div ref={listRef} id="lfs-jump-list" className={css.jumpList} role="listbox" aria-label={t('jumpTitle')}>
        {hits.length === 0 && q.trim() ? <p className={css.jumpNothing}>{t('jumpNothing', { q: q.trim() })}</p> : null}
        {hits.map((x, i) => (
          <div key={`${x.group}:${x.id}`} role="presentation">
            {i === 0 || hits[i - 1]!.group !== x.group ? <div className={css.jumpGroup} role="presentation">{x.group}</div> : null}
            <div id={optionId(i)} data-index={i} role="option" aria-selected={i === at} className={css.jumpItem} data-active={i === at || undefined}
              onMouseMove={() => { if (i !== at) setAt(i) }} onClick={() => onOpen(x.id)}>
              {x.icon ? <span className={css.jumpItemIcon} aria-hidden="true">{x.icon}</span> : null}
              <span className={css.jumpItemName}>{x.label}</span>
              <span className={css.jumpItemWhere}>{x.where}</span>
            </div>
          </div>
        ))}
      </div>
      <div className={css.jumpFoot} aria-hidden="true">{t('jumpHint')}</div>
    </Modal>
  )
}
