/**
 * A Store's Projects tab: one square card per project. A card shows the
 * LayerFS glyph, Sandboxes running, the name, when it last committed, the
 * newest Commit's message (two lines) and Branch, then a 2×2 grid of Commits,
 * Branches, main's files and packed bytes, and its share of the Store as a
 * line along the bottom edge. A card opens the project page; adding a project
 * is the toolbar's.
 */
import { useState, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, IconSearchOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes, when } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { MenuSelect } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { commitTotal, filesNumber, hueOf, orderProjects, type ProjectOrder, type StoreProject } from './store-page.ts'
import css from './StorePage.module.css'

export interface StoreProjectsProps {
  store: string
  /** The Store's project names (store.get), drawn while the ledgers are read. */
  names: readonly string[]
  projects: readonly StoreProject[] | undefined
  /** The Store's stored bytes (store.stats): a card's line is its share of them. */
  stored: number | null
  running: ReadonlyMap<string, number>
  t: StorageT
  now: number
  canAdd: boolean
  onAdd: () => void
  onOpen: (key: string) => void
}

export function StoreProjects({ store, names, projects, stored, running, t, now, canAdd, onAdd, onOpen }: StoreProjectsProps): ReactNode {
  const [query, setQuery] = useState('')
  const [order, setOrder] = useState<ProjectOrder>('recent')
  // Until the host answers, a card per name with no figures.
  const rows: readonly StoreProject[] = projects ?? names.map((name) => ({ name, created: null, totals: null, last: null, files: null, partial: true, building: null, error: null }))
  const shown = orderProjects(rows, order, query)
  const sandboxes = [...running.values()].reduce((a, n) => a + n, 0)
  const commits = commitTotal(rows)
  return (
    <div className={css.stack}>
      <div className={css.toolbar}>
        <span className={css.muted}>
          {t(rows.length === 1 ? 'spProjectOne' : 'spProjects', { n: String(rows.length) })}
          {projects ? ` · ${t(commits.complete ? 'spCommitsTotal' : 'spCommitsCounting', { n: commits.commits.toLocaleString() })}` : ''}
          {sandboxes ? ` · ${t('spRunningN', { n: String(sandboxes) })}` : ''}
        </span>
        <span className={css.spacer} />
        {rows.length > 4 ? (
          <Input className={css.search} icon={<IconSearchOutlineRegular size={13} />} placeholder={t('searchProjects')} aria-label={t('searchProjects')}
            value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery('') } }} />
        ) : null}
        <MenuSelect<ProjectOrder> value={order} onChange={setOrder} label={t('spOrder')}
          options={[{ value: 'recent', label: t('spOrderRecent') }, { value: 'name', label: t('spOrderName') }, { value: 'size', label: t('spOrderSize') }]} />
        <Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={12} />} disabled={!canAdd} onClick={onAdd}>{t('addProject')}</Button>
      </div>
      {shown.length ? (
        <ul className={css.cards} aria-label={t('tabProjects')}>
          {shown.map((p) => (
            <li key={p.name}>
              <ProjectCard p={p} hue={hueOf(p.name, rows)} share={stored && p.totals ? Math.min(1, p.totals.stored / stored) : 0} running={running.get(p.name) ?? 0} t={t} now={now} onOpen={() => onOpen(`${store}/${p.name}`)} />
            </li>
          ))}
        </ul>
      ) : <p className={css.muted}>{query ? t('noMatchingProjects') : t('noProjects')}</p>}
    </div>
  )
}

function ProjectCard({ p, hue, share, running, t, now, onOpen }: { p: StoreProject, hue: number, share: number, running: number, t: StorageT, now: number, onOpen: () => void }): ReactNode {
  const tt = t as Translate
  const at = p.last?.time ?? null
  const counting = p.partial && p.building
  const files = filesNumber(p.files)
  return (
    <button type="button" className={css.card} onClick={onOpen} aria-label={t('openProject', { name: p.name })} data-project-card={p.name}>
      <span className={css.cardTop}>
        <LayerfsGlyph size={22} />
        {running ? <span className={css.runningPill} title={t('spRunningN', { n: String(running) })}><i aria-hidden="true" />{t('spRunningN', { n: String(running) })}</span> : null}
      </span>
      <span className={css.cardName} title={p.name}>{p.name}</span>
      <span className={css.cardWhen} title={when(at ?? p.created)}>{at !== null ? ago(at, now, tt) : p.created !== null ? t('createdAgo', { ago: ago(p.created, now, tt) }) : '\u00a0'}</span>
      <span className={css.cardBody}>
        {p.last ? (
          <>
            <span className={css.cardMessage} title={p.last.message || undefined}>{p.last.message || t('spNoMessage')}</span>
            <span className={css.cardBranch}>{p.last.branch}</span>
          </>
        ) : (
          <span className={css.cardQuiet}>{p.totals ? t('spNoCommits') : counting ? t('spCounting', { n: String(p.building!.saves) }) : p.error ? p.error.message : t('spReading')}</span>
        )}
      </span>
      <span className={css.cardStats}>
        <Stat value={p.totals ? p.totals.saves.toLocaleString() : null} label={t('spStatCommits')} />
        <Stat value={p.totals ? String(p.totals.branches) : null} label={t('spStatBranches')} />
        <Stat value={files} label={t('spStatFiles')} />
        <Stat value={p.totals && p.totals.stored > 0 ? bytes(p.totals.stored) : null} label={t('spStatSize')} />
      </span>
      <span className={css.cardShare} aria-hidden="true"><span data-hue={hue} style={{ width: `${(share * 100).toFixed(1)}%` }} /></span>
    </button>
  )
}

function Stat({ value, label }: { value: string | null, label: string }): ReactNode {
  return <span className={css.stat}><b>{value ?? '—'}</b><span>{label}</span></span>
}
