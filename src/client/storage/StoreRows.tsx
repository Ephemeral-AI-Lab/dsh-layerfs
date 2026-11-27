/**
 * Home › Stores (docs/specs/store-home-rows.md): the SQLite | PostgreSQL
 * switch (remembered per viewer) and that kind's table of accordion rows,
 * with its column headings. Several rows may be open at once; the open set is
 * remembered per viewer. A row's head is one line, as on the Machines board:
 * the chevron, the Store's icon and name (opens the Store page), the kind's
 * cells, the Store's ⋯ menu; at a narrow width the cells go under the name.
 * Glyphs keep their brand colours; a state dot sits on a glyph's corner.
 *
 *   SQLite row      projects · its one machine (or the running operation) ·
 *                   size · backups (one icon per bucket provider, with a
 *                   count and the worst result's dot; the newest backup, or
 *                   failures); the machine's name opens it. Unfolded, in the
 *                   Machines board's bordered panel: Projects (Add project)
 *                   | Backups (Add bucket; Back up per bucket).
 *   PostgreSQL row  projects · machines (one icon per provider, with a count
 *                   and the worst reach's dot; Attach when none) · address
 *                   (or the host's failure and Edit connection…). Unfolded:
 *                   Projects (Add project) | Machines (Check, Attach machine).
 *
 * The pieces ReachWord, CopyAddress and RunsOnList are shared with the
 * PostgreSQL Store page and the machine page's Stores tab. The numbers come
 * from store-rows.ts.
 */
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconCopyOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import { StatusDot } from '../ui/StatusDot.tsx'
import { enc, type LayerfsApi } from '../api.ts'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { useMachinesMaybe } from '../machines/context.tsx'
import { MachineGlyph, SandboxGlyph } from '../machines/icons.tsx'
import mcss from '../machines/machines.module.css'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { useQuery } from '../ui/use-query.ts'
import { BucketMark, providerWords } from './BucketPage.tsx'
import { JobLine } from './HomeCards.tsx'
import type { StorageT } from './locale.ts'
import { canAddProject, cardJob, formatChip, formatTip, storeWaitsFor } from './model.ts'
import { StateChip } from '../ui/index.tsx'
import { StoreGlyph } from './parts.tsx'
import { StoreMenu, type StoreActions } from './StoreCard.tsx'
import { runningByProject, type StoreProjectsView } from './store-page.ts'
import {
  backupSummary, capped, dotState, LIST_ROWS, linkFailed, openFailed, pgAddress, pgSummary, providerBeside, providerGroups, reachStatus, readOpenRows,
  REACH_LABEL, sqliteState, sqliteTone, writeOpenRows, type GroupMember, type ProviderGroupOf, type ReachStatus,
} from './store-rows.ts'
import { HOME_SCOPE, readStoreKind, writeStoreKind } from './tabs.ts'
import type { PgCheck, StorageJob, StorageView, StoreRow } from './types.ts'
import css from './StoreRows.module.css'

