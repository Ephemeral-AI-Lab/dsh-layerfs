/**
 * Home › Stores (docs/specs/store-home-rows.md): the SQLite | PostgreSQL
 * switch and, for each, one bordered list of accordion rows, one per Store.
 * Several rows may be open at once; the open set is remembered per viewer.
 *
 *   PostgreSQL row  folded: health dot (the host's check), name, address;
 *                   projects · the first machines with their reach · the
 *                   machine count · one status word. Unfolded: Projects and
 *                   Runs on (attached machines), then Check, Edit
 *                   connection…, Open Store page →.
 *   SQLite row      folded: state dot, name, size; projects · its machine
 *                   (or stopped · Start, or the running operation) · its
 *                   backups. Unfolded: Projects, Lives on, Backups, then
 *                   Compact…, Restore…, Open Store page →.
 *
 * The pieces (ProjectsList, RunsOnList, ReachWord) are shared with the
 * PostgreSQL Store page and the machine page's Stores tab. The numbers come
 * from store-rows.ts.
 */
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconCloseOutlineRegular, IconCopyOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import { StatusDot } from '../ui/StatusDot.tsx'
import { enc, type LayerfsApi } from '../api.ts'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { useMachinesMaybe } from '../machines/context.tsx'
import { MachineGlyph, SandboxGlyph } from '../machines/icons.tsx'
import { useQuery } from '../ui/use-query.ts'
import { BucketMark, providerWords } from './BucketPage.tsx'
import { JobLine } from './HomeCards.tsx'
import type { StorageT } from './locale.ts'
import { cardJob, compactWaitsFor, inHome, storeWaitsFor } from './model.ts'
import { StoreGlyph } from './parts.tsx'
import type { StoreActions } from './StoreCard.tsx'
import { runningByProject, type StoreProjectsView } from './store-page.ts'
import {
  backupSummary, capped, LIST_ROWS, linkFailed, openFailed, pgAddress, pgStatusWord, pgSummary, reachStatus, readOpenRows,
  REACH_LABEL, sqliteState, writeOpenRows, type ReachStatus,
} from './store-rows.ts'
import { HOME_SCOPE, readStoreKind, readStoresAlt, watchHomeStores, writeStoreKind, writeStoresAlt } from './tabs.ts'
import type { PgCheck, StorageJob, StorageView, StoreRow } from './types.ts'
import css from './StoreRows.module.css'

type Kind = 'sqlite' | 'postgresql'
type Sandboxes = readonly { machine?: string | null, project?: string | null, state?: string, live?: boolean | null }[]

/** SQLite's second view (the backup buckets), with the switch's labels and its own actions. */
export interface AltView {
  main: { label: string, count: number }
  other: { label: string, count: number }
  view: ReactNode
  add: ReactNode
}

export interface StoreRowsProps {
  api: LayerfsApi
  view: StorageView
  /** Every Store, in the Overview's order. */
  stores: readonly StoreRow[]
  t: StorageT
  now: number
  jobs: readonly StorageJob[]
  dismissed: ReadonlySet<string>
  sandboxes?: Sandboxes | undefined
  actionsFor: (s: StoreRow) => StoreActions
  /** Where the view's header actions go (the tab bar's right end). */
  actionHost: HTMLSpanElement | null
  alt: AltView
  onOpenStore: (name: string) => void
  onOpenProject: (key: string) => void
  onNewStore: () => void
  onConnect: () => void
}

