/**
 * The Storage explorer: an IDE-style sidebar. A Store is a folder of project
 * files, a bucket a folder of Store files; the outline's groups are where the
 * Stores live (the home, machines, PostgreSQL) and the backup buckets.
 * Clicking a row opens its page as an editor tab; a chevron only expands.
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronRightOutlineRegular, IconDatabaseOutlineRegular, IconFolderCloseRegular,
  IconFolderOpenOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular,
  Input, StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StorageT } from './locale.ts'
import { attentionOf, backupChip, bucketFiles, cardJob, groupOf, orderStores } from './model.ts'
import type { BucketRow, StorageJob, StorageView, StoreRow } from './types.ts'
import css from './Storage.module.css'

/** A page the editor can hold: the overview, a Store, a project or a bucket. */
export type TabId = 'overview' | `store:${string}` | `project:${string}` | `bucket:${string}`

/** A tree key that can expand: a group, a Store folder or a bucket folder. */
export type TreeKey = `g:${string}` | `s:${string}` | `b:${string}`

/** A project's or backup file's glyph: a document with a folded corner. */
export function FileGlyph({ size = 14 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      <path d="M4 1.75h4.75L13.25 6.25v8h-9.25z" />
      <path d="M8.75 1.75V6.25h4.5" />
    </svg>
  )
}

/** A folder row's glyph: closed while folded, open while expanded. */
const folderIcon = (open: boolean): ReactNode =>
  open ? <IconFolderOpenOutlineRegular size={15} /> : <IconFolderCloseRegular size={15} />

interface RowProps {
  depth: number
  icon?: ReactNode
  label: ReactNode
  meta?: ReactNode
  /** The row is a folder: show its chevron; `open` drives it. */
  expandable?: boolean
  open?: boolean
  /** The row's page is the editor's active tab. */
  active?: boolean
  /** The row is one of the outline's section heads. */
  group?: boolean
  title?: string
  onToggle?: () => void
  onOpen?: () => void
  actions?: ReactNode
  /** Nested rows (a `role="group"` list) when the row is expanded. */
  children?: ReactNode
}

function Row({ depth, icon, label, meta, expandable, open, active, group, title, onToggle, onOpen, actions, children }: RowProps): ReactNode {
  return (
    <li role="none">
      <div
        className={clsx(css.treeRow, group && css.treeGroupRow)}
        role="treeitem"
        aria-expanded={expandable ? !!open : undefined}
        aria-selected={active || undefined}
        data-active={active || undefined}
        style={{ paddingLeft: 4 + depth * 14 }}
        title={title}
      >
        {expandable ? (
          <button type="button" className={css.treeChevron} tabIndex={-1} aria-hidden="true" onClick={onToggle}>
            <IconChevronRightOutlineRegular size={11} className={clsx(css.treeChevronIcon, open && css.treeChevronOpen)} />
          </button>
        ) : <span className={css.treeChevron} aria-hidden="true" />}
        <button type="button" className={css.treeHit} onClick={expandable ? onOpen ?? onToggle : onOpen}>
          {icon ? <span className={css.treeIcon} aria-hidden="true">{icon}</span> : null}
          <span className={css.treeLabel}>{label}</span>
        </button>
        {meta ? <span className={css.treeMeta}>{meta}</span> : null}
        {actions ? <span className={css.treeActions}>{actions}</span> : null}
      </div>
      {children}
    </li>
  )
}

export interface ExplorerProps {
  view: StorageView
  t: StorageT
  now: number
  jobs: readonly StorageJob[]
  dismissed: ReadonlySet<string>
  active: TabId | null
  expanded: ReadonlySet<string>
  query: string
  /** A manual refresh is in flight. */
  refreshing: boolean
  listing: string | null
  listingAll: boolean
  onQuery: (query: string) => void
  onToggle: (key: TreeKey) => void
  onOpen: (id: TabId) => void
  onRefresh: () => void
  onNewStore: () => void
  onListAll: () => void
  onAddBucket: () => void
}