type Kind = 'sqlite' | 'postgresql'
export type Sandboxes = readonly { machine?: string | null, project?: string | null, state?: string, live?: boolean | null }[]

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
  /** Where the tab's actions go (the tab bar's right end). */
  actionHost: HTMLSpanElement | null
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
  const plus = <IconPlusOutlineRegular size={12} />
  const actions = (
    <>
      <Button variant="outline" size="sm" icon={plus} onClick={props.onNewStore}>{t('newStore')}</Button>
      <Button variant="outline" size="sm" icon={plus} onClick={props.onConnect}>{t('connectDatabase')}</Button>
    </>
  )
  const tiles: { kind: Kind, count: number }[] = [{ kind: 'sqlite', count: sqlite.length }, { kind: 'postgresql', count: pg.length }]
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const next = kind === 'sqlite' ? 'postgresql' : 'sqlite'
    setKind(next)
    document.getElementById(`lfs-rows-${next}`)?.focus()
  }
  return (
    <div className={css.stack} data-store-rows={kind}>
      {props.actionHost ? createPortal(actions, props.actionHost) : <span className={css.barActions}>{actions}</span>}
      <div className={css.kindBar}>
        <div className={css.tiles} role="tablist" aria-label={t('msKindLabel')} onKeyDown={onKey}>
          {tiles.map((tile) => (
            <button key={tile.kind} id={`lfs-rows-${tile.kind}`} type="button" role="tab" className={css.tile} aria-selected={kind === tile.kind}
              tabIndex={kind === tile.kind ? 0 : -1} aria-controls="lfs-rows-panel" onClick={() => setKind(tile.kind)} data-store-kind={tile.kind}>
              <StoreGlyph kind={tile.kind} size={14} />
              <span>{t(tile.kind)}</span>
              <span className={css.count}>{tile.count}</span>
            </button>
          ))}
        </div>
        {kind === 'postgresql' && pg.length ? (
          <span className={css.kindAside}>
            <button type="button" className={css.link} disabled={checkingAll} onClick={checkAll}>
              {checkingAll ? <StatusDot state="ongoing" size={11} /> : <IconRefreshOutlineRegular size={12} />}{t('rowsCheckAll')}
            </button>
          </span>
        ) : null}
      </div>
      <section id="lfs-rows-panel" role="tabpanel" aria-labelledby={`lfs-rows-${kind}`}>
        {kind === 'sqlite' ? (
          <KindTable kind="sqlite" t={t} count={sqlite.length} empty={t('hsSqliteEmpty')}
            columns={[t('colName'), t('colProjects'), t('colMachine'), t('colSize'), t('colBackups')]}>
            {sqlite.map((s) => <SqliteRow key={s.name} {...props} s={s} open={open.sqlite.has(s.name)} onToggle={() => toggle('sqlite', s.name)} />)}
          </KindTable>
        ) : (
          <KindTable kind="postgresql" t={t} count={pg.length} empty={t('hsPgEmpty')}
            columns={[t('colName'), t('colProjects'), t('colMachine'), t('colAddress')]}>
            {pg.map((s) => <PgRow key={s.name} {...props} s={s} open={open.postgresql.has(s.name)} onToggle={() => toggle('postgresql', s.name)} checking={checking.has(s.name)} onCheck={() => { void check(s) }} />)}
          </KindTable>
        )}
      </section>
    </div>
  )
}

/** One kind's table: the column headings and the rows, or a line saying there are none. */
function KindTable({ kind, t, count, empty, columns, children }: {
  kind: Kind, t: StorageT, count: number, empty: string, columns: string[], children: ReactNode
}): ReactNode {
  if (!count) return <p className={css.empty}>{empty}</p>
  return (
    <div className={css.list} data-kind={kind}>
      <div className={css.cols} data-kind={kind} aria-hidden="true">
        <span />
        {columns.map((c, i) => <span key={c} className={css.col} data-col={i}>{c}</span>)}
        <span />
      </div>
      <ul className={css.rows} aria-label={t(kind)}>{children}</ul>
    </div>
  )
}

interface RowProps extends StoreRowsProps { s: StoreRow, open: boolean, onToggle: () => void }

/**
 * A row's head, one line, as on the Machines board: the chevron (folds the
 * row), the Store's icon with its dot and its name (opens the Store page),
 * the kind's cells, then the Store's ⋯ menu. The whole head folds; a cell's
 * own links and buttons stop there.
 */
function Head({ s, open, onToggle, icon, cells, menu, onOpen, t }: {
  s: StoreRow, open: boolean, onToggle: () => void, icon: ReactNode, cells: ReactNode, menu: ReactNode, onOpen: () => void, t: StorageT
}): ReactNode {
  const body = `lfs-row-${s.kind}-${s.name}`
  const chip = formatChip(s.format, t)
  return (
    <div className={css.head} data-kind={s.kind} onClick={onToggle} data-open={open || undefined}>
      <button type="button" className={css.toggle} aria-expanded={open} aria-controls={body} aria-label={t('rowToggle', { name: s.name })} title={t('rowToggle', { name: s.name })}
        onClick={(e) => { stop(e); onToggle() }}>
        <IconChevronRightOutlineRegular size={12} />
      </button>
      <span className={css.main}>
        {icon}
        <button type="button" className={clsx(css.linkPlain, css.name)} title={t('openStore', { name: s.name })} onClick={(e) => { stop(e); onOpen() }}>{s.name}</button>
        {/* its format (`--with format`, #804): Outdated or Newer format, "Format 2 · latest 3" as the tip */}
        {chip ? <span data-store-format={s.format?.status}><StateChip tone={chip.tone} label={chip.label} dot title={formatTip(s.format, t) ?? undefined} /></span> : null}
      </span>
      <div className={css.cells}>{cells}</div>
      <span className={css.menuCell} onClick={stop}>{menu}</span>
    </div>
  )
}

