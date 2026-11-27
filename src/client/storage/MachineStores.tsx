/**
 * A machine page's Stores tab. Two tiles at the top switch between SQLite
 * Stores (the file lives on this machine's disk: push and pull move it) and
 * PostgreSQL Stores (the data stays on its server). The choice is remembered
 * per viewer and machine.
 *
 * SQLite Stores are cards, split by the Store's projects:
 *
 *   head      name (opens the Store) · ⋯
 *   figure    the file's size; small words beside it (last write)
 *   rows      up to three projects (the LayerFS mark), each with its bytes and
 *             its own bar: its share of the file
 *   status    only when something is happening: a transfer, in use, down
 *   foot      the backups badge and one action
 *
 * PostgreSQL is the attach view reversed (docs/specs/store-home-rows.md): the
 * Stores attached to this machine, one row each with this machine's reach and
 * Detach, and `+ Attach Store`, the attach picker listing Stores.
 *
 * The backups badge counts the Store's bucket copies, marks their providers
 * and dots the worst state; it opens Backups (BackupDialogs.tsx).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { IconPlusOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { StatusDot } from '../ui/StatusDot.tsx'
import { enc, type LayerfsApi } from '../api.ts'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { Card, ExplainedButton, LinkButton, MoreMenu } from '../ui/index.tsx'
import { useQuery } from '../ui/use-query.ts'
import { BucketMark } from './BucketPage.tsx'
import { JobPanel, OpPanel } from './JobProgress.tsx'
import type { StorageT } from './locale.ts'
import { machineStores, projectSplit, startKind, type ProjectSplit, type StoreKind } from './machine-stores.ts'
import { cardJob, storeNoticeTone, storeWaitsFor } from './model.ts'
import { SandboxGlyph } from '../machines/icons.tsx'
import { StoreGlyph } from './parts.tsx'
import { StoreAction, StoreMenu, stoppedBlock, storeNotice, useStoreTip, type StoreActions } from './StoreCard.tsx'
import { backupCounts, backupProviders, storeBackups } from './store-backups.ts'
import type { StoreProjectsView } from './store-page.ts'
import { pgAddress, reachStatus } from './store-rows.ts'
import { CopyAddress, ReachWord } from './StoreRows.tsx'
import { readStoreKind, writeStoreKind } from './tabs.ts'
import type { StorageJob, StorageView, StoreRow } from './types.ts'
import rowsCss from './StoreRows.module.css'
import css from './MachineStores.module.css'
import { isHostName } from '../../shared/host-machine.ts'

const COUNTING_POLL_MS = 2000
const ROWS = 3

export interface MachineStoresProps {
  api: LayerfsApi
  machine: string
  view: StorageView
  t: StorageT
  jobs: readonly StorageJob[]
  dismissed: ReadonlySet<string>
  now: number
  actionsFor: (s: StoreRow) => StoreActions
  /** The Sandboxes the Machines view knows: a PostgreSQL row counts this machine's Sandboxes of the Store. */
  sandboxes?: readonly { machine?: string | null, project?: string | null }[] | undefined
  /** Add Store's SQLite side: push a Store to this machine. */
  onPushHere: (machine: string) => void
  /** + Attach Store: the attach picker listing the PostgreSQL Stores not attached here. */
  onAttachStore: (machine: string) => void
  /** The PostgreSQL Stores with a Sandbox on this machine now (the Machines view knows): listed beside those attached here. */
  busy?: ReadonlySet<string> | undefined
  onOpenStore: (name: string) => void
  /** Opens a project, by `store/project`. */
  onOpenProject: (key: string) => void
  /** Opens the Backups dialog of a SQLite Store. */
  onBackups: (store: string) => void
}

/** What every Store card needs; `machine` is the machine page the card is on. */
interface CardProps {
  api: LayerfsApi
  machine: string
  view: StorageView
  t: StorageT
  jobs: readonly StorageJob[]
  dismissed: ReadonlySet<string>
  now: number
  actionsFor: (s: StoreRow) => StoreActions
  sandboxes?: readonly { machine?: string | null, project?: string | null }[] | undefined
  onOpenStore: (name: string) => void
  onOpenProject: (key: string) => void
  onBackups: (store: string) => void
}