export function StoreRows(props: StoreRowsProps): ReactNode {
  const { t } = props
  const sqlite = props.stores.filter((s) => s.kind === 'sqlite')
  const pg = props.stores.filter((s) => s.kind === 'postgresql')
  const [kind, setKindState] = useState<Kind>(() => readStoreKind(HOME_SCOPE) ?? (sqlite.length || !pg.length ? 'sqlite' : 'postgresql'))
  const setKind = (k: Kind) => { setKindState(k); writeStoreKind(HOME_SCOPE, k) }
  const [buckets, setBucketsState] = useState(() => readStoresAlt())
  const setBuckets = (on: boolean) => { setBucketsState(on); writeStoresAlt(on) }
  useEffect(() => watchHomeStores(() => { setKindState(readStoreKind(HOME_SCOPE) ?? 'sqlite'); setBucketsState(readStoresAlt()) }), [])
  const [open, setOpenState] = useState<Record<Kind, Set<string>>>(() => ({ sqlite: readOpenRows('sqlite'), postgresql: readOpenRows('postgresql') }))
  const setOpen = (k: Kind, next: Set<string>) => { setOpenState((o) => ({ ...o, [k]: next })); writeOpenRows(k, next) }
  const toggle = (k: Kind, name: string) => { const next = new Set(open[k]); if (next.has(name)) next.delete(name); else next.add(name); setOpen(k, next) }
  // the PostgreSQL Stores being checked now: their rows say `checking`
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set())
  const mark = (names: readonly string[], on: boolean) => setChecking((prev) => { const next = new Set(prev); for (const n of names) { if (on) next.add(n); else next.delete(n) } return next })
  const check = (s: StoreRow): Promise<PgCheck | null> => {
    mark([s.name], true)
    return Promise.resolve(props.actionsFor(s).check()).finally(() => mark([s.name], false))
  }
  const [checkingAll, setCheckingAll] = useState(false)
  const checkAll = () => {
    if (checkingAll || !pg.length) return
    setCheckingAll(true)
    void Promise.all(pg.map((s) => check(s).then((c) => (c ? { store: s.name, host: c.host } : null), () => null))).then((checks) => {
      // a row whose host check just failed opens itself
      setOpen('postgresql', openFailed(readOpenRows('postgresql'), checks.filter((c): c is { store: string, host: PgCheck['host'] } => !!c)))
    }).finally(() => setCheckingAll(false))
  }
  const showAlt = kind === 'sqlite' && buckets
  const plus = <IconPlusOutlineRegular size={12} />
  const actions = showAlt ? props.alt.add : kind === 'sqlite'
    ? <Button variant="outline" size="sm" icon={plus} onClick={props.onNewStore}>{t('newStore')}</Button>
    : (
      <>
        <Button variant="outline" size="sm" disabled={checkingAll || !pg.length} onClick={checkAll}
          icon={checkingAll ? <StatusDot state="ongoing" size={13} /> : <IconRefreshOutlineRegular size={13} />}>{t('rowsCheckAll')}</Button>
        <Button variant="outline" size="sm" icon={plus} onClick={props.onConnect}>{t('connectDatabase')}</Button>
      </>
    )
  const tiles: { kind: Kind, label: string, count: number }[] = [
    { kind: 'sqlite', label: t('sqlite'), count: sqlite.length },
    { kind: 'postgresql', label: t('postgresql'), count: pg.length },
  ]
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const next = kind === 'sqlite' ? 'postgresql' : 'sqlite'
    setKind(next)
    document.getElementById(`lfs-rows-${next}`)?.focus()
  }
  const list = kind === 'sqlite' ? sqlite : pg
  return (
    <div className={css.stack} data-store-rows={kind}>
      <div className={css.bar}>
        <div className={css.tiles} role="tablist" aria-label={t('msKindLabel')} onKeyDown={onKey}>
          {tiles.map((tile) => (
            <button key={tile.kind} id={`lfs-rows-${tile.kind}`} type="button" role="tab" className={css.tile} aria-selected={kind === tile.kind}
              tabIndex={kind === tile.kind ? 0 : -1} aria-controls="lfs-rows-panel" onClick={() => setKind(tile.kind)} data-store-kind={tile.kind}>
              <StoreGlyph kind={tile.kind} size={14} />
              <span>{tile.label}</span>
              <span className={css.count}>{tile.count}</span>
            </button>
          ))}
        </div>
        {kind === 'sqlite' ? (
          <div className={css.tiles} role="tablist" aria-label={t('hsViewLabel')}>
            {([false, true] as const).map((on) => {
              const v = on ? props.alt.other : props.alt.main
              return (
                <button key={String(on)} type="button" role="tab" className={css.tile} aria-selected={showAlt === on} aria-controls="lfs-rows-panel"
                  onClick={() => setBuckets(on)} data-stores-view={on ? 'alt' : 'stores'}>
                  {v.label}<span className={css.count}>{v.count}</span>
                </button>
              )
            })}
          </div>
        ) : null}
        {props.actionHost ? createPortal(actions, props.actionHost) : <span className={css.barActions}>{actions}</span>}
      </div>
      <section id="lfs-rows-panel" role="tabpanel" aria-labelledby={`lfs-rows-${kind}`}>
        {showAlt ? props.alt.view : !list.length ? (
          <p className={css.empty}>{t(kind === 'sqlite' ? 'hsSqliteEmpty' : 'hsPgEmpty')}</p>
        ) : (
          <ul className={css.list} aria-label={kind === 'sqlite' ? t('sqlite') : t('postgresql')}>
            {list.map((s) => kind === 'sqlite'
              ? <SqliteRow key={s.name} {...props} s={s} open={open.sqlite.has(s.name)} onToggle={() => toggle('sqlite', s.name)} />
              : <PgRow key={s.name} {...props} s={s} open={open.postgresql.has(s.name)} onToggle={() => toggle('postgresql', s.name)} checking={checking.has(s.name)} onCheck={() => { void check(s) }} />)}
          </ul>
        )}
      </section>
    </div>
  )
}