/** A Store's icon: its kind's glyph, its status dot on the corner (a spinner while it is checked or busy). */
function StoreIcon({ kind, tone, label }: { kind: Kind, tone: ReachStatus['tone'], label: string }): ReactNode {
  return (
    <span className={css.storeIcon} role="img" aria-label={label} title={label}>
      <StoreGlyph kind={kind} size={16} />
      <span className={css.storeDot}>{tone === 'ongoing' ? <StatusDot state="ongoing" size={9} /> : <StatusDot state={dotState(tone)} size={7} />}</span>
    </span>
  )
}

/** A line's glyph, with its state's dot on the corner (none when `quiet` and fine). */
function LineGlyph({ glyph, tone, quiet }: { glyph: ReactNode, tone: ReachStatus['tone'], quiet?: boolean }): ReactNode {
  return (
    <span className={clsx(mcss.lineIcon, css.lineGlyph)} aria-hidden="true">
      {glyph}
      {quiet && (tone === 'ok' || tone === 'idle') ? null : tone === 'ongoing' ? <StatusDot className={css.iconDot} state="ongoing" size={8} /> : <StatusDot className={css.iconDot} state={dotState(tone)} size={6} />}
    </span>
  )
}

/** An unfolded row's section head, as on the Machines board: title, count (and `meta`), then its actions at the end. */
function PaneHead({ title, count, meta, children }: { title: string, count?: number | undefined, meta?: string | null | undefined, children?: ReactNode }): ReactNode {
  return (
    <header className={mcss.columnHead}>
      <h3 className={mcss.columnTitle}>{title}</h3>
      {count !== undefined ? <span className={mcss.columnCount}>{count}</span> : null}
      {meta ? <span className={mcss.columnCount}>{meta}</span> : null}
      <span className={mcss.columnSpacer} />
      {children}
    </header>
  )
}

const plusSmall = <IconPlusOutlineRegular size={11} />

/**
 * Members as icons, one per provider: several of one kind share an icon with
 * their count; its dot is the worst member's (none when every member is
 * fine and `quiet`). Each group's tooltip lists its members with their words.
 */
function ProviderIcons({ groups, glyph, label, quiet }: {
  groups: readonly ProviderGroupOf[], glyph: (provider: string) => ReactNode, label: string, quiet?: boolean
}): ReactNode {
  const { shown, more } = capped(groups, 4)
  const hidden = groups.slice(shown.length).flatMap((g) => g.members)
  return (
    <span className={css.groups} role="img" aria-label={label}>
      {shown.map((g) => (
        <span key={g.provider} className={css.group} title={g.members.map((m) => `${m.name} · ${m.words}`).join('\n')}>
          <span className={css.icon}>
            {glyph(g.provider)}
            {quiet && g.tone === 'ok' ? null : <StatusDot className={css.iconDot} state={dotState(g.tone)} size={6} />}
          </span>
          {g.members.length > 1 ? <span className={css.groupCount}>{g.members.length}</span> : null}
        </span>
      ))}
      {more ? <span className={css.more} title={hidden.map((m) => `${m.name} · ${m.words}`).join('\n')}>{`+${more}`}</span> : null}
    </span>
  )
}

/** A count cell: the number under its column heading; with its words when the cells go under the name. */
function CountCell({ n, words }: { n: number, words: string }): ReactNode {
  return (
    <span className={clsx(css.cell, css.cellNum)} data-cell="projects" title={words}>
      <span className={css.wide}>{n}</span>
      <span className={css.narrow}>{words}</span>
    </span>
  )
}

/** Stops a press inside the head from folding the row. */
const stop = (e: React.SyntheticEvent) => e.stopPropagation()