/** A board's two kinds: their Stores, the words around them, and each kind's add button. */
interface BoardProps extends CardProps {
  /** Tile ids and the remembered tile (per machine). */
  scope: string
  sqlite: StoreRow[]
  sqliteBytes: number | null
  postgresql: StoreRow[]
  noSqlite: string | null
  noPostgresql: string | null
  /** Per kind: the tile's small role word, the panel's note, its add button and its empty line. */
  words: Record<StoreKind, { role: string, note: string, add: ReactNode, empty: string }>
}

function StoresBoard(props: BoardProps): ReactNode {
  const { scope, t, words } = props
  const [kind, setKindState] = useState<StoreKind>(() => startKind(props, readStoreKind(scope)))
  const setKind = (k: StoreKind) => { setKindState(k); writeStoreKind(scope, k) }
  const tiles: { kind: StoreKind, label: string, figure: string, why: string | null }[] = [
    {
      kind: 'sqlite', label: t('sqlite'),
      figure: props.sqlite.length ? [t(props.sqlite.length === 1 ? 'msStoreOne' : 'msStores', { n: props.sqlite.length }), props.sqliteBytes != null && bytes(props.sqliteBytes)].filter(Boolean).join(' · ') : t('msStores', { n: 0 }),
      why: props.sqlite.length ? null : props.noSqlite,
    },
    {
      kind: 'postgresql', label: t('postgresql'),
      figure: t(props.postgresql.length === 1 ? 'msStoreOne' : 'msStores', { n: props.postgresql.length }),
      why: props.postgresql.length ? null : props.noPostgresql,
    },
  ]
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const next = kind === 'sqlite' ? 'postgresql' : 'sqlite'
    setKind(next)
    document.getElementById(`lfs-ms-${scope}-${next}`)?.focus()
  }
  const sqlite = kind === 'sqlite'
  return (
    <div className={css.stack} data-machine-stores={scope}>
      {/* One line: the kind switch (its note and any reason on hover) and the kind's add button. */}
      <div className={css.bar}>
        <div className={css.tiles} role="tablist" aria-label={t('msKindLabel')} onKeyDown={onKey}>
          {tiles.map((tile) => (
            <button key={tile.kind} id={`lfs-ms-${scope}-${tile.kind}`} type="button" role="tab" className={css.tile}
              aria-selected={kind === tile.kind} tabIndex={kind === tile.kind ? 0 : -1} aria-controls={`lfs-ms-${scope}-panel`}
              onClick={() => setKind(tile.kind)} data-store-kind={tile.kind}
              title={[tile.figure, words[tile.kind].note, tile.why].filter(Boolean).join(' · ')}>
              <StoreGlyph kind={tile.kind} size={14} />
              <span className={css.tileLabel}>{tile.label}</span>
              <span className={css.tileFigure}>{tile.figure}</span>
            </button>
          ))}
        </div>
        <span className={css.barAction}>{words[kind].add}</span>
      </div>
      <section id={`lfs-ms-${scope}-panel`} role="tabpanel" aria-labelledby={`lfs-ms-${scope}-${kind}`} className={css.panel}>
        {sqlite
          ? props.sqlite.length
            ? <div className={css.grid}>{props.sqlite.map((s) => <SqliteCard key={s.name} s={s} {...props} />)}</div>
            : <p className={css.empty}>{words.sqlite.empty}</p>
          : props.postgresql.length
            ? <AttachedHere {...props} stores={props.postgresql} />
            : <p className={css.empty}>{words.postgresql.empty}</p>}
      </section>
    </div>
  )
}