interface RowProps extends StoreRowsProps { s: StoreRow, open: boolean, onToggle: () => void }

/** A row's head: the whole head toggles (its own links stop there); the left part is the toggle button for keyboards. */
function Head({ s, open, onToggle, dot, line2, line2Title, summary, t }: {
  s: StoreRow, open: boolean, onToggle: () => void, dot: ReactNode, line2: ReactNode, line2Title?: string | undefined, summary: ReactNode, t: StorageT
}): ReactNode {
  const body = `lfs-row-${s.kind}-${s.name}`
  return (
    <div className={css.head} onClick={onToggle} data-open={open || undefined}>
      <button type="button" className={css.main} aria-expanded={open} aria-controls={body} title={s.name} aria-label={t('rowToggle', { name: s.name })}>
        <span className={css.line1}>{dot}<span className={css.name}>{s.name}</span></span>
        <span className={css.line2} title={line2Title}>{line2}</span>
      </button>
      <div className={css.summary}>{summary}</div>
      <span className={css.chevron} aria-hidden="true"><IconChevronDownOutlineRegular size={14} /></span>
    </div>
  )
}

/** Stops a press inside the head from folding the row. */
const stop = (e: React.SyntheticEvent) => e.stopPropagation()

const Divider = () => <span className={css.divider} aria-hidden="true" />

/** A check's status: its dot and label; LayerFS's words as the tooltip; its one action (Edit connection…, Start, Update…). */
export function ReachWord({ status, t, machine, onEdit, onStart, onUpdate, compact }: {
  status: ReachStatus, t: StorageT, machine?: string | undefined, onEdit?: (() => void) | undefined, onStart?: (() => void) | undefined, onUpdate?: (() => void) | undefined, compact?: boolean
}): ReactNode {
  const dot = status.tone === 'ok' ? 'done' : status.tone === 'danger' ? 'error' : status.tone === 'warning' ? 'warning' : status.tone === 'ongoing' ? 'ongoing' : 'idle'
  const run = status.fix === 'edit' ? onEdit : status.fix === 'start' ? onStart : status.fix === 'update' ? onUpdate : undefined
  const label = status.fix === 'edit' ? t('pgEditConnectionShort') : status.fix === 'start' ? t('rowStart') : status.fix === 'update' ? t('rowUpdate') : null
  return (
    <span className={css.reach} data-tone={status.tone} title={status.detail ?? undefined}>
      <StatusDot state={dot} size={status.tone === 'ongoing' ? 11 : 8} />
      <span className={css.reachText}>{t(REACH_LABEL[status.key])}</span>
      {!compact && run && label ? <button type="button" className={css.link} aria-label={status.fix === 'start' && machine ? t('startMachine', { machine }) : undefined} onClick={(e) => { stop(e); run() }}>{label}</button> : null}
    </span>
  )
}

/** Copies an address; says Copied for a moment. */
export function CopyAddress({ text, t }: { text: string, t: StorageT }): ReactNode {
  const [done, setDone] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return (
    <button type="button" className={css.copy} aria-label={done ? t('ovCopied') : t('rowCopyAddress')} title={done ? t('ovCopied') : t('rowCopyAddress')}
      onClick={(e) => {
        stop(e)
        void navigator.clipboard?.writeText(text).then(() => { setDone(true); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setDone(false), 1500) }, () => {})
      }}>
      <IconCopyOutlineRegular size={12} />
    </button>
  )
}

// ---------- PostgreSQL ----------