export function Explorer({ view, t, now, jobs, dismissed, active, expanded, query, refreshing, listing, listingAll, onQuery, onToggle, onOpen, onRefresh, onNewStore, onListAll, onAddBucket }: ExplorerProps): ReactNode {
  const q = query.trim().toLowerCase()
  const isOpen = (key: TreeKey) => q !== '' || expanded.has(key)
  const stores = orderStores(view.stores)
  const rows = stores.map((s) => {
    const hit = !q || `${s.name} ${s.kind} ${s.machine ?? ''} ${s.postgresql?.target ?? ''}`.toLowerCase().includes(q)
    const projects = s.projects.filter((p) => hit || p.toLowerCase().includes(q)).sort()
    return { s, projects, show: hit || projects.length > 0 }
  }).filter((x) => x.show)
  const buckets = view.buckets.filter((b) => !q || b.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name))
  const groups = [
    { key: 'g:home' as TreeKey, id: 'home', title: t('groupHome') },
    { key: 'g:machines' as TreeKey, id: 'machines', title: t('groupMachines') },
    { key: 'g:postgresql' as TreeKey, id: 'postgresql', title: t('groupPostgresql') },
  ]
  return (
    <aside className={css.side} aria-label={t('panel')}>
      <div className={css.sideHead}>
        <h2 className={css.sideTitle}>{t('panel')}</h2>
        <span className={css.sideActions}>
          <Button variant="ghost" size="sm" className={css.sideButton} aria-label={t('refresh')} title={t('refresh')} disabled={refreshing}
            icon={refreshing ? <StateDot state="ongoing" size={13} /> : <IconRefreshOutlineRegular size={14} />} onClick={onRefresh} />
          <Button variant="ghost" size="sm" className={css.sideButton} aria-label={t('newStore')} title={t('newStore')}
            icon={<IconPlusOutlineRegular size={14} />} onClick={onNewStore} />
        </span>
      </div>
      <div className={css.sideSearch}>
        <Input icon={<IconSearchOutlineRegular size={13} />} placeholder={t('searchPlaceholder')} aria-label={t('searchPlaceholder')}
          value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); onQuery('') } }} />
      </div>
      <div className={css.treeScroll}>
        <ul className={css.tree} role="tree" aria-label={t('treeLabel')}>
          <Row depth={0} icon={<IconDatabaseOutlineRegular size={14} />} label={t('overview')} active={active === 'overview'} onOpen={() => onOpen('overview')} />
          {stores.length === 0 || rows.length === 0 ? (
            <li role="none"><p className={css.treeHint}>{stores.length === 0 ? t('noStores') : t('nothingMatches')}</p></li>
          ) : groups.map((g) => {
            const members = rows.filter((x) => groupOf(x.s) === g.id)
            if (!members.length) return null
            const open = isOpen(g.key)
            return (
              <Row key={g.key} depth={0} group expandable open={open} label={g.title} meta={String(members.length)} onToggle={() => onToggle(g.key)}>
                {open ? (
                  <ul role="group" className={css.treeLevel}>
                    {members.map(({ s, projects }) => (
                      <StoreNode key={s.name} store={s} projects={projects} view={view} t={t} now={now} jobs={jobs} dismissed={dismissed}
                        active={active} open={isOpen(`s:${s.name}`)} onToggle={onToggle} onOpen={onOpen} />
                    ))}
                  </ul>
                ) : null}
              </Row>
            )
          })}
          <Row depth={0} group expandable open={isOpen('g:backups')} label={t('tabBackups')} meta={String(view.buckets.length)}
            onToggle={() => onToggle('g:backups')}
            actions={(
              <>
                <Button variant="ghost" size="sm" className={css.sideButton} aria-label={t('listAll')} title={t('listAll')}
                  disabled={listingAll || view.buckets.length === 0}
                  icon={listingAll ? <StateDot state="ongoing" size={13} /> : <IconRefreshOutlineRegular size={13} />} onClick={onListAll} />
                <Button variant="ghost" size="sm" className={css.sideButton} aria-label={t('addBucket')} title={t('addBucket')}
                  icon={<IconPlusOutlineRegular size={13} />} onClick={onAddBucket} />
              </>
            )}>
            {isOpen('g:backups') ? (
              <ul role="group" className={css.treeLevel}>
                {buckets.length === 0 ? (
                  <li role="none"><p className={css.treeHint}>{t('noBuckets')}</p></li>
                ) : buckets.map((b) => (
                  <BucketNode key={b.name} bucket={b} stores={view.stores} t={t} active={active} listing={listing === b.name}
                    open={isOpen(`b:${b.name}`)} onToggle={onToggle} onOpen={onOpen} />
                ))}
              </ul>
            ) : null}
          </Row>
        </ul>
      </div>
    </aside>
  )
}