export function MachineStores(props: MachineStoresProps): ReactNode {
  const { machine, view, t } = props
  const stores = machineStores(view, machine, t, props.busy)
  const place = machine
  const plus = <IconPlusOutlineRegular size={12} />
  return (
    <StoresBoard {...props} {...stores} scope={machine} words={{
      sqlite: {
        role: t('msHeldHere'),
        note: isHostName(machine) ? t('msSqliteBodyHome') : t('msSqliteBody', { machine: place }),
        add: <ExplainedButton variant="outline" size="sm" icon={plus} disabled={!!stores.noSqlite} disabledReason={stores.noSqlite ?? undefined}
          onClick={() => props.onPushHere(machine)}>{isHostName(machine) ? t('msAddSqliteHome') : t('msPushHere')}</ExplainedButton>,
        empty: stores.noSqlite ?? (isHostName(machine) ? t('msSqliteEmptyHome') : t('msSqliteEmpty', { machine: place })),
      },
      postgresql: {
        role: t('msRunsHere'),
        note: t('msPgBody', { machine: place }),
        add: <ExplainedButton variant="outline" size="sm" icon={plus} disabled={!!stores.noPostgresql} disabledReason={stores.noPostgresql ?? undefined}
          onClick={() => props.onAttachStore(machine)}>{t('rowAttachStore')}</ExplainedButton>,
        empty: stores.noPostgresql ?? t('msPgEmpty', { machine: place }),
      },
    }} />
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

function Head({ s, on, t, machine, runningJob, onOpenStore }: { s: StoreRow, on: StoreActions, t: StorageT, machine?: string, runningJob?: boolean, onOpenStore: (name: string) => void }): ReactNode {
  return (
    <div className={css.head}>
      <span className={css.glyph}><StoreGlyph kind={s.kind} size={18} /></span>
      <LinkButton className={css.name} onClick={() => onOpenStore(s.name)} title={s.name}>{s.name}</LinkButton>
      <StoreMenu store={s} on={on} t={t} machine={machine} runningJob={runningJob} />
    </div>
  )
}

/** The card's figure and the small words beside it (where the file is, last write; or the server). */
/** `tone`: `stale` a last-seen figure, `none` no figure (said in words, small). */
function Figure({ big, meta, title, tone }: { big: ReactNode, meta: ReactNode, title?: string | undefined, tone?: 'stale' | 'none' | undefined }): ReactNode {
  return (
    <div className={css.figure} title={title}>
      <span className={css.big} data-tone={tone}>{big}</span>
      {meta ? <span className={css.meta}>{meta}</span> : null}
    </div>
  )
}

/**
 * The card's kept room: up to three projects, each with its packed bytes and
 * a bar for its share of the file (SQLite) or of the projects (PostgreSQL;
 * no bar while its bytes are unknown). A status (a transfer, in use, down)
 * takes the top and leaves one project row; no project leaves the room
 * empty with Add project.
 */
function Slot({ s, split, t, now, status, onAdd, onOpenProject }: { s: StoreRow, split: ProjectSplit | null, t: StorageT, now: number, status?: ReactNode, onAdd: () => void, onOpenProject: (key: string) => void }): ReactNode {
  const tt = t as Translate
  const rows = split?.rows ?? [...s.projects].sort().map((name) => ({ name, bytes: null, share: 0, hue: 0, at: null, counting: true, error: null }))
  return (
    <div className={css.slot}>
      {status}
      {!s.projects.length ? (
        status ? null : <p className={css.none}>{t('msNoProjects')} · <LinkButton className={css.noneAction} onClick={onAdd}>{t('addProject')}</LinkButton></p>
      ) : (
        <ul className={css.projects}>
          {rows.slice(0, status ? 1 : ROWS).map((r) => (
            <li key={r.name}>
              <button type="button" className={css.project} onClick={() => onOpenProject(`${s.name}/${r.name}`)}
                title={[t('msOpenProject', { project: r.name }), r.at ? t('msLastWrite', { when: ago(r.at, now, tt) }) : null].filter(Boolean).join(' · ')}>
                <span className={css.projectName}>{r.name}</span>
                <span className={css.projectMeta}>
                  {r.bytes === null ? (r.counting ? t('spReading') : <span title={r.error ?? t('msNotCounted')}>—</span>) : r.at === null ? t('spNoCommits') : bytes(r.bytes)}
                </span>
                {r.bytes !== null ? <span className={css.track} aria-hidden="true"><span style={{ width: `${Math.round(r.share * 1000) / 10}%` }} /></span> : <span />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** "+N projects" in the foot when the room holds fewer than the Store has; opens the Store. */
function More({ s, shown, t, onOpenStore }: { s: StoreRow, shown: number, t: StorageT, onOpenStore: (name: string) => void }): ReactNode {
  const rest = s.projects.length - shown
  return rest > 0 ? <LinkButton className={css.more} onClick={() => onOpenStore(s.name)}>{t(rest === 1 ? 'msMoreProjectOne' : 'msMoreProjects', { n: rest })}</LinkButton> : null
}

/** The backups badge: provider marks, the count and the worst state's dot; "No backup" when there is none. */
function BackupsBadge({ s, view, t, onBackups, onBackup }: { s: StoreRow, view: StorageView, t: StorageT, onBackups: () => void, onBackup: () => void }): ReactNode {
  const backups = storeBackups(s, view.buckets)
  if (!backups.length) return <button type="button" className={css.badge} data-none onClick={onBackup} title={t('noBackup')}>{t('msNoBackup')}</button>
  const n = backupCounts(backups)
  const worst = n.problem ? 'problem' : n.stale ? 'stale' : n.unknown ? 'unknown' : 'current'
  const providers = backupProviders(backups)
  return (
    <button type="button" className={css.badge} onClick={onBackups} aria-label={`${t('msBackupsOpen', { store: s.name, n: backups.length })}. ${t('bkHealth', n)}`} title={t('bkHealth', n)}>
      <span className={css.marks}>{providers.slice(0, 3).map((p) => <span key={p ?? '?'} className={css.mark}><BucketMark provider={p} size={13} /></span>)}</span>
      {backups.length === 1 ? t('msBackupOne') : t('msBackupCount', { n: backups.length })}
      <span className={css.dot} data-health={worst} />
    </button>
  )
}

interface Act { label: string, run: () => void, disabled?: boolean, disabledReason?: string | undefined }

/** The foot's actions: one button, the rest in a ⋯ menu. */
function FootActions({ main, rest, label }: { main: Act, rest: Act[], label: string }): ReactNode {
  return (
    <span className={css.footActions}>
      <ExplainedButton size="sm" variant="ghost" disabled={main.disabled} disabledReason={main.disabledReason} onClick={main.run}>{main.label}</ExplainedButton>
      {rest.length ? (
        <MoreMenu label={label}>
          {(close) => rest.map((a) => <MenuItemButton key={a.label} disabled={a.disabled} disabledReason={a.disabledReason} onSelect={() => { close(); a.run() }}>{a.label}</MenuItemButton>)}
        </MoreMenu>
      ) : null}
    </span>
  )
}

/** A sqlite Store's size: as read now, else the last size read (its machine did not answer), else "Size unknown". */
function SizeFigure({ s, t, now, last }: { s: StoreRow, t: StorageT, now: number, last: string | null }): ReactNode {
  const size = s.size
  const seen = size?.stale && size.seen ? ago(size.seen, now, t as Translate) : null
  const words = [seen ? t('msSizeSeen', { when: seen }) : null, last ? t('msLastWrite', { when: last }) : null].filter(Boolean).join(' · ')
  const meta = words ? <span className={css.metaText}>{words}</span> : null
  if (!size) return <Figure big={t('msSizeUnknown')} tone="none" meta={meta} />
  const parts = bytes(size.bytes)
  return <Figure big={bytes(size.bytes)} tone={size.stale ? 'stale' : undefined} meta={meta}
    // a stopped machine is stopped, not "does not answer" (R2-2)
    title={size.stale ? t(stoppedBlock(s) ? 'msSizeStaleStoppedTitle' : 'msSizeStaleTitle', { parts, when: seen ?? '?' }) : undefined} />
}

/** A Store's state in words on its card (LayerFS's sentence as the tip) and its fix as the one action. */
/** The card's status: dot and word, LayerFS's sentence (or its fix) as the tip, and the one fix (R2-2: never a bare sentence). */
function StoreStatus({ s, t, words, onStart, machineState }: { s: StoreRow, t: StorageT, words: string, onStart?: (() => void) | undefined, machineState?: string | null | undefined }): ReactNode {
  const tip = useStoreTip(s, t) ?? s.fix ?? undefined
  const tone = storeNoticeTone(s, machineState)
  return (
    <div className={css.statusRow} data-tone={tone}>
      {tone === 'danger' ? <StatusDot state="error" size={8} /> : null}
      <span className={css.statusText} title={tip}>{words}</span>
      <StoreAction store={s} t={t} onStart={onStart} machineState={machineState} />
    </div>
  )
}

function SqliteCard({ s, api, machine, t, view, jobs, dismissed, now, actionsFor, onOpenStore, onOpenProject, onBackups }: CardProps & { s: StoreRow }): ReactNode {
  const on = actionsFor(s)
  const job = cardJob(jobs, s.name, dismissed, now)
  const split = useSplit(api, s, s.size?.bytes ?? null)
  const running = !!job && !job.ended
  const footReason = storeWaitsFor(s, t, running)
  const last = split?.lastWrite ? ago(split.lastWrite, now, t as Translate) : null
  const machineState = view.machines.find((m) => m.name === s.machine)?.state
  // Shown only when something is happening: ready says nothing. A state word with its reason; the fix line is the tip (the one action).
  const notice = storeNotice(s, machineState, t)
  const status = job ? <JobPanel job={job} compact t={t} onRetry={() => on.retry(job)} onDismiss={() => on.dismiss(job)} onStop={on.stopJob ? () => on.stopJob!(job) : undefined} onCheck={on.checkJob ? () => on.checkJob!(job) : undefined} />
    : s.op ? <OpPanel store={s} compact t={t} />
      : notice ? <StoreStatus s={s} t={t} words={notice} onStart={on.start} machineState={machineState} />
        : null
  return (
    <Card className={css.card} data-store={s.name} data-kind="sqlite">
      <Head s={s} on={on} t={t} runningJob={running} onOpenStore={onOpenStore} />
      <SizeFigure s={s} t={t} now={now} last={last} />
      <Slot s={s} split={split} t={t} now={now} status={status} onAdd={on.addProject} onOpenProject={onOpenProject} />
      <div className={css.foot}>
        <BackupsBadge s={s} view={view} t={t} onBackups={() => onBackups(s.name)} onBackup={on.backup} />
        <More s={s} shown={status ? 1 : ROWS} t={t} onOpenStore={onOpenStore} />
        {/* the head's ⋯ holds Move, Back up and Remove */}
        {running ? null : isHostName(s.machine)
          ? <FootActions label={t('msMoreActions', { name: s.name })} main={{ label: t('pushTo'), run: on.push, disabled: footReason !== null, disabledReason: footReason ?? undefined }} rest={[]} />
          : <FootActions label={t('msMoreActions', { name: s.name })} main={{ label: t('msPull'), run: on.pull, disabled: footReason !== null, disabledReason: footReason ?? undefined }} rest={[]} />}
      </div>
    </Card>
  )
}

/**
 * The PostgreSQL Stores attached to this machine (or with a Sandbox here):
 * one row each with its address, this machine's last reach and Detach, or,
 * while Sandboxes of the Store run here, their count.
 */
function AttachedHere({ machine, view, t, actionsFor, sandboxes, onOpenStore, stores }: CardProps & { stores: StoreRow[] }): ReactNode {
  const record = view.machines.find((m) => m.name === machine)
  return (
    <ul className={rowsCss.list} data-attached-here={machine}>
      {stores.map((s) => {
        const on = actionsFor(s)
        const attached = (s.attached ?? []).find((a) => a.machine === machine)
        const status = reachStatus(attached?.reach ?? null, { machine: record ? { state: record.state } : null })
        const boxes = (sandboxes ?? []).filter((b) => b.machine === machine && b.project?.startsWith(`${s.name}/`)).length
        const address = pgAddress(s)
        return (
          <li key={s.name} className={rowsCss.row} data-store={s.name}>
            <div className={rowsCss.head} style={{ cursor: 'default' }}>
              <div className={rowsCss.main}>
                <span className={rowsCss.line1}>
                  <StoreGlyph kind="postgresql" size={14} />
                  <button type="button" className={`${rowsCss.name} ${rowsCss.linkPlain}`} title={s.name} onClick={() => onOpenStore(s.name)}>{s.name}</button>
                </span>
                {address ? <span className={rowsCss.line2} title={address}><span className={rowsCss.mono}>{address}</span><CopyAddress text={s.postgresql?.url ?? address} t={t} /></span> : null}
              </div>
              <div className={rowsCss.summary}>
                {attached ? <ReachWord status={status} t={t} machine={machine} onEdit={on.editConnection} onStart={() => on.startMachine(machine)} onUpdate={() => on.openMachine(machine)} />
                  : <span className={rowsCss.muted}>{t('rowNotAttached')}</span>}
                {boxes ? (
                  <span className={rowsCss.boxes} title={t('rowDetachBusy', { n: boxes, machine })}><SandboxGlyph size={12} />{boxes}</span>
                ) : attached ? (
                  <button type="button" className={rowsCss.link} onClick={() => on.detach(machine)}>{t('rowDetachShort')}</button>
                ) : null}
              </div>
              <span />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