function PgRow(props: RowProps & { checking: boolean, onCheck: () => void }): ReactNode {
  const { s, t, view, open, onToggle } = props
  const on = props.actionsFor(s)
  const mc = useMachinesMaybe()
  const checkingSides = new Set(props.checking ? ['host', ...(s.attached ?? []).map((a) => a.machine)] : [])
  const sum = pgSummary(s, view, checkingSides)
  const hostFailed = sum.host.tone === 'danger'
  const address = pgAddress(s)
  const word = pgStatusWord(sum)
  const projects = t(sum.projects === 1 ? 'msProjectOne' : 'msProjectCount', { n: sum.projects })
  const dot = <StatusDot state={sum.host.tone === 'ok' ? 'done' : hostFailed ? 'error' : sum.host.tone === 'ongoing' ? 'ongoing' : 'idle'} size={sum.host.tone === 'ongoing' ? 11 : 8} label={t(REACH_LABEL[sum.host.key])} />
  const summary = hostFailed ? (
    <>
      <span className={css.num}>{projects}</span>
      <Divider />
      <ReachWord status={sum.host} t={t} compact />
      <button type="button" className={css.link} onClick={(e) => { stop(e); on.editConnection() }}>{t('pgEditConnectionShort')}</button>
    </>
  ) : (
    <>
      <span className={css.num}>{projects}</span>
      <Divider />
      <span className={css.icons} aria-label={sum.machines.map((m) => `${m.machine}: ${t(REACH_LABEL[m.status.key])}`).join(', ') || undefined}>
        {sum.shown.map((m) => (
          <span key={m.machine} className={css.icon} title={`${m.machine} · ${mc?.kind(m.platform ?? '') ?? m.platform ?? ''} · ${t(REACH_LABEL[m.status.key])}`}>
            <MachineGlyph platform={m.platform ?? ''} size={14} />
            <span className={css.iconDot} data-tone={m.status.tone} />
          </span>
        ))}
        {sum.more ? <span className={css.more}>{`+${sum.more}`}</span> : null}
      </span>
      <span className={css.muted}>{sum.machines.length ? t(sum.machines.length === 1 ? 'rowMachineOne' : 'rowMachines', { n: sum.machines.length }) : t('rowNoMachines')}</span>
      {word ? <span className={css.word} data-tone={word.tone}>{t(word.key, { n: word.n })}</span> : null}
    </>
  )
  return (
    <li className={css.row} data-store={s.name} data-kind="postgresql" data-host={sum.host.key}>
      <Head s={s} open={open} onToggle={onToggle} dot={dot} t={t} summary={summary}
        line2={address ? <><span className={css.mono}>{address}</span><span onClick={stop}><CopyAddress text={s.postgresql?.url ?? address} t={t} /></span></> : <span className={css.muted}>{t('rowNoAddress')}</span>}
        line2Title={address ?? undefined} />
      {open ? (
        <div id={`lfs-row-postgresql-${s.name}`} className={css.body}>
          <div className={css.columns}>
            <ProjectsList {...props} stale={hostFailed} />
            <section className={css.section} aria-label={t('rowRunsOn')}>
              <div className={css.sectionHead}>
                <span className={css.sectionTitle}>{t('rowRunsOn')}</span>
                <button type="button" className={css.link} onClick={on.attach}><IconPlusOutlineRegular size={10} />{t('rowAttachMachine')}</button>
              </div>
              <RunsOnList s={s} view={view} t={t} on={on} checking={checkingSides} sandboxes={props.sandboxes} cap={LIST_ROWS} onMore={() => props.onOpenStore(s.name)} />
            </section>
          </div>
          <div className={css.foot}>
            <button type="button" className={css.link} disabled={props.checking} onClick={props.onCheck}>{props.checking ? t('stChecking') : t('pgCheck')}</button>
            <button type="button" className={css.link} onClick={on.editConnection}>{t('pgEditConnectionShort')}</button>
            <button type="button" className={clsx(css.link, css.end)} onClick={() => props.onOpenStore(s.name)}>{t('rowOpenStore')}</button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/**
 * The machines attached to a PostgreSQL Store, one row each: its mark, name,
 * provider, its reach, then × (detach) or, while Sandboxes of the Store run
 * there, their count. `cap` rows, then `+N →`.
 */
export function RunsOnList({ s, view, t, on, checking, sandboxes, cap, onMore }: {
  s: StoreRow, view: Pick<StorageView, 'machines'>, t: StorageT, on: StoreActions, checking?: ReadonlySet<string> | undefined
  sandboxes?: Sandboxes | undefined, cap?: number | undefined, onMore?: (() => void) | undefined
}): ReactNode {
  const mc = useMachinesMaybe()
  const rows = s.attached ?? []
  if (!rows.length) return <p className={css.none}>{t('rowNoMachinesBody')}</p>
  const { shown, more } = cap ? capped(rows, cap) : { shown: rows, more: 0 }
  return (
    <>
      <ul className={css.items}>
        {shown.map((a) => {
          const record = view.machines.find((m) => m.name === a.machine)
          const status = reachStatus(a.reach, { checking: checking?.has(a.machine), machine: record ? { state: record.state, reason: record.reason ?? null } : null })
          const boxes = (sandboxes ?? []).filter((b) => (b.machine ?? 'native') === a.machine && b.project?.startsWith(`${s.name}/`)).length
          return (
            <li key={a.machine} className={css.item} data-machine={a.machine}>
              <span className={css.itemMark}><MachineGlyph platform={record?.platform ?? ''} size={14} /></span>
              <button type="button" className={clsx(css.itemName, css.linkPlain)} title={a.machine} onClick={() => on.openMachine(a.machine)}>{a.machine === 'native' ? t('pgThisComputer') : a.machine}</button>
              <span className={css.itemMeta}>{mc?.kind(record?.platform ?? '') ?? record?.platform ?? ''}</span>
              <ReachWord status={status} t={t} machine={a.machine} onEdit={on.editConnection} onStart={() => on.startMachine(a.machine)} onUpdate={() => on.openMachine(a.machine)} />
              {boxes ? (
                <span className={css.boxes} title={t('rowDetachBusy', { n: boxes, machine: a.machine })} aria-label={t(boxes === 1 ? 'pgSandboxOne' : 'pgSandboxes', { n: boxes })}>
                  <SandboxGlyph size={12} />{boxes}
                </span>
              ) : (
                <button type="button" className={css.detach} aria-label={t('rowDetach', { machine: a.machine })} title={t('rowDetach', { machine: a.machine })} onClick={() => on.detach(a.machine)}>
                  <IconCloseOutlineRegular size={11} />
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {more && onMore ? <button type="button" className={css.link} onClick={onMore}>{t('rowMoreMachines', { n: more })}</button> : null}
    </>
  )
}

// ---------- projects (both kinds) ----------

/** When the projects on screen were last read: the time their answer arrived. */
function useAnsweredAt(data: unknown): number | null {
  const at = useRef<{ data: unknown, at: number | null }>({ data: undefined, at: null })
  if (data !== undefined && data !== at.current.data) at.current = { data, at: Date.now() }
  return at.current.at
}

/**
 * A Store's projects: each with its packed size (or "no commits yet") and the
 * Sandboxes running it, largest first; the total on the heading. `cap` rows,
 * then `+N projects →` (the Store page). `stale`: the host cannot reach the
 * database, so the list is greyed and the heading says when it was read.
 */
export function ProjectsList({ api, s, t, now, sandboxes, onOpenProject, onOpenStore, stale, cap = LIST_ROWS }: {
  api: LayerfsApi, s: StoreRow, t: StorageT, now: number, sandboxes?: Sandboxes | undefined
  onOpenProject: (key: string) => void, onOpenStore: (name: string) => void, stale?: boolean, cap?: number | null
}): ReactNode {
  const q = useQuery(() => api.call<StoreProjectsView>('GET', `/api/stores/${enc(s.name)}/projects`), [api, s.name],
    { refresh: [s.projects.length, s.size?.bytes], cache: `store-projects:${s.name}` })
  const read = useAnsweredAt(q.data)
  const running = runningByProject(s.name, (sandboxes ?? []).map((b) => ({ project: b.project ?? null, state: b.state, live: b.live })))
  const rows = (q.data?.projects ?? s.projects.map((name) => ({ name, totals: null, last: null }) as never)).map((p: StoreProjectsView['projects'][number]) => ({
    name: p.name, bytes: p.totals ? p.totals.stored : null, empty: !!p.totals && !p.last, boxes: running.get(p.name) ?? 0,
  })).sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name))
  const counted = rows.filter((r) => r.bytes !== null)
  const total = counted.length ? counted.reduce((n, r) => n + (r.bytes ?? 0), 0) : null
  const { shown, more } = cap ? capped(rows, cap) : { shown: rows, more: 0 }
  return (
    <section className={css.section} data-stale={stale || undefined} aria-label={t('tabProjects')}>
      <div className={css.sectionHead}>
        <span className={css.sectionTitle}>{t('tabProjects')}</span>
        <span className={css.sectionMeta}>{stale ? (read ? t('rowLastRead', { when: ago(read, now, t as Translate) }) : t('stNotChecked')) : total !== null ? bytes(total) : null}</span>
      </div>
      {!rows.length ? <p className={css.none}>{q.error && !q.data ? t('rowProjectsUnread') : t('msNoProjects')}</p> : (
        <ul className={css.items}>
          {shown.map((r) => (
            <li key={r.name} className={clsx(css.item, css.projectItem)}>
              <button type="button" className={clsx(css.itemName, css.linkPlain)} title={r.name} onClick={() => onOpenProject(`${s.name}/${r.name}`)}>{r.name}</button>
              {r.boxes ? <span className={css.boxes} title={t(r.boxes === 1 ? 'pgSandboxOne' : 'pgSandboxes', { n: r.boxes })}><SandboxGlyph size={12} />{r.boxes}</span> : <span />}
              <span className={css.size}>{r.bytes === null ? (q.loading || !q.data ? '…' : '—') : r.empty ? <span className={css.muted}>{t('rowNoCommits')}</span> : bytes(r.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
      {more ? <button type="button" className={css.link} onClick={() => onOpenStore(s.name)}>{t('rowMoreProjects', { n: more })}</button> : null}
    </section>
  )
}

// ---------- SQLite ----------

function SqliteRow(props: RowProps): ReactNode {
  const { s, t, view, now, open, onToggle } = props
  const on = props.actionsFor(s)
  const mc = useMachinesMaybe()
  const job = cardJob(props.jobs, s.name, props.dismissed, now)
  const running = !!job && !job.ended
  const machine = view.machines.find((m) => m.name === s.machine)
  const state = sqliteState(s, machine?.state, job)
  const backups = backupSummary(s, view.buckets)
  const projects = s.projectsCount ?? s.projects.length
  const tt = t as Translate
  const place = s.machine === 'native' ? t('pgThisComputer') : s.machine ?? '?'
  const dotState = state === 'ready' ? 'done' : state === 'busy' ? 'ongoing' : state === 'stopped' ? 'idle' : 'error'
  const stateWord = t(state === 'ready' ? 'rowSqliteReady' : state === 'busy' ? 'rowSqliteBusy' : state === 'stopped' ? 'stMachineStopped' : 'rowSqliteAttention')
  const where = running && job ? <span className={css.job} onClick={stop}><JobLine job={job} t={t} /></span>
    : state === 'stopped' ? (
      <span className={css.reach} data-tone="warning">
        <span className={css.reachText}>{t('rowStopped')}</span>
        <button type="button" className={css.link} aria-label={t('startMachine', { machine: place })} onClick={(e) => { stop(e); on.start() }}>{t('rowStart')}</button>
      </span>
    ) : (
      <span className={css.machine} title={`${place} · ${mc?.kind(machine?.platform ?? '') ?? ''}`}>
        <MachineGlyph platform={machine?.platform ?? (s.machine === 'native' ? 'native' : '')} size={14} />
        <span className={css.machineName}>{place}</span>
      </span>
    )
  const backupWords = backups.buckets ? (
    <span className={css.backups} title={backups.last ? t('rowLastBackup', { when: ago(backups.last, now, tt) }) : undefined}>
      <BucketMark provider={view.buckets.find((b) => b.name === s.links[0]?.bucket)?.provider ?? null} size={13} />
      <span className={css.num}>{[t(backups.buckets === 1 ? 'rowBucketOne' : 'rowBuckets', { n: backups.buckets }), backups.last ? ago(backups.last, now, tt) : t('rowNeverBackedUp')].join(' · ')}</span>
      {backups.failed ? <span className={css.word} data-tone="danger">{t('pgRowFailed', { n: backups.failed })}</span> : null}
    </span>
  ) : <span className={css.muted}>{t('rowNotBackedUp')}</span>
  const summary = (
    <>
      <span className={css.num}>{t(projects === 1 ? 'msProjectOne' : 'msProjectCount', { n: projects })}</span>
      <Divider />
      {where}
      <Divider />
      {backupWords}
    </>
  )
  const moveReason = storeWaitsFor(s, t, running)
  const compactReason = compactWaitsFor(s, t, running)
  return (
    <li className={css.row} data-store={s.name} data-kind="sqlite" data-state={state}>
      <Head s={s} open={open} onToggle={onToggle} t={t} summary={summary}
        dot={<StatusDot state={dotState} size={state === 'busy' ? 11 : 8} label={stateWord} />}
        line2={<span className={css.num}>{s.size ? bytes(s.size.bytes) : t('sizeUnavailable')}</span>}
        line2Title={s.size?.stale && s.size.seen ? t('msSizeSeen', { when: ago(s.size.seen, now, tt) }) : undefined} />
      {open ? (
        <div id={`lfs-row-sqlite-${s.name}`} className={css.body}>
          <div className={css.columns}>
            <ProjectsList {...props} />
            <div className={css.side}>
              <section className={css.section} aria-label={t('rowLivesOn')}>
                <div className={css.sectionHead}>
                  <span className={css.sectionTitle}>{t('rowLivesOn')}</span>
                  <button type="button" className={css.link} disabled={!!moveReason} title={moveReason ?? t('rowMoveRule')} onClick={inHome(s) ? on.push : on.move}>{t('rowMove')}</button>
                </div>
                <ul className={css.items}>
                  <li className={css.item}>
                    <span className={css.itemMark}><MachineGlyph platform={machine?.platform ?? (s.machine === 'native' ? 'native' : '')} size={14} /></span>
                    <button type="button" className={clsx(css.itemName, css.linkPlain)} title={place} onClick={() => s.machine && on.openMachine(s.machine)}>{place}</button>
                    <span className={css.itemMeta}>{mc?.kind(machine?.platform ?? '') ?? ''}</span>
                    {running && job ? <JobLine job={job} t={t} /> : (
                      <span className={css.reach} data-tone={state === 'ready' ? 'ok' : state === 'stopped' ? 'warning' : 'danger'}>
                        <StatusDot state={dotState} size={8} />
                        <span className={css.reachText}>{stateWord}</span>
                        {state === 'stopped' ? <button type="button" className={css.link} aria-label={t('startMachine', { machine: place })} onClick={on.start}>{t('rowStart')}</button> : null}
                      </span>
                    )}
                    <span />
                  </li>
                </ul>
              </section>
              <section className={css.section} aria-label={t('backupsSection')}>
                <div className={css.sectionHead}>
                  <span className={css.sectionTitle}>{t('backupsSection')}</span>
                  <button type="button" className={css.link} onClick={on.backup}><IconPlusOutlineRegular size={10} />{t('addBucket')}</button>
                </div>
                {!s.links.length ? <p className={css.none}>{t('rowNoBuckets')}</p> : (
                  <ul className={css.items}>
                    {s.links.map((l) => {
                      const bucket = view.buckets.find((b) => b.name === l.bucket)
                      const failed = linkFailed(l)
                      return (
                        <li key={`${l.bucket}/${l.file}`} className={css.item}>
                          <span className={css.itemMark}><BucketMark provider={bucket?.provider ?? null} size={13} /></span>
                          <span className={css.itemName} title={`${l.bucket}/${l.file}`}>{l.bucket}</span>
                          <span className={css.itemMeta}>{providerWords(bucket?.provider ?? null, t)}</span>
                          <span className={css.reach} data-tone={failed ? 'danger' : 'idle'} title={failed && l.last?.at ? t('rowLastBackup', { when: ago(l.last.at, now, tt) }) : undefined}>
                            <span className={css.reachText}>{failed ? t('rowAttemptFailed') : l.last?.at ? ago(l.last.at, now, tt) : t('rowNeverBackedUp')}</span>
                          </span>
                          <button type="button" className={css.link} disabled={!!moveReason} title={moveReason ?? undefined} onClick={() => on.backupTo(l)}>{t('rowBackUp')}</button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            </div>
          </div>
          <div className={css.foot}>
            {on.compact ? <button type="button" className={css.link} disabled={!!compactReason} title={compactReason ?? undefined} onClick={on.compact}>{t('compactStore')}</button> : null}
            <button type="button" className={css.link} disabled={!s.links.length} title={s.links.length ? undefined : t('rowNoBuckets')} onClick={on.backups}>{t('restore')}</button>
            <button type="button" className={clsx(css.link, css.end)} onClick={() => props.onOpenStore(s.name)}>{t('rowOpenStore')}</button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
