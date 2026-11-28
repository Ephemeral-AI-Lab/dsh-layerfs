/**
 * Projects in sidebar: which projects this browser's LayerFS sidebar shows.
 * Every project LayerFS lists, checked when the sidebar shows it; checking
 * adds it (even without a session here), unchecking hides it until its next
 * session. Nothing is deleted: only the sidebar changes.
 */
import { useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconCheckOutlineRegular, IconCloseOutlineRegular, IconSearchOutlineRegular, Modal, relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import type { ProjectRow } from '../picker/NewProjectForm.tsx'
import type { ListT } from './list-locale.ts'
import type { SidebarData } from './ProjectList.tsx'
import { sidebarHidden } from './recent.ts'
import css from './setup/dialog.module.css'

const nameOf = (row: ProjectRow) => row.name ?? row.key.split('/')[1] ?? row.key
const keyOf = (row: ProjectRow) => row.projectId ?? row.key

/** "2 h ago" in the list's words. */
function ago(at: number, t: ListT): string {
  const r = relativeTime(at, Date.now())
  switch (r.unit) {
    case 'minutes': return t('agoMinutes', { n: r.n })
    case 'hours': return t('agoHours', { n: r.n })
    case 'days': return t('agoDays', { n: r.n })
    case 'months': return t('agoMonths', { n: r.n })
    case 'years': return t('agoYears', { n: r.n })
    default: return t('agoNow')
  }
}

interface Entry { row: ProjectRow, key: string, shown: boolean, note: string, removed: boolean }

export function ManageSidebar({ t, data, onClose }: { t: ListT, data: SidebarData, onClose: () => void }): ReactNode {
  const [query, setQuery] = useState('')
  const sidebar = data.items ?? []
  const entries: Entry[] = []
  for (const item of sidebar) {
    const removed = item.row.catalogState === 'removed'
    const at = data.lastUsed(item.row.key, item.row.projectId)
    entries.push({ row: item.row, key: item.hideKey, shown: true, removed, note: removed ? t('removed') : at ? ago(at, t) : t('noSessionsYet') })
  }
  for (const row of data.catalog ?? []) {
    if (row.key === data.scratchKey || sidebar.some((i) => i.row.key === row.key || (!!row.projectId && i.row.projectId === row.projectId))) continue
    const at = data.lastUsed(row.key, row.projectId)
    entries.push({ row, key: keyOf(row), shown: false, removed: false, note: at ? ago(at, t) : t('noSessionsYet') })
  }
  // a name two projects share carries its Store
  const count = new Map<string, number>()
  for (const e of entries) count.set(nameOf(e.row), (count.get(nameOf(e.row)) ?? 0) + 1)
  const label = (row: ProjectRow) => ((count.get(nameOf(row)) ?? 0) > 1 ? `${nameOf(row)} · ${row.store ?? row.key.split('/')[0]}` : nameOf(row))
  // the groups stay as they were when the list opened: checking a project changes its box, not its place
  const placed = useRef<Map<string, boolean> | null>(null)
  if (!placed.current && data.items && data.catalog) placed.current = new Map(entries.map((e) => [e.key, e.shown]))
  const wasShown = (e: Entry) => placed.current?.get(e.key) ?? e.shown
  const q = query.trim().toLowerCase()
  // shown ones keep the order they had when the list opened (a project shown again goes back to its place)
  const first = useRef<string[] | null>(null)
  if (!first.current && placed.current) first.current = entries.map((e) => e.key)
  const order = (e: Entry) => { const i = first.current?.indexOf(e.key) ?? -1; return i < 0 ? Number.MAX_SAFE_INTEGER : i }
  const matched = entries.filter((e) => !q || e.row.key.toLowerCase().includes(q) || nameOf(e.row).toLowerCase().includes(q))
  const groups = [
    { id: 'shown', label: t('shownGroup', { n: entries.filter((e) => e.shown).length }), items: matched.filter(wasShown).sort((a, b) => order(a) - order(b)) },
    { id: 'hidden', label: t('notShownGroup', { n: entries.filter((e) => !e.shown).length }), items: matched.filter((e) => !wasShown(e)).sort((a, b) => nameOf(a.row).localeCompare(nameOf(b.row))) },
  ].filter((g) => g.items.length)
  const removedShown = entries.filter((e) => e.shown && e.removed)
  const toggle = (e: Entry) => (e.shown ? sidebarHidden.hide(e.key) : sidebarHidden.show(e.key))

  return <Modal open headless onClose={onClose} title={t('sidebarTitle')} className={clsx(css.dialog, css.narrow)}>
    <header className={css.head}>
      <div className={css.headRow}>
        <span className={css.headTile} aria-hidden="true"><LayerfsGlyph size={18} /></span>
        <span className={css.headText}>
          <h2 className={css.title}>{t('sidebarTitle')}</h2>
          <span className={css.sub}>{t('sidebarSub')}</span>
        </span>
        <Button variant="ghost" size="sm" className={css.close} icon={<IconCloseOutlineRegular size={16} />} aria-label={t('close')} title={t('close')} onClick={onClose} />
      </div>
    </header>
    <div className={css.listView} data-layerfs-manage-sidebar="">
      <div className={css.listFilter}>
        <IconSearchOutlineRegular size={14} className={css.listFilterIcon} />
        <input className={css.listFilterInput} value={query} placeholder={t('filterProjects', { n: entries.length })} aria-label={t('filterProjects', { n: entries.length })}
          autoComplete="off" spellCheck={false} data-modal-autofocus="" onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className={css.listBody} role="group" aria-label={t('sidebarTitle')}>
        {!data.catalog && !data.items ? <p className={css.empty}>{t('loading')}</p> : null}
        {groups.map((g) => <section key={g.id} className={css.listGroup}>
          <h4 className={css.listGroupLabel}>{g.label}</h4>
          {g.items.map((e) => <div key={e.key} className={css.listRow}>
            <button type="button" role="checkbox" aria-checked={e.shown} className={css.listRowBtn} title={e.row.key} onClick={() => toggle(e)} data-sidebar-project={e.key}>
              <span className={clsx(css.tileBox, e.shown && css.tileBoxOn)} aria-hidden="true">{e.shown ? <IconCheckOutlineRegular size={10} /> : null}</span>
              <span className={css.listName} style={e.removed ? { color: 'var(--dsw-alias-label-tertiary)' } : undefined}>{label(e.row)}</span>
              <span className={css.listNote}>{e.note}</span>
            </button>
          </div>)}
        </section>)}
        {entries.length && !groups.length ? <p className={css.empty}>{t('noMatch')}</p> : null}
      </div>
    </div>
    <footer className={css.foot}>
      {removedShown.length
        ? <Button type="button" variant="ghost" size="sm" onClick={() => { for (const e of removedShown) sidebarHidden.hide(e.key) }}>{t('hideRemoved', { n: removedShown.length })}</Button>
        : <span />}
      <div className={css.footActions}><Button type="button" variant="primary" onClick={onClose}>{t('done')}</Button></div>
    </footer>
  </Modal>
}
