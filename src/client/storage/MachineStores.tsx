/**
 * The machine page's Stores tab (machine-stores.ts holds the data).
 *
 * Two tiles at the top switch between the machine's SQLite Stores (the file
 * lives on its disk: push and pull move it) and the PostgreSQL Stores
 * attached to it (the data stays on its server: attach and detach change
 * which machines dial it). The choice is remembered per viewer and machine.
 *
 * Both kinds draw the same card, split by the Store's projects:
 *
 *   head      name (opens the Store) · size and its backups badge (SQLite),
 *             or the last check's version and time (PostgreSQL) · ⋯
 *   sub       where it is · the newest Commit of any project
 *   bar       each project's packed bytes; a SQLite bar ends with the part of
 *             the file no project accounts for
 *   rows      up to three projects (the LayerFS mark): bytes, with the bar's
 *             color, and newest Commit (opens it)
 *   foot      its state (idle, in use, reachable…) · text actions
 *
 * The backups badge counts the Store's bucket copies, marks their providers
 * and dots the worst state; it opens Backups (BackupDialogs.tsx). A transfer
 * this host runs replaces the foot with its progress.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import { ago, bytes, when } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { Card, LinkButton } from '../ui/index.tsx'
import { useQuery } from '../ui/use-query.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { BucketMark } from './BucketPage.tsx'
import { JobPanel, OpPanel } from './JobProgress.tsx'
import type { StorageT } from './locale.ts'
import { failedStep, machineStores, projectSplit, routedServer, startKind, type ProjectSplit, type StoreKind } from './machine-stores.ts'
import { cardJob, loopbackAlias } from './model.ts'
import { StoreGlyph } from './parts.tsx'
import { StoreMenu, type StoreActions } from './StoreCard.tsx'
import { backupCounts, backupProviders, storeBackups } from './store-backups.ts'
import type { StoreProjectsView } from './store-page.ts'
import type { PgAttachment, StorageJob, StorageView, StoreRow } from './types.ts'
import css from './MachineStores.module.css'

const COUNTING_POLL_MS = 2000
const ROWS = 3

const KIND_KEY = 'layerfs.machineStoreKind'

function readKind(machine: string): StoreKind | null {
  try {
    const v = (JSON.parse(localStorage.getItem(KIND_KEY) ?? '{}') as Record<string, unknown>)[machine]
    return v === 'sqlite' || v === 'postgresql' ? v : null
  } catch { return null }
}

function writeKind(machine: string, kind: StoreKind): void {
  try {
    const all = JSON.parse(localStorage.getItem(KIND_KEY) ?? '{}') as Record<string, unknown>
    localStorage.setItem(KIND_KEY, JSON.stringify({ ...all, [machine]: kind }))
  } catch { /* the tile still switches */ }
}

export interface MachineStoresProps {
  api: LayerfsApi
  machine: string
  view: StorageView
  t: StorageT
  jobs: readonly StorageJob[]
  dismissed: ReadonlySet<string>
  now: number
  actionsFor: (s: StoreRow) => StoreActions
  /** Add Store's SQLite side: push a Store to this machine. */
  onPushHere: (machine: string) => void
  /** Connect a database: attach a connected one, or connect a new one and attach it. */
  onConnect: (machine: string) => void
  onOpenStore: (name: string) => void
  /** Opens a project, by `store/project`. */
  onOpenProject: (key: string) => void
  /** Opens the Backups dialog of a SQLite Store. */
  onBackups: (store: string) => void
}