function StoreNode({ store: s, projects, view, t, now, jobs, dismissed, active, open, onToggle, onOpen }: {
  store: StoreRow, projects: readonly string[], view: StorageView, t: StorageT, now: number
  jobs: readonly StorageJob[], dismissed: ReadonlySet<string>, active: TabId | null, open: boolean
  onToggle: (key: TreeKey) => void, onOpen: (id: TabId) => void
}): ReactNode {
  const job = cardJob(jobs, s.name, dismissed, now)
  const machineState = view.machines.find((m) => m.name === s.machine)?.state
  const attention = attentionOf(s, machineState, view.buckets)
  const dot: StateDotState | null = job && !job.ended ? 'ongoing'
    : (job?.error || attention === 'danger') ? 'error'
    : attention === 'warning' ? 'warning' : null
  const key = `s:${s.name}` as TreeKey
  return (
    <Row depth={1} expandable open={open} icon={folderIcon(open)} label={s.name} meta={s.projects.length ? String(s.projects.length) : undefined}
      active={active === `store:${s.name}`} onToggle={() => onToggle(key)} onOpen={() => onOpen(`store:${s.name}`)}
      actions={dot ? <StateDot state={dot} size={12} /> : undefined}>
      {open ? (
        <ul role="group" className={css.treeLevel}>
          {projects.length === 0 ? (
            <li role="none"><p className={css.treeHint}>{t('noProjects')}</p></li>
          ) : projects.map((p) => (
            <Row key={p} depth={2} icon={<FileGlyph />} label={p} active={active === `project:${s.name}/${p}`} onOpen={() => onOpen(`project:${s.name}/${p}`)} />
          ))}
        </ul>
      ) : null}
    </Row>
  )
}

function BucketNode({ bucket: b, stores, t, active, listing, open, onToggle, onOpen }: {
  bucket: BucketRow, stores: readonly StoreRow[], t: StorageT, active: TabId | null, listing: boolean, open: boolean
  onToggle: (key: TreeKey) => void, onOpen: (id: TabId) => void
}): ReactNode {
  const key = `b:${b.name}` as TreeKey
  const rows = bucketFiles(b, stores)
  return (
    <Row depth={1} expandable open={open} icon={folderIcon(open)} label={b.name}
      meta={listing ? undefined : b.files ? String(b.files.length) : undefined}
      active={active === `bucket:${b.name}`} onToggle={() => onToggle(key)} onOpen={() => onOpen(`bucket:${b.name}`)}
      actions={listing ? <StateDot state="ongoing" size={12} /> : undefined}>
      {open ? (
        <ul role="group" className={css.treeLevel}>
          {rows.length === 0 ? (
            <li role="none"><p className={css.treeHint}>{b.files ? t('bucketEmptyListed') : listing ? t('bucketListing') : t('bucketEmptyUnlisted')}</p></li>
          ) : rows.map((r) => {
            const chip = backupChip(r.state, t)
            const dot: StateDotState | null = chip.tone === 'danger' ? 'error' : chip.tone === 'warning' ? 'warning' : null
            return (
              <Row key={`${r.file}:${r.storeName ?? ''}`} depth={2} icon={<FileGlyph />} label={r.file} title={r.reason ?? undefined}
                active={active === `bucket:${b.name}`} onOpen={() => onOpen(`bucket:${b.name}`)}
                actions={dot ? <StateDot state={dot} size={12} /> : undefined} />
            )
          })}
        </ul>
      ) : null}
    </Row>
  )
}