/** A status dot in its fixed slot: `checking` at 10 (with its words), the rest at 8. */
export function Dot({ tone, label, t }: { tone: ReachStatus['tone'], label?: string | undefined, t: StorageT }): ReactNode {
  if (tone === 'ongoing') return <span className={css.dotSlot} title={label ?? t('stChecking')} aria-label={label ?? t('stChecking')} role="img"><StatusDot state="ongoing" size={10} /></span>
  return <span className={css.dotSlot}><StatusDot state={dotState(tone)} size={8} label={label} /></span>
}

/**
 * A check's status: its dot and label; LayerFS's words as the tooltip; its one
 * action (Edit connection…, Start, Update…). `bare`: the label alone (a row
 * whose head dot already says it). `when`: the check's time, in the tooltip.
 */
export function ReachWord({ status, t, machine, onEdit, onStart, onUpdate, compact, bare, when }: {
  status: ReachStatus, t: StorageT, machine?: string | undefined, onEdit?: (() => void) | undefined, onStart?: (() => void) | undefined, onUpdate?: (() => void) | undefined
  compact?: boolean, bare?: boolean, when?: string | null | undefined
}): ReactNode {
  const run = status.fix === 'edit' ? onEdit : status.fix === 'start' ? onStart : status.fix === 'update' ? onUpdate : undefined
  const label = status.fix === 'edit' ? t('pgEditConnectionShort') : status.fix === 'start' ? t('rowStart') : status.fix === 'update' ? t('rowUpdate') : null
  const word = t(REACH_LABEL[status.key])
  const title = [word, when, status.detail].filter(Boolean).join('\n')
  return (
    <span className={css.reach} data-tone={status.tone} title={title}>
      {bare ? null : <Dot tone={status.tone} t={t} />}
      <span className={css.reachText}>{word}</span>
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
  const { s, t, view, open, onToggle, now } = props
  const on = props.actionsFor(s)
  const mc = useMachinesMaybe()
  const checkingSides = new Set(props.checking ? ['host', ...(s.attached ?? []).map((a) => a.machine)] : [])
  const sum = pgSummary(s, view, checkingSides)
  const hostFailed = sum.host.tone === 'danger'
  const address = pgAddress(s)
  const projects = t(sum.projects === 1 ? 'msProjectOne' : 'msProjectCount', { n: sum.projects })
  const at = s.postgresql?.host?.at
  const hostTip = at ? t('rowHostDot', { status: t(REACH_LABEL[sum.host.key]), when: ago(at, now, t as Translate) }) : t('rowHostDotNever', { status: t(REACH_LABEL[sum.host.key]) })
  const kind = (platform: string) => mc?.kind(platform) ?? platform
  const members: GroupMember[] = sum.machines.map((m) => ({ name: m.machine, provider: m.platform ?? '', tone: m.status.tone, words: t(REACH_LABEL[m.status.key]) }))
  const only = members.length === 1 ? members[0]! : null
  const machines = !members.length ? (
    <button type="button" className={css.link} onClick={(e) => { stop(e); on.attach() }}>{t('rowAttachShort')}</button>
  ) : only ? (
    // one machine: its icon with its reach's dot, and its name (as a SQLite Store's machine)
    <span className={css.machine} role="img" aria-label={`${only.name} (${kind(only.provider)}): ${only.words}`} title={`${only.name} · ${kind(only.provider)} · ${only.words}`}>
      <span className={css.icon}><MachineGlyph platform={only.provider} size={14} /><StatusDot className={css.iconDot} state={dotState(only.tone)} size={6} /></span>
      <span className={css.machineName}>{only.name}</span>
    </span>
  ) : (
    <ProviderIcons groups={providerGroups(members)} glyph={(p) => <MachineGlyph platform={p} size={14} />}
      label={members.map((m) => `${m.name} (${kind(m.provider)}): ${m.words}`).join(', ')} />
  )
  const cells = (
    <>
      <CountCell n={sum.projects} words={projects} />
      <span className={css.cell} data-cell="machine">{machines}</span>
      <span className={css.cell} data-cell="address">
        {hostFailed ? (
          <span className={css.hostFailed} title={address ?? undefined}>
            <ReachWord status={sum.host} t={t} bare compact />
            <button type="button" className={css.link} onClick={(e) => { stop(e); on.editConnection() }}>{t('pgEditConnectionShort')}</button>
          </span>
        ) : address ? (
          <span className={css.address}>
            <span className={css.mono} title={address}>{address}</span>
            <CopyAddress text={s.postgresql?.url ?? address} t={t} />
          </span>
        ) : <span className={css.muted}>{t('rowNoAddress')}</span>}
      </span>
    </>
  )
  const add = canAddProject(s) ? <button type="button" className={mcss.columnAction} onClick={on.addProject}>{plusSmall}{t('addProject')}</button> : null
  return (
    <li className={css.row} data-store={s.name} data-kind="postgresql" data-host={sum.host.key}>
      <Head s={s} open={open} onToggle={onToggle} t={t} cells={cells} onOpen={() => props.onOpenStore(s.name)}
        icon={<StoreIcon kind="postgresql" tone={sum.host.tone} label={hostTip} />}
        menu={<StoreMenu store={s} on={on} t={t} onOpen={() => props.onOpenStore(s.name)} />} />
      {open ? (
        <div id={`lfs-row-postgresql-${s.name}`} className={css.panel}>
          <ProjectsList {...props} stale={hostFailed} action={add} />
          <section className={css.pane} aria-label={t('ovMachines')}>
            <PaneHead title={t('ovMachines')} count={(s.attached ?? []).length}>
              <button type="button" className={mcss.columnAction} disabled={props.checking} onClick={props.onCheck}>{props.checking ? t('stChecking') : t('pgCheck')}</button>
              <button type="button" className={mcss.columnAction} onClick={on.attach}>{plusSmall}{t('rowAttachMachine')}</button>
            </PaneHead>
            <AttachedLines s={s} view={view} t={t} on={on} checking={checkingSides} sandboxes={props.sandboxes} onMore={() => props.onOpenStore(s.name)} />
          </section>
        </div>
      ) : null}
    </li>
  )
}

/**
 * The machines attached to a PostgreSQL Store, one row each: its mark, name,
 * provider, the running Sandboxes' count, its reach, then × (detach; kept
 * disabled with why while Sandboxes of the Store run there). `cap` rows, then
 * `+N →`. On a narrow column the reach goes under the name.
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
          const boxes = (sandboxes ?? []).filter((b) => b.machine === a.machine && b.project?.startsWith(`${s.name}/`)).length
          const provider = mc?.kind(record?.platform ?? '') ?? record?.platform ?? ''
          const beside = providerBeside(a.machine, provider)
          const busy = boxes ? t('rowDetachBusy', { n: boxes, machine: a.machine }) : null
          return (
            <li key={a.machine} className={clsx(css.item, css.machineItem)} data-machine={a.machine}>
              <span className={css.itemMark}><MachineGlyph platform={record?.platform ?? ''} size={14} /></span>
              <button type="button" className={clsx(css.linkPlain, css.itemName)} title={provider ? `${a.machine} · ${provider}` : a.machine} onClick={() => on.openMachine(a.machine)}>{a.machine}</button>
              <span className={css.itemMeta}>{beside}</span>
              <span className={css.itemEnd}>
                {boxes ? <span className={css.boxes} title={busy ?? undefined} aria-label={t(boxes === 1 ? 'pgSandboxOne' : 'pgSandboxes', { n: boxes })}><SandboxGlyph size={12} />{boxes}</span> : null}
                <ReachWord status={status} t={t} machine={a.machine} onEdit={on.editConnection} onStart={() => on.startMachine(a.machine)} onUpdate={() => on.openMachine(a.machine)} />
              </span>
              <button type="button" className={css.detach} disabled={!!busy} aria-label={t('rowDetach', { machine: a.machine })} title={busy ?? t('rowDetach', { machine: a.machine })} onClick={() => on.detach(a.machine)}>
                <IconCloseOutlineRegular size={11} />
              </button>
            </li>
          )
        })}
      </ul>
      {more && onMore ? <button type="button" className={css.link} onClick={onMore}>{t('rowMoreMachines', { n: more })}</button> : null}
    </>
  )
}

/**
 * An unfolded PostgreSQL row's machines, one line each as on the Machines
 * board: the provider's glyph with its reach's dot, the name (opens the
 * machine), the provider, the running Sandboxes' count, the reach's words
 * and its one fix, then × (detach; kept disabled with why while Sandboxes of
 * the Store run there). LIST_ROWS lines, then `+N machines →`.
 */
function AttachedLines({ s, view, t, on, checking, sandboxes, onMore }: {
  s: StoreRow, view: Pick<StorageView, 'machines'>, t: StorageT, on: StoreActions, checking: ReadonlySet<string>, sandboxes?: Sandboxes | undefined, onMore: () => void
}): ReactNode {
  const mc = useMachinesMaybe()
  const rows = s.attached ?? []
  if (!rows.length) return <p className={mcss.inventoryEmpty}>{t('rowNoMachinesBody')}</p>
  const { shown, more } = capped(rows, LIST_ROWS)
  return (
    <>
      <ul className={mcss.lines}>
        {shown.map((a) => {
          const record = view.machines.find((m) => m.name === a.machine)
          const status = reachStatus(a.reach, { checking: checking.has(a.machine), machine: record ? { state: record.state, reason: record.reason ?? null } : null })
          const boxes = (sandboxes ?? []).filter((b) => b.machine === a.machine && b.project?.startsWith(`${s.name}/`)).length
          const provider = mc?.kind(record?.platform ?? '') ?? record?.platform ?? ''
          const busy = boxes ? t('rowDetachBusy', { n: boxes, machine: a.machine }) : null
          return (
            <li key={a.machine}>
              <div className={clsx(mcss.line, css.staticLine, css.attachedLine)} data-machine={a.machine}>
                <LineGlyph glyph={<MachineGlyph platform={record?.platform ?? ''} size={14} />} tone={status.tone} />
                <button type="button" className={clsx(css.linkPlain, mcss.lineName)} title={provider ? `${a.machine} · ${provider}` : a.machine} onClick={() => on.openMachine(a.machine)}>{a.machine}</button>
                <span className={clsx(mcss.lineMeta, css.lineWords)}>{providerBeside(a.machine, provider)}</span>
                <span className={css.lineEnd}>
                  {boxes ? <span className={css.boxes} title={busy ?? undefined} aria-label={t(boxes === 1 ? 'pgSandboxOne' : 'pgSandboxes', { n: boxes })}><SandboxGlyph size={12} />{boxes}</span> : null}
                  <ReachWord status={status} t={t} machine={a.machine} bare onEdit={on.editConnection} onStart={() => on.startMachine(a.machine)} onUpdate={() => on.openMachine(a.machine)} />
                </span>
                <button type="button" className={css.detach} disabled={!!busy} aria-label={t('rowDetach', { machine: a.machine })} title={busy ?? t('rowDetach', { machine: a.machine })} onClick={() => on.detach(a.machine)}>
                  <IconCloseOutlineRegular size={11} />
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      {more ? <button type="button" className={clsx(css.link, css.moreLink)} onClick={onMore}>{t('rowMoreMachines', { n: more })}</button> : null}
    </>
  )
}

// ---------- projects (both kinds) ----------

/**
 * A Store's projects, one line each as on the Machines board: the name
 * (opens the project), the Sandboxes running it, and its packed size ("no
 * commits yet", or "No commits since Init" for a project holding only its
 * Init), largest first. `action` (Add project) goes in the head. `cap` lines,
 * then `+N projects →` (the Store page). `stale`: the host cannot reach the
 * database, so the list is greyed and the head says when LayerFS last read
 * the Store (`observed_at`).
 */
export function ProjectsList({ api, s, t, now, sandboxes, onOpenProject, onOpenStore, stale, action, cap = LIST_ROWS }: {
  api: LayerfsApi, s: StoreRow, t: StorageT, now: number, sandboxes?: Sandboxes | undefined
  onOpenProject: (key: string) => void, onOpenStore: (name: string) => void, stale?: boolean, action?: ReactNode, cap?: number | null
}): ReactNode {
  const q = useQuery(() => api.call<StoreProjectsView>('GET', `/api/stores/${enc(s.name)}/projects`), [api, s.name],
    { refresh: [s.projects.length, s.size?.bytes], cache: `store-projects:${s.name}` })
  const running = runningByProject(s.name, (sandboxes ?? []).map((b) => ({ project: b.project ?? null, state: b.state, live: b.live })))
  const rows = (q.data?.projects ?? s.projects.map((name) => ({ name, totals: null, last: null }) as never)).map((p: StoreProjectsView['projects'][number]) => ({
    name: p.name, bytes: p.totals ? p.totals.stored : null,
    // no commit at all; a project with its Init publication only says so
    empty: !!p.totals && !p.last && !p.totals.publications, initOnly: !!p.totals && !p.last && !!p.totals.publications,
    boxes: running.get(p.name) ?? 0,
  })).sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name))
  const { shown, more } = cap ? capped(rows, cap) : { shown: rows, more: 0 }
  const tt = t as Translate
  const meta = stale ? (s.observedAt ? t('rowLastRead', { when: ago(s.observedAt, now, tt) }) : t('rowLastReadPlain')) : null
  return (
    <section className={css.pane} data-stale={stale || undefined} aria-label={t('tabProjects')}>
      <PaneHead title={t('tabProjects')} count={s.projectsCount ?? rows.length} meta={meta}>{action}</PaneHead>
      {!rows.length ? <p className={mcss.inventoryEmpty}>{q.error && !q.data ? t('rowProjectsUnread') : action ? t('rowProjectsEmpty') : t('msNoProjects')}</p> : (
        <ul className={clsx(mcss.lines, css.projectLines)}>
          {shown.map((r) => (
            <li key={r.name}>
              <button type="button" className={clsx(mcss.line, css.projectLine)} title={r.name} onClick={() => onOpenProject(`${s.name}/${r.name}`)}>
                <span className={mcss.lineIcon} aria-hidden="true"><LayerfsGlyph size={14} /></span>
                <span className={mcss.lineName}>{r.name}</span>
                {r.boxes ? <span className={css.boxes} title={t(r.boxes === 1 ? 'pgSandboxOne' : 'pgSandboxes', { n: r.boxes })}><SandboxGlyph size={12} />{r.boxes}</span> : <span />}
                <span className={mcss.lineSize}>{r.bytes === null ? (q.loading || !q.data ? '…' : '—') : r.empty ? t('rowNoCommits') : r.initOnly ? t('spNoCommits') : bytes(r.bytes)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {more ? <button type="button" className={clsx(css.link, css.moreLink)} onClick={() => onOpenStore(s.name)}>{t('rowMoreProjects', { n: more })}</button> : null}
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
  const place = s.machine ?? '?'
  const tone = sqliteTone(state)
  const provider = mc?.kind(machine?.platform ?? '') ?? machine?.platform ?? ''
  const stateWord = t(state === 'ready' ? 'rowSqliteReady' : state === 'busy' ? 'rowSqliteBusy' : state === 'stopped' ? 'stMachineStopped' : 'rowSqliteAttention')
  const machineCell = (
    <span className={css.machine} title={provider ? `${place} · ${provider}${state === 'stopped' ? ` · ${stateWord}` : ''}` : place}>
      <MachineGlyph platform={machine?.platform ?? ''} size={14} />
      <button type="button" className={clsx(css.linkPlain, css.machineName, state === 'stopped' && css.muted)} aria-label={t('openMachine', { machine: place })}
        onClick={(e) => { stop(e); if (s.machine) on.openMachine(s.machine) }}>{place}</button>
      {state === 'stopped' ? <button type="button" className={css.link} aria-label={t('startMachine', { machine: place })} onClick={(e) => { stop(e); on.start() }}>{t('rowStart')}</button> : null}
    </span>
  )
  // each linked bucket: its provider, and whether its last backup failed, worked or never ran
  const members: GroupMember[] = s.links.map((l) => {
    const failed = linkFailed(l)
    return {
      name: l.bucket, provider: view.buckets.find((b) => b.name === l.bucket)?.provider ?? '',
      tone: failed ? 'danger' : l.last?.at ? 'ok' : 'idle',
      words: failed ? t('rowAttemptFailed') : l.last?.at ? ago(l.last.at, now, tt) : t('rowNeverBackedUp'),
    }
  })
  const backupCell = backups.buckets ? (
    <span className={css.backups}>
      <ProviderIcons groups={providerGroups(members)} glyph={(p) => <BucketMark provider={p || null} size={13} />}
        label={members.map((m) => `${m.name} (${providerWords(m.provider || null, t)}): ${m.words}`).join(', ')} />
      {backups.failed ? <span className={css.word} data-tone="danger">{t('rowBackupsFailed', { n: backups.failed })}</span>
        : <span className={css.when} title={backups.last ? t('rowLastBackup', { when: ago(backups.last, now, tt) }) : undefined}>{backups.last ? ago(backups.last, now, tt) : t('rowNeverBackedUp')}</span>}
    </span>
  ) : <span className={css.muted}>{t('rowNotBackedUp')}</span>
  const count = <CountCell n={projects} words={t(projects === 1 ? 'msProjectOne' : 'msProjectCount', { n: projects })} />
  const cells = running && job ? (
    <>
      {count}
      <span className={clsx(css.cell, css.job)} data-cell="job" onClick={stop}><JobLine job={job} t={t} /></span>
    </>
  ) : (
    <>
      {count}
      <span className={css.cell} data-cell="machine">{machineCell}</span>
      <span className={clsx(css.cell, css.cellNum)} data-cell="size" title={s.size?.stale && s.size.seen ? t('msSizeSeen', { when: ago(s.size.seen, now, tt) }) : t('rowStoreSizeTip')}>
        {s.size ? bytes(s.size.bytes) : t('sizeUnavailable')}
      </span>
      <span className={css.cell} data-cell="backups">{backupCell}</span>
    </>
  )
  const moveReason = storeWaitsFor(s, t, running)
  const add = canAddProject(s) && !running ? <button type="button" className={mcss.columnAction} onClick={on.addProject}>{plusSmall}{t('addProject')}</button> : null
  return (
    <li className={css.row} data-store={s.name} data-kind="sqlite" data-state={state}>
      <Head s={s} open={open} onToggle={onToggle} t={t} cells={cells} onOpen={() => props.onOpenStore(s.name)}
        icon={<StoreIcon kind="sqlite" tone={tone} label={stateWord} />}
        menu={<StoreMenu store={s} on={on} t={t} runningJob={running} onOpen={() => props.onOpenStore(s.name)} withRestore />} />
      {open ? (
        <div id={`lfs-row-sqlite-${s.name}`} className={css.panel}>
          <ProjectsList {...props} action={add} />
          <section className={css.pane} aria-label={t('backupsSection')}>
              <PaneHead title={t('backupsSection')} count={s.links.length}>
                <button type="button" className={mcss.columnAction} onClick={on.backup}>{plusSmall}{t('addBucket')}</button>
              </PaneHead>
              {!s.links.length ? <p className={mcss.inventoryEmpty}>{t('rowNoBuckets')}</p> : (
                <ul className={mcss.lines}>
                  {s.links.map((l) => {
                    const bucket = view.buckets.find((b) => b.name === l.bucket)
                    const failed = linkFailed(l)
                    const when = failed ? t('rowAttemptFailed') : l.last?.at ? ago(l.last.at, now, tt) : t('rowNeverBackedUp')
                    return (
                      <li key={`${l.bucket}/${l.file}`}>
                        <div className={clsx(mcss.line, css.staticLine, css.thingLine)}>
                          <LineGlyph glyph={<BucketMark provider={bucket?.provider ?? null} size={14} />} tone={failed ? 'danger' : l.last?.at ? 'ok' : 'idle'} quiet />
                          <span className={mcss.lineName} title={`${l.bucket}/${l.file}`}>{l.bucket}</span>
                          <span className={clsx(mcss.lineMeta, css.lineWords)} title={failed && l.last?.at ? t('rowLastBackup', { when: ago(l.last.at, now, tt) }) : undefined}>
                            {providerWords(bucket?.provider ?? null, t)}
                            <span aria-hidden="true">·</span>
                            <span className={css.lineState} data-tone={failed ? 'danger' : undefined}>{when}</span>
                          </span>
                          <span className={css.lineEnd}>
                            <button type="button" className={css.link} disabled={!!moveReason} title={moveReason ?? undefined} onClick={() => on.backupTo(l)}>{t('rowBackUp')}</button>
                          </span>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
          </section>
        </div>
      ) : null}
    </li>
  )
}