export function MachineStores(props: MachineStoresProps): ReactNode {
  const { machine, view, t } = props
  const stores = machineStores(view, machine, t)
  const [kind, setKindState] = useState<StoreKind>(() => startKind(stores, readKind(machine)))
  const setKind = (k: StoreKind) => { setKindState(k); writeKind(machine, k) }
  const place = machine === 'native' ? t('layerfsHome') : machine
  const tiles: { kind: StoreKind, label: string, figure: string, why: string | null }[] = [
    {
      kind: 'sqlite', label: t('sqlite'),
      figure: stores.sqlite.length ? [t(stores.sqlite.length === 1 ? 'msStoreOne' : 'msStores', { n: stores.sqlite.length }), stores.sqliteBytes != null && bytes(stores.sqliteBytes)].filter(Boolean).join(' · ') : t('msNone'),
      why: stores.sqlite.length ? null : stores.noSqlite,
    },
    {
      kind: 'postgresql', label: t('postgresql'),
      figure: stores.postgresql.length ? t(stores.postgresql.length === 1 ? 'msDatabaseOne' : 'msDatabases', { n: stores.postgresql.length }) : t('msNone'),
      why: stores.postgresql.length ? null : stores.noPostgresql,
    },
  ]
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const next = kind === 'sqlite' ? 'postgresql' : 'sqlite'
    setKind(next)
    document.getElementById(`lfs-ms-${machine}-${next}`)?.focus()
  }
  const sqlite = kind === 'sqlite'
  return (
    <div className={css.stack} data-machine-stores={machine}>
      <div className={css.tiles} role="tablist" aria-label={t('msKindLabel')} onKeyDown={onKey}>
        {tiles.map((tile) => (
          <button key={tile.kind} id={`lfs-ms-${machine}-${tile.kind}`} type="button" role="tab" className={css.tile}
            aria-selected={kind === tile.kind} tabIndex={kind === tile.kind ? 0 : -1} aria-controls={`lfs-ms-${machine}-panel`}
            onClick={() => setKind(tile.kind)} data-store-kind={tile.kind}>
            <span className={css.tileHead}>
              <StoreGlyph kind={tile.kind} size={16} />
              <span className={css.tileLabel}>{tile.label}</span>
              <span className={css.tileRole}>{tile.kind === 'sqlite' ? t('msHeldHere') : t('msAttached')}</span>
            </span>
            <span className={css.tileFigure}>{tile.figure}</span>
            {tile.why ? <span className={css.tileNote}>{tile.why}</span> : null}
          </button>
        ))}
      </div>
      <section id={`lfs-ms-${machine}-panel`} role="tabpanel" aria-labelledby={`lfs-ms-${machine}-${kind}`} className={css.panel}>
        <div className={css.panelHead}>
          <span className={css.panelNote}>{sqlite ? (machine === 'native' ? t('msSqliteBodyHome') : t('msSqliteBody', { machine: place })) : t('msPgBody', { machine: place })}</span>
          {sqlite ? (
            <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} disabled={!!stores.noSqlite} title={stores.noSqlite ?? undefined}
              onClick={() => props.onPushHere(machine)}>{machine === 'native' ? t('msAddSqliteHome') : t('msPushHere')}</Button>
          ) : (
            <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} disabled={!!stores.noPostgresql || view.features?.attach !== true}
              title={stores.noPostgresql ?? (view.features?.attach !== true ? t('attachUnsupported') : undefined)}
              onClick={() => props.onConnect(machine)}>{t('connectDatabase')}</Button>
          )}
        </div>
        {sqlite
          ? stores.sqlite.length
            ? <div className={css.grid}>{stores.sqlite.map((s) => <SqliteCard key={s.name} s={s} {...props} />)}</div>
            : <p className={css.empty}>{stores.noSqlite ?? t('msSqliteEmpty', { machine: place })}</p>
          : stores.postgresql.length
            ? <div className={css.grid}>{stores.postgresql.map(({ store, attachment }) => <PgCard key={store.name} s={store} a={attachment} {...props} />)}</div>
            : <p className={css.empty}>{stores.noPostgresql ?? t('msPgEmpty', { machine: place })}</p>}
      </section>
    </div>
  )
}


/**
 * The Store's projects, as the Store page reads them (shared cache), read
 * again only while a ledger is being counted (`building`): a project that
 * could not be read (no job, perhaps an error) is not polled.
 */
