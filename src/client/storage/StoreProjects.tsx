/**
 * A Store's Projects tab: a summary line, search and Add project over the
 * shared project table (ProjectTable.tsx ProjectGrid), the same one Home ›
 * Projects shows, without the Store column. Its headings sort (Last session
 * first, held still while sessions run); a row's size has a thin bar for its share of this Store; a row
 * opens to its sessions or Sandboxes, and its name opens the project page.
 */
import { useState, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, IconSearchOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { bytes } from '../files/format.ts'
import type { AvailableView, MachineSandbox } from '../machines/model.ts'
import { sandboxRuns } from '../machines/stats.ts'
import type { LayerfsApi } from '../api.ts'
import type { StorageT } from './locale.ts'
import type { TabId } from './tabs.ts'
import type { StoreRow } from './types.ts'
import { sandboxesOfProject } from './HomeCards.tsx'
import { ProjectGrid, placeholderProject, useSessionLists, useSessionOrder } from './ProjectTable.tsx'
import { commitTotal, commitTotalWords, orderProjects, type ProjectOrder, type StoreProject } from './store-page.ts'
import css from './StorePage.module.css'

export interface StoreProjectsProps {
  api: LayerfsApi
  store: { name: string, kind: string, state?: string | null }
  /** The Store's project names (store.get), drawn while the ledgers are read. */
  names: readonly string[]
  projects: readonly StoreProject[] | undefined
  /** The Store's stored bytes (store.stats): a row's bar is its share of them. */
  stored: number | null
  /** Every Store, to tell a bare project name in a Sandbox apart (HomeCards sandboxesOfProject). */
  stores: readonly StoreRow[]
  fleet: AvailableView | null
  t: StorageT
  now: number
  tick: number
  canAdd: boolean
  onAdd: () => void
  /** Open a page by its id (the project, a Sandbox). */
  onOpen: (id: TabId) => void
}

export function StoreProjects({ api, store, names, projects, stored, stores, fleet, t, now, tick, canAdd, onAdd, onOpen }: StoreProjectsProps): ReactNode {
  const [query, setQuery] = useState('')
  const [order, setOrder] = useState<ProjectOrder>('session')
  // Until the host answers, a row per name with no figures.
  const rows: readonly StoreProject[] = projects ?? names.map(placeholderProject)
  const keys = names.map((n) => `${store.name}/${n}`)
  const sessions = useSessionLists(api, keys)
  const frozen = useSessionOrder(`store:${store.name}`, keys, sessions, order === 'session', tick)
  // Last session: the held order (rows never move while sessions run), the rest by recency until it exists
  const shown = order === 'session'
    ? byFrozen(orderProjects(rows, 'recent', query), frozen, (p) => `${store.name}/${p.name}`)
    : orderProjects(rows, order, query)
  const sandboxes: readonly MachineSandbox[] = fleet?.sandboxes ?? []
  const boxesOf = (name: string) => sandboxesOfProject(sandboxes, stores, store.name, name)
  const runningAll = names.reduce((a, n) => a + boxesOf(n).filter(sandboxRuns).length, 0)
  const commits = commitTotal(rows)
  const summary = [
    projects ? t(commitTotalWords(commits).key, { n: commitTotalWords(commits).n }) : null,
    stored && stored > 0 ? bytes(stored) : null,
    runningAll ? t('spRunningN', { n: String(runningAll) }) : null,
  ].filter(Boolean).join(' · ')
  const place = (machine: string | null | undefined) => (machine === 'native' ? t('groupHome') : machine ?? '?')
  return (
    <div className={css.stack}>
      <div className={css.toolbar}>
        <span className={css.muted}>{summary}</span>
        <span className={css.spacer} />
        {rows.length > 4 ? (
          <Input className={css.search} icon={<IconSearchOutlineRegular size={13} />} placeholder={t('searchProjects')} aria-label={t('searchProjects')}
            value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery('') } }} />
        ) : null}
        <Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={12} />} disabled={!canAdd} onClick={onAdd}>{t('addProject')}</Button>
      </div>
      {shown.length ? (
        <ProjectGrid api={api} t={t} now={now} label={t('tabProjects')} showStore={false} order={order} onOrder={setOrder} fleet={fleet} place={place} tick={tick} onOpen={onOpen}
          rows={shown.map((p) => ({
            key: `${store.name}/${p.name}`,
            store,
            p,
            boxes: boxesOf(p.name),
            share: stored && p.totals ? Math.min(1, p.totals.stored / stored) : null,
            sessions: sessions.lists.get(`${store.name}/${p.name}`) ?? null,
          }))} />
      ) : <p className={css.muted}>{query ? t('noMatchingProjects') : t('noProjects')}</p>}
    </div>
  )
}

/** `rows` in a held key order; rows the order does not know (new since) keep their place after it. Null: as given. */
function byFrozen<T>(rows: readonly T[], frozen: readonly string[] | null, keyOf: (row: T) => string): T[] {
  if (!frozen) return [...rows]
  const rank = new Map(frozen.map((k, i) => [k, i]))
  const of = (row: T) => rank.get(keyOf(row)) ?? Number.MAX_SAFE_INTEGER
  return rows.map((row, at) => ({ row, at })).sort((a, b) => of(a.row) - of(b.row) || a.at - b.at).map(({ row }) => row)
}
