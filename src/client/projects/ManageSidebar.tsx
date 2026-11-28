/**
 * Projects in sidebar: which projects this browser's LayerFS sidebar shows.
 * Every project LayerFS lists, as rows borrowed from Home's project table
 * (Project, Store, Machine, Sessions, Last session), checked when the sidebar
 * shows it; checking adds it (even without a session here), unchecking hides it
 * until its next session. Nothing is deleted: only the sidebar changes.
 */
import { useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconCheckOutlineRegular, IconCloseOutlineRegular, IconSearchOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { StoreKindGlyph } from '../machines/icons.tsx'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import type { ProjectRow } from '../picker/NewProjectForm.tsx'
import type { ListT } from './list-locale.ts'
import { ago, MachineMark, machineLabel, storeKind, type MarkContext } from './marks.tsx'
import type { ProjectItem, SidebarData } from './ProjectList.tsx'
import { sidebarHidden } from './recent.ts'
import css from './setup/dialog.module.css'
import table from './manage.module.css'

const nameOf = (row: ProjectRow) => row.name ?? row.key.split('/')[1] ?? row.key
const storeNameOf = (row: ProjectRow) => row.store ?? row.key.split('/')[0] ?? row.key
const keyOf = (row: ProjectRow) => row.projectId ?? row.key

interface Entry { item: ProjectItem, key: string, shown: boolean, removed: boolean, sessions: number, last: number }

export function ManageSidebar({ t, data, onClose }: { t: ListT, data: SidebarData, onClose: () => void }): ReactNode {
  const [query, setQuery] = useState('')
  const ctx: MarkContext = { t, ...data.marks }
  const sidebar = data.items ?? []
  const entries: Entry[] = []
  for (const item of sidebar) {
    entries.push({ item, key: item.hideKey, shown: true, removed: item.row.catalogState === 'removed', sessions: data.sessionsOf(item.row.key, item.row.projectId), last: data.lastUsed(item.row.key, item.row.projectId) })
  }
  for (const row of data.catalog ?? []) {
    if (sidebar.some((i) => i.row.key === row.key || (!!row.projectId && i.row.projectId === row.projectId))) continue
    entries.push({ item: data.item(row), key: keyOf(row), shown: false, removed: false, sessions: data.sessionsOf(row.key, row.projectId), last: data.lastUsed(row.key, row.projectId) })
  }
  // a name two projects share carries its Store
  const count = new Map<string, number>()
  for (const e of entries) count.set(nameOf(e.item.row), (count.get(nameOf(e.item.row)) ?? 0) + 1)
  const label = (row: ProjectRow) => ((count.get(nameOf(row)) ?? 0) > 1 ? `${nameOf(row)} · ${storeNameOf(row)}` : nameOf(row))
  // The order is fixed when the list opens (shown first, newest session first, Removed last):
  // checking a project changes its box, not its place.
  const first = useRef<string[] | null>(null)
  if (!first.current && data.items && data.catalog) {
    const rank = (e: Entry) => (e.removed ? 2 : e.shown ? 0 : 1)
    first.current = [...entries].sort((a, b) => rank(a) - rank(b) || b.last - a.last || nameOf(a.item.row).localeCompare(nameOf(b.item.row))).map((e) => e.key)
  }
  const order = (e: Entry) => { const i = first.current?.indexOf(e.key) ?? -1; return i < 0 ? Number.MAX_SAFE_INTEGER : i }
  const q = query.trim().toLowerCase()
  const rows = entries
    .filter((e) => !q || e.item.row.key.toLowerCase().includes(q) || nameOf(e.item.row).toLowerCase().includes(q) || e.item.runsOn.some((m) => m.toLowerCase().includes(q)))
    .sort((a, b) => order(a) - order(b))
  const removedShown = entries.filter((e) => e.shown && e.removed)
  const toggle = (e: Entry) => (e.shown ? sidebarHidden.hide(e.key) : sidebarHidden.show(e.key))
  const lastWords = (e: Entry) => (e.last ? ago(e.last, t) : e.item.row.created ? t('createdAgo', { ago: ago(e.item.row.created, t) }) : '—')

  return <Modal open headless onClose={onClose} title={t('sidebarTitle')} className={clsx(css.dialog, table.wide)}>
    <header className={css.head}>
      <div className={css.headRow}>
        <span className={css.headTile} aria-hidden="true"><LayerfsGlyph size={18} /></span>
        <span className={css.headText}>
          <h2 className={css.title}>{t('sidebarTitle')}</h2>
          <span className={css.sub}>{data.items && data.catalog ? t('shownOf', { shown: entries.filter((e) => e.shown).length, n: entries.length }) : t('sidebarSub')}</span>
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
      <div className={clsx(table.row, table.headRow)} aria-hidden="true">
        <span />
        <span>{t('colProject')}</span>
        <span>{t('colStore')}</span>
        <span>{t('colMachine')}</span>
        <span className={table.num}>{t('colSessions')}</span>
        <span className={table.num}>{t('colLast')} ↓</span>
      </div>
      <div className={css.listBody} role="group" aria-label={t('sidebarTitle')}>
        {!data.catalog && !data.items ? <p className={css.empty}>{t('loading')}</p> : null}
        {rows.map((e) => {
          const { row, runsOn } = e.item
          const [machine, ...more] = runsOn
          const machines = runsOn.map((m) => machineLabel(m, ctx)).join(', ')
          return <button key={e.key} type="button" role="checkbox" aria-checked={e.shown} className={clsx(table.row, table.item, e.removed && table.removed)}
            title={row.key} onClick={() => toggle(e)} data-sidebar-project={e.key}>
            <span className={clsx(css.tileBox, e.shown && css.tileBoxOn)} aria-hidden="true">{e.shown ? <IconCheckOutlineRegular size={10} /> : null}</span>
            <span className={table.cell}><span className={table.mark}><LayerfsGlyph size={14} /></span><span className={table.name}>{label(row)}</span></span>
            {e.removed
              ? <span className={clsx(table.cell, table.span2, table.muted)}>{t('removedFromLayerfs')}</span>
              : <>
                <span className={table.cell} title={`${storeNameOf(row)} · ${t(storeKind(e.item) === 'postgresql' ? 'kindPg' : 'kindSqlite')}`}>
                  <StoreKindGlyph kind={storeKind(e.item)} size={13} /><span className={table.text}>{storeNameOf(row)}</span>
                </span>
                <span className={table.cell} title={machines || undefined}>
                  {machine ? <><MachineMark machine={machine} ctx={ctx} size={13} /><span className={table.text}>{machineLabel(machine, ctx)}</span></> : <span className={table.muted}>—</span>}
                  {more.length ? <span className={table.more}>{t('moreMachines', { n: more.length })}</span> : null}
                </span>
              </>}
            <span className={clsx(table.num, !e.sessions && table.muted)}>{e.sessions || '—'}</span>
            <span className={clsx(table.num, table.last, !e.last && table.muted)}>{lastWords(e)}</span>
          </button>
        })}
        {entries.length && !rows.length ? <p className={css.empty}>{t('noMatch')}</p> : null}
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