function useSplit(api: LayerfsApi, s: StoreRow, total: number | null): ProjectSplit | null {
  const q = useQuery(() => api.call<StoreProjectsView>('GET', `/api/stores/${enc(s.name)}/projects`), [api, s.name],
    { refresh: [s.projects.length, s.size?.bytes], cache: `store-projects:${s.name}` })
  const counting = q.data?.projects.some((p) => p.building) ?? false
  useEffect(() => {
    if (!counting) return
    const timer = setTimeout(q.reload, COUNTING_POLL_MS)
    return () => clearTimeout(timer)
  }, [counting, q.data, q.reload])
  return q.data ? projectSplit(q.data.projects, total) : null
}

function Head({ s, on, t, machine, onOpenStore, children }: { s: StoreRow, on: StoreActions, t: StorageT, machine?: string, onOpenStore: (name: string) => void, children: ReactNode }): ReactNode {
  return (
    <div className={css.head}>
      <StoreGlyph kind={s.kind} size={15} />
      <LinkButton className={css.name} onClick={() => onOpenStore(s.name)} title={s.name}>{s.name}</LinkButton>
      {children}
      <StoreMenu store={s} on={on} t={t} machine={machine} />
    </div>
  )
}

/** The bar and up to three rows: each project's packed bytes and newest Commit. */
function Projects({ s, split, t, now, onOpenProject, onOpenStore }: { s: StoreRow, split: ProjectSplit | null, t: StorageT, now: number, onOpenProject: (key: string) => void, onOpenStore: (name: string) => void }): ReactNode {
  const tt = t as Translate
  if (!s.projects.length) return <p className={css.none}>{t('msNoProjects')}</p>
  const rows = split?.rows ?? [...s.projects].sort().map((name) => ({ name, bytes: null, share: 0, hue: 0, at: null, counting: true, error: null }))
  return (
    <>
      <div className={css.bar} role="img" aria-label={rows.filter((r) => r.share > 0).map((r) => `${r.name} ${bytes(r.bytes ?? 0)}`).join(', ') || t('colProjects')}>
        {rows.filter((r) => r.share > 0).map((r) => <span key={r.name} data-hue={r.hue} style={{ flex: r.share }} title={`${r.name} · ${bytes(r.bytes ?? 0)}`} />)}
        {split && split.rest > 0 ? <span className={css.barRest} style={{ flex: split.rest }} title={t('msBarRest')} /> : null}
      </div>
      <ul className={css.projects}>
        {rows.slice(0, ROWS).map((r) => (
          <li key={r.name}>
            <button type="button" className={css.project} onClick={() => onOpenProject(`${s.name}/${r.name}`)} title={t('msOpenProject', { project: r.name })}>
              <span className={css.projectIcon}><LayerfsGlyph size={14} /></span>
              <span className={css.projectName}>{r.name}</span>
              <span className={css.projectMeta}>
                {r.share > 0 ? <span className={css.swatch} data-hue={r.hue} aria-hidden="true" /> : null}
                {r.bytes === null ? (r.counting ? t('spReading') : <span title={r.error ?? t('msNotCounted')}>—</span>) : r.at === null ? t('spNoCommits') : `${bytes(r.bytes)} · ${ago(r.at, now, tt)}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {rows.length > ROWS ? <LinkButton className={css.more} onClick={() => onOpenStore(s.name)}>{t('msProjectsMore', { n: rows.length - ROWS })}</LinkButton> : null}
    </>
  )
}

/** The backups badge: provider marks, the count and the worst state's dot; "No backup" when there is none. */
function BackupsBadge({ s, view, t, onBackups, onBackup }: { s: StoreRow, view: StorageView, t: StorageT, onBackups: () => void, onBackup: () => void }): ReactNode {
  const backups = storeBackups(s, view.buckets)
  if (!backups.length) return <button type="button" className={css.badge} data-none onClick={onBackup}>{t('noBackup')}</button>
  const n = backupCounts(backups)
  const worst = n.problem ? 'problem' : n.stale ? 'stale' : n.unknown ? 'unknown' : 'current'
  const providers = backupProviders(backups)
  return (
    <button type="button" className={css.badge} onClick={onBackups} aria-label={`${t('msBackupsOpen', { store: s.name, n: backups.length })}. ${t('bkHealth', n)}`} title={t('bkHealth', n)}>
      <span className={css.marks}>{providers.slice(0, 3).map((p) => <span key={p ?? '?'} className={css.mark}><BucketMark provider={p} size={12} /></span>)}</span>
      {backups.length}
      <span className={css.dot} data-health={worst} />
    </button>
  )
}

/** Text actions, separated by dots. */
function Actions({ items }: { items: ({ label: string, run: () => void, disabled?: boolean } | null)[] }): ReactNode {
  const shown = items.filter((x): x is NonNullable<typeof x> => !!x)
  return (
    <span className={css.textActions}>
      {shown.map((a, i) => (
        <span key={a.label} className={css.textActionItem}>
          {i ? <span aria-hidden="true">·</span> : null}
          <button type="button" className={css.textAction} disabled={a.disabled} onClick={a.run}>{a.label}</button>
        </span>
      ))}
    </span>
  )
}

function SqliteCard({ s, api, t, view, jobs, dismissed, now, actionsFor, onOpenStore, onOpenProject, onBackups }: MachineStoresProps & { s: StoreRow }): ReactNode {
  const on = actionsFor(s)
  const job = cardJob(jobs, s.name, dismissed, now)
  const split = useSplit(api, s, s.size?.bytes ?? null)
  const busy = s.state === 'busy' || s.state === 'down' || !!job && !job.ended
  const place = s.machine === 'native' ? t('layerfsHome') : s.machine ?? '?'
  const state = s.down ? <span className={css.danger} title={s.down}>{s.down}</span>
    : s.state === 'in_use' ? <span className={css.warning}>{s.holders > 0 ? t('msInUseHolders', { n: s.holders }) : t('msInUse')}</span>
      : s.state === 'unresolved' ? <span className={css.warning}>{t('unresolved')}</span>
        : <span>{t('msIdle')}</span>
  return (
    <Card className={css.card} data-store={s.name} data-kind="sqlite">
      <Head s={s} on={on} t={t} onOpenStore={onOpenStore}>
        <span className={css.size} title={s.size ? `${bytes(s.size.file)} + WAL ${bytes(s.size.wal)}` : undefined}>{s.size ? bytes(s.size.bytes) : t('sizeUnavailable')}</span>
        <BackupsBadge s={s} view={view} t={t} onBackups={() => onBackups(s.name)} onBackup={on.backup} />
      </Head>
      <span className={css.sub}>{[t('msOn', { place }), split?.lastWrite ? t('msLastWrite', { when: ago(split.lastWrite, now, t as Translate) }) : null].filter(Boolean).join(' · ')}</span>
      <Projects s={s} split={split} t={t} now={now} onOpenProject={onOpenProject} onOpenStore={onOpenStore} />
      {job ? <JobPanel job={job} t={t} onRetry={() => on.retry(job)} onDismiss={() => on.dismiss(job)} /> : s.op ? <OpPanel store={s} t={t} /> : null}
      {job && !job.ended ? null : (
        <div className={css.foot}>
          <span className={css.state}>{state}</span>
          <Actions items={s.machine === 'native'
            ? [{ label: t('pushTo'), run: on.push, disabled: s.state !== 'idle' }, { label: t('msBackUp'), run: on.backup, disabled: s.state === 'down' || s.state === 'busy' }]
            : [{ label: t('msPull'), run: on.pull, disabled: busy }, { label: t('msMoveTo'), run: on.move, disabled: busy }, { label: t('msBackUp'), run: on.backup, disabled: s.state === 'down' || s.state === 'busy' }]} />
        </div>
      )}
    </Card>
  )
}

/** A failed check in a few words: the step LayerFS names (machine-stores.ts `failedStep`), else its code. */
function failWords(e: { code: string, message: string }, t: StorageT): string {
  switch (failedStep(e.code, e.message)) {
    case 'server': return t('msFailServer')
    case 'store': return t('msFailStore')
    case 'write': return t('msFailWrite')
    default: return e.code
  }
}

/** A PostgreSQL target's server: `user@host:port/db` gives `host:port`. */
function serverOf(target: string | null | undefined): string | null {
  if (!target) return null
  const rest = target.slice(target.indexOf('@') + 1)
  const slash = rest.indexOf('/')
  return slash >= 0 ? rest.slice(0, slash) : rest
}

/** The server `machine` dials: its own connection's, else the Store's with a loopback host renamed for the machine (host.docker.internal…). */
function dialedServer(s: StoreRow, a: PgAttachment, platform: string | undefined): string | null {
  if (a.own && a.target) return serverOf(a.target)
  const server = serverOf(s.postgresql?.target)
  return server ? routedServer(server, platform ? loopbackAlias(platform) : null) : null
}

function PgCard({ s, a, api, machine, t, view, now, actionsFor, onOpenStore, onOpenProject }: MachineStoresProps & { s: StoreRow, a: PgAttachment }): ReactNode {
  const on = actionsFor(s)
  const split = useSplit(api, s, null)
  const failed = !!a.lastError
  const tt = t as Translate
  const target = a.own && a.target ? a.target : s.postgresql?.target ?? null
  const server = dialedServer(s, a, view.machines.find((m) => m.name === machine)?.platform)
  const checked = a.checked
  return (
    <Card className={css.card} data-store={s.name} data-kind="postgresql" tone={failed ? 'danger' : undefined}>
      <Head s={s} on={on} t={t} machine={machine} onOpenStore={onOpenStore}>
        {failed
          ? <span className={css.check} data-state="failed" title={`${a.lastError!.code}: ${a.lastError!.message}`}>{failWords(a.lastError!, t)}<span className={css.dot} data-health="problem" /></span>
          : checked
            ? <span className={css.check} title={checked.version ?? undefined}>{t('msCheckOk', { latency: checked.latencyMs ?? '—', version: (checked.version ?? '?').split(' ')[0]! })}<span className={css.dot} data-health="current" /></span>
            : <span className={css.check}>{t('msNotCheckedShort')}<span className={css.dot} data-health="unknown" /></span>}
      </Head>
      <span className={css.sub} title={target ?? undefined}>{[server ? t('msOn', { place: server }) : null, split?.lastWrite ? t('msLastWrite', { when: ago(split.lastWrite, now, tt) }) : null].filter(Boolean).join(' · ') || t('postgresql')}</span>
      <Projects s={s} split={split} t={t} now={now} onOpenProject={onOpenProject} onOpenStore={onOpenStore} />
      <div className={css.foot}>
        <span className={css.state} title={failed ? when(a.lastError!.at) : checked?.at ? when(checked.at) : undefined}>
          {failed ? <span className={css.danger}>{t('msNotReached', { when: ago(a.lastError!.at, now, tt) })}</span>
            : checked ? t('msReachableAt', { when: checked.at ? ago(checked.at, now, tt) : '—' }) : t('msNotCheckedShort')}
        </span>
        <Actions items={failed
          ? [{ label: t('msEdit'), run: () => on.attach(machine, a) }, { label: t('msCheckAgain'), run: () => on.recheck(a) }]
          : [{ label: t('msCheckAgain'), run: () => on.recheck(a) }, { label: t('msEdit'), run: () => on.attach(machine, a) }]} />
      </div>
    </Card>
  )
}
