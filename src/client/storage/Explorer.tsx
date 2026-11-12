/**
 * The Storage explorer: an IDE-style sidebar over everything a LayerFS home
 * holds. Four heads: the overview; Machines, the LayerFS Home and Docker as
 * they are and every created machine under its type (Lima, …), each machine a
 * folder with its Stores (its SQLite Stores and the PostgreSQL Stores attached
 * to it, each Store a folder of projects) and its Sandboxes (each a folder of
 * Workspaces); PostgreSQL (the databases this home connected, outside servers
 * like buckets); and the backup buckets. A project and the Sandboxes bound to
 * it point at each other. Clicking a row opens its page as an editor tab; a
 * chevron only expands. Rows carry their verbs on hover: push or pull a
 * SQLite Store, attach or detach a PostgreSQL one, power a machine, add a
 * Sandbox. Dragging a SQLite Store onto a machine places it there (a push, a
 * pull, or a pull then push); dragging a PostgreSQL Store onto a machine opens
 * the Attach dialog for it. Running transfers show under the tree.
 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronRightOutlineRegular, IconGaugeOutlineRegular, IconLinkOutlineRegular,
  IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, IconWorkspaceTreeOutlineRegular,
  Input, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { useMachinesContext } from '../machines/context.tsx'
import { MachineGlyph, MachinesGlyph, PowerGlyph, SandboxesGlyph, SandboxGlyph, StoreGlyph as StoresGlyph } from '../machines/icons.tsx'
import { BucketMark, providerWords } from './BucketPage.tsx'
import {
  BUILT_IN, downReason, machineState, powerOf, projectRef, sandboxesOn, stateLook, workspaceName,
  type AvailableView, type MachineInfo, type MachineSandbox, type WorkspaceInfo,
} from '../machines/model.ts'
import { MachineDialogs, MachineMenu, useMachineRun } from '../machines/parts.tsx'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import type { StorageT } from './locale.ts'
import {
  attachRefusal, attachmentSignal, attachmentsOf, backupChip, bucketFiles, bucketSignal, canMove, cardJob, doingWords, groupOf, inHome, latestBackup,
  orderStores, shareOf, storeSignal, worstSignal, type RowSignal,
} from './model.ts'
import { BucketGlyph, CloudGlyph, HomeGlyph, PullGlyph, PushGlyph, StoreGlyph, UnlinkGlyph } from './parts.tsx'
import type { BucketRow, PgAttachment, StorageJob, StorageView, StoreRow } from './types.ts'
import css from './Storage.module.css'

/**
 * A page the editor can hold: the overview, the machines board, a machine, a
 * Sandbox (`sandbox:<machine>/<name>`), a Store, a project or a bucket.
 */
export type TabId = 'overview' | 'machines' | `machine:${string}` | `sandbox:${string}` | `store:${string}` | `project:${string}` | `bucket:${string}` | `backup:${string}`

/**
 * A tree key that can expand: a group, a machine type (`t:`), a machine
 * (`m:`), a machine's Stores (`y:`) or Sandboxes (`x:`) folder, a Sandbox
 * (`w:<machine>/<name>`), a Store folder or a bucket folder.
 */
export type TreeKey = `g:${string}` | `t:${string}` | `m:${string}` | `y:${string}` | `x:${string}` | `w:${string}` | `s:${string}` | `b:${string}` | `p:${string}`

/** Whether `id` names a page the editor can hold. */
export function isTabId(id: string): id is TabId {
  return id === 'overview' || id === 'machines' || /^(machine|sandbox|store|project|bucket|backup):./.test(id)
}

/** What a row's hover verbs do to a Store. */
export interface StoreVerbs {
  /** Push a SQLite Store from the home to a machine (asks which). */
  push: (store: string) => void
  /** Pull a SQLite Store back to the home. */
  pull: (store: string) => void
  /** Attach a PostgreSQL Store to a machine (asks which, unless given). */
  attach: (store: string, machine?: string) => void
  /** Detach a PostgreSQL Store from a machine (asks first). */
  detach: (store: string, machine: string) => void
}

/** The machine a type folder or a place row stands for. */
interface Place {
  name: string
  platform: string
  state: string | null
  /** The machine as the Machines controller reads it (null before the first read or when it is not listed). */
  info: MachineInfo | null
  /** It cannot hold SQLite Stores (LayerFS's reason), so it takes no SQLite drop. */
  noSqlite: string | null
}

/** The PostgreSQL group. */
const PG: TreeKey = 'g:postgresql'

/** The drag data's type while a Store moves between places. */
const STORE_MIME = 'application/x-dsh-layerfs-store'

/** A backup file's glyph: a document with a folded corner. */
export function FileGlyph({ size = 14 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      <path d="M4 1.75h4.75L13.25 6.25v8h-9.25z" />
      <path d="M8.75 1.75V6.25h4.5" />
    </svg>
  )
}

interface RowProps {
  depth: number
  icon?: ReactNode
  label: ReactNode
  meta?: ReactNode
  /** A status dot with its reason (on hover and for screen readers); a collapsed parent carries its children's worst. */
  signal?: RowSignal | null | undefined
  /** The row is a folder: show its chevron; `open` drives it. */
  expandable?: boolean
  open?: boolean
  /** The row's page is the editor's active tab. */
  active?: boolean
  /** The row is one of the outline's section heads. */
  group?: boolean
  /** The row reads as a place holder, not a thing (an empty machine). */
  dim?: boolean
  title?: string
  onToggle?: () => void
  onOpen?: () => void
  actions?: ReactNode
  /** Actions shown while the row is hovered or focused (always on touch screens). */
  verbs?: ReactNode
  /** Drag a Store: source handlers on a Store folder's row. */
  draggable?: boolean
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void
  onDragEnd?: (e: React.DragEvent<HTMLDivElement>) => void
  /** Drop a Store: target handlers and its state ('ready' it accepts, 'over' the drag is on it). */
  dropState?: 'ready' | 'over'
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void
  onDragLeave?: (e: React.DragEvent<HTMLDivElement>) => void
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void
  /** Nested rows (a `role="group"` list) when the row is expanded. */
  children?: ReactNode
}

function Row({ depth, icon, label, meta, signal, expandable, open, active, group, dim, title, onToggle, onOpen, actions, verbs, draggable, onDragStart, onDragEnd, dropState, onDragOver, onDragLeave, onDrop, children }: RowProps): ReactNode {
  return (
    <li role="none">
      <div
        className={clsx(css.treeRow, group && css.treeGroupRow)}
        role="treeitem"
        aria-expanded={expandable ? !!open : undefined}
        aria-selected={active || undefined}
        data-active={active || undefined}
        data-dim={dim || undefined}
        data-drop={dropState}
        style={{ paddingLeft: 4 + depth * 14 }}
        title={[title, signal?.reason].filter(Boolean).join(' — ') || undefined}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
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
        {meta ? <span className={clsx(css.treeMeta, typeof meta === 'string' && css.treeMetaText)} title={typeof meta === 'string' ? meta : undefined}>{meta}</span> : null}
        {signal ? <span className={css.treeSignal} role="img" aria-label={signal.reason}><StateDot state={signal.state} size={12} /></span> : null}
        {verbs ? <span className={clsx(css.treeActions, css.treeVerbs)}>{verbs}</span> : null}
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
  /** A Store was dropped on a place ('native' is the home): a push, pull or move starts. */
  onPlace: (store: string, machine: string) => void
  onRefresh: () => void
  onNewStore: () => void
  onListAll: () => void
  onAddBucket: () => void
  /** Connect a PostgreSQL database as a Store. */
  onConnectDatabase: () => void
  /** A PostgreSQL Store was dropped on a machine: open the Attach dialog for it. */
  onAttach: (store: string, machine: string) => void
  /** The rows' hover verbs on Stores. */
  verbs: StoreVerbs
  /** Create a machine (the Add machine dialog). */
  onNewMachine: () => void
  /** Create a Sandbox on a running machine. */
  onNewSandbox: (machine: string) => void
}

export function Explorer({ view, t, now, jobs, dismissed, active, expanded, query, refreshing, listing, listingAll, onQuery, onToggle, onOpen, onPlace, onRefresh, onNewStore, onListAll, onAddBucket, onConnectDatabase, onAttach, verbs, onNewMachine, onNewSandbox }: ExplorerProps): ReactNode {
  const mc = useMachinesContext()
  const fleetRead = mc.useMachines((s) => s)
  const startups = mc.useStartups((s) => s)
  const fleet: AvailableView | null = fleetRead.data?.available ? fleetRead.data : null
  const q = query.trim().toLowerCase()
  const isOpen = (key: TreeKey) => q !== '' || expanded.has(key)
  const stores = orderStores(view.stores)
  const rows = stores.map((s) => {
    const hit = !q || `${s.name} ${s.kind} ${s.machine ?? ''} ${s.postgresql?.target ?? ''}`.toLowerCase().includes(q)
    const projects = s.projects.filter((p) => hit || p.toLowerCase().includes(q)).sort()
    return { s, projects, show: hit || projects.length > 0 }
  }).filter((x) => x.show)
  const buckets = view.buckets.filter((b) => !q || b.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name))
  const homeRows = rows.filter((x) => groupOf(x.s) === 'home')
  const machineRows = rows.filter((x) => groupOf(x.s) === 'machines')
  const pgRows = rows.filter((x) => groupOf(x.s) === 'postgresql')
  const attachable = view.features?.attach === true
  // the PostgreSQL Stores (matching the search) attached to each machine
  const attachedOn = (machine: string) => pgRows.flatMap((x) => {
    const a = attachmentsOf(x.s).find((y) => y.machine === machine)
    return a ? [{ s: x.s, a, projects: x.projects }] : []
  })
  const membersOf = (machine: string) => (machine === 'native' ? homeRows : machineRows.filter((x) => x.s.machine === machine))

  // Every machine: the controller's list, Storage's places, and any a Store still names or a PostgreSQL Store is attached to.
  const named = [...machineRows.map((x) => x.s.machine), ...pgRows.flatMap((x) => attachmentsOf(x.s).map((a) => a.machine))]
  const names = new Set<string>(['native', ...(fleet?.machines.map((m) => m.name) ?? []), ...view.machines.map((m) => m.name), ...named.filter((m): m is string => !!m)])
  const places: Place[] = [...names].map((name) => {
    const info = fleet?.machines.find((m) => m.name === name) ?? null
    const listed = view.machines.find((m) => m.name === name)
    const supports = info?.supports ?? listed?.supports ?? null
    return {
      name,
      platform: info?.platform ?? listed?.platform ?? (name === 'native' ? 'native' : ''),
      state: info?.state ?? listed?.state ?? null,
      info,
      noSqlite: supports && supports.sqlite === false ? supports.reason ?? '' : null,
    }
  })
  // Sandboxes by machine, and by the project they are bound to.
  const sandboxesOf = (p: Place): MachineSandbox[] => (fleet && p.info ? sandboxesOn(fleet, p.info) : [])
  const bound = new Map<string, MachineSandbox[]>()
  for (const b of fleet?.sandboxes ?? []) {
    if (!b.project) continue
    const ref = projectRef(b.project)
    const key = `${ref.store ?? '?'}/${ref.name}`
    bound.set(key, [...(bound.get(key) ?? []), b])
  }
  const boundTo = (store: string, project: string) => bound.get(`${store}/${project}`) ?? bound.get(`?/${project}`) ?? []
  const sandboxHit = (b: MachineSandbox) => `${b.name} ${b.project ?? ''}`.toLowerCase().includes(q)

  // Each Store's dot and why; a collapsed place or group shows the worst of what it hides.
  const signals = new Map(view.stores.map((s) => [s.name, storeSignal(s, cardJob(jobs, s.name, dismissed, now),
    view.machines.find((m) => m.name === s.machine)?.state, view.buckets, t)]))
  const hidden = (open: boolean, members: typeof rows, attached: { a: PgAttachment }[] = [], extra: (RowSignal | null)[] = []) => (open ? null : worstSignal([
    ...members.map((x) => signals.get(x.s.name)),
    ...attached.map((x) => attachmentSignal(x.a, t)),
    ...extra,
  ]))
  /** A machine's own dot: it needs you, or it is starting, stopping, creating or removing. */
  const machineSignal = (p: Place): RowSignal | null => {
    const startup = startups[p.name]
    if (startup?.status === 'running') return { state: 'ongoing', reason: mc.t(p.platform === 'docker' ? 'startingWorker' : 'starting') }
    if (!p.info) return null
    const look = machineState(p.info, fleet?.status[p.name])
    if (look.key === 'needs') return { state: 'error', reason: downReason(p.info, fleet?.status[p.name]) ?? mc.stateWord(look) }
    if (look.key === 'busy' || look.op) return { state: 'ongoing', reason: mc.stateWord(look) }
    return null
  }
  const sandboxSignal = (b: MachineSandbox): RowSignal | null => {
    const look = stateLook('sandbox', b.state)
    if (look.attention) return { state: 'error', reason: mc.stateWord(look) }
    if (look.live || b.op) return { state: 'ongoing', reason: mc.stateWord(look) }
    return null
  }

  // The Store being dragged, and the place row under it.
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<TreeKey | null>(null)
  const storeOf = (name: string | null) => (name ? view.stores.find((s) => s.name === name) : undefined)
  const endDrag = () => { setDragging(null); setOver(null) }
  /** Whether a place takes the dragged Store: a sqlite Store from elsewhere, a PostgreSQL Store not attached and able to run there. */
  const takes = (s: StoreRow | undefined, p: Place) => !!s && (s.kind === 'postgresql'
    ? attachable && attachRefusal(view, s, p.name, t) === null
    : s.machine !== p.name && p.noSqlite === null)
  /** A place row's drop props ('native' is the home). */
  const dropFor = (key: TreeKey, p: Place) => {
    const accepts = takes(storeOf(dragging), p)
    const dragged = storeOf(dragging)
    const why = dragged && !accepts
      ? dragged.kind === 'postgresql' ? attachRefusal(view, dragged, p.name, t) : p.noSqlite || null
      : null
    return {
      dropState: (over === key && accepts ? 'over' : accepts ? 'ready' : undefined) as 'over' | 'ready' | undefined,
      ...(why ? { title: why } : {}),
      onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
        const s = storeOf(dragging)
        if (!takes(s, p) || !e.dataTransfer.types.includes(STORE_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = s!.kind === 'postgresql' ? 'link' : 'move'
        if (over !== key) setOver(key)
      },
      onDragLeave: (e: React.DragEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === key ? null : o))
      },
      onDrop: (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault()
        const s = storeOf(e.dataTransfer.getData(STORE_MIME) || dragging)
        endDrag()
        if (!s || !takes(s, p)) return
        if (s.kind === 'postgresql') onAttach(s.name, p.name)
        else onPlace(s.name, p.name)
      },
    }
  }
  const storeNodes = (members: typeof rows, depth: number) => members.map(({ s, projects }) => (
    <StoreNode key={s.name} depth={depth} store={s} projects={projects} signal={signals.get(s.name) ?? null} t={t} now={now}
      active={active} open={isOpen(`s:${s.name}`)} draggable={canMove(s) || (s.kind === 'postgresql' && attachable)}
      verbs={verbs} attachable={attachable} boundTo={boundTo}
      onToggle={onToggle} onOpen={onOpen} onDrag={(name) => (name ? setDragging(name) : endDrag())} />
  ))
  /** A PostgreSQL Store attached to a machine: the same row as a SQLite Store there (its projects inside), with Detach for its verb. */
  const attachmentNodes = (attached: { s: StoreRow, a: PgAttachment, projects: string[] }[], depth: number) => attached.map(({ s, a, projects }) => (
    <StoreNode key={`pg:${s.name}`} depth={depth} store={s} projects={projects} attachment={a}
      signal={worstSignal([signals.get(s.name) ?? null, attachmentSignal(a, t)])} t={t} now={now}
      active={active} open={isOpen(`s:${s.name}@${a.machine}`)} draggable={false}
      verbs={verbs} attachable={attachable} boundTo={boundTo}
      onToggle={onToggle} onOpen={onOpen} onDrag={() => {}} />
  ))

  /** One machine: its row, then its Stores and Sandboxes folders. Under its type's row (`typed`) the type carries the brand mark and the machine a plain server. */
  const machineNode = (p: Place, depth: number, typed = false) => {
    const members = membersOf(p.name)
    const attached = attachedOn(p.name)
    const sandboxes = sandboxesOf(p)
    const selfHit = q !== '' && p.name.toLowerCase().includes(q)
    const shownSandboxes = q === '' || selfHit ? sandboxes : sandboxes.filter(sandboxHit)
    const home = p.name === 'native'
    if (q !== '' && !selfHit && members.length === 0 && attached.length === 0 && shownSandboxes.length === 0) return null
    const key = `m:${p.name}` as TreeKey
    const storesKey = `y:${p.name}` as TreeKey
    const sandboxesKey = `x:${p.name}` as TreeKey
    const open = isOpen(key)
    const look = p.info ? machineState(p.info, fleet?.status[p.name]) : null
    const running = look?.key === 'running' && startups[p.name]?.status !== 'running'
    const meta = look && !running && look.key !== 'needs' && !home ? mc.stateWord(look) : p.state === 'stopped' ? t('placeStopped') : undefined
    const storeSignals = hidden(isOpen(storesKey) && open, members, attached)
    const sandboxSignals = shownSandboxes.map(sandboxSignal)
    return (
      <Row key={p.name} depth={depth} expandable open={open} label={home ? t('groupHome') : p.name}
        icon={home ? <HomeGlyph size={15} /> : typed ? <MachinesGlyph size={14} /> : <MachineGlyph platform={p.platform} size={15} mono />}
        dim={p.state === 'stopped'}
        meta={meta}
        signal={worstSignal([machineSignal(p), open ? null : worstSignal([storeSignals, ...sandboxSignals])])}
        title={p.platform ? [mc.kind(p.platform), p.state].filter(Boolean).join(' · ') : undefined}
        active={active === `machine:${p.name}`}
        onToggle={() => onToggle(key)} onOpen={() => onOpen(`machine:${p.name}`)}
        verbs={p.info ? <MachineVerbs m={p.info} onRemoved={() => onOpen('machines')} /> : undefined}
        {...dropFor(key, p)}>
        {open ? (
          <ul role="group" className={css.treeLevel}>
            <Row depth={depth + 1} expandable open={isOpen(storesKey)} label={t('storesFolder')}
              icon={<StoresGlyph size={13} />} meta={String(members.length + attached.length)}
              signal={hidden(isOpen(storesKey), members, attached)} onToggle={() => onToggle(storesKey)}>
              {isOpen(storesKey) ? (
                <ul role="group" className={css.treeLevel}>
                  {members.length === 0 && attached.length === 0
                    ? <li role="none"><p className={css.treeHint} style={{ paddingLeft: 24 + (depth + 2) * 14 }}>{p.noSqlite !== null ? p.noSqlite || t('noStoresHere') : t('placeEmpty')}</p></li>
                    : <>{storeNodes(members, depth + 2)}{attachmentNodes(attached, depth + 2)}</>}
                </ul>
              ) : null}
            </Row>
            {p.info ? (
              <Row depth={depth + 1} expandable open={isOpen(sandboxesKey)} label={t('sandboxesFolder')}
                icon={<SandboxesGlyph size={13} />} meta={String(shownSandboxes.length)}
                signal={isOpen(sandboxesKey) ? null : worstSignal(sandboxSignals)} onToggle={() => onToggle(sandboxesKey)}
                verbs={(
                  <Button variant="ghost" size="sm" className={css.sideButton}
                    aria-label={running ? t('newSandbox') : t('startToSandbox', { machine: home ? t('groupHome') : p.name })}
                    title={running ? t('newSandbox') : t('startToSandbox', { machine: home ? t('groupHome') : p.name })}
                    icon={<IconPlusOutlineRegular size={13} />} onClick={() => (running ? onNewSandbox(p.name) : onOpen(`machine:${p.name}`))} />
                )}>
                {isOpen(sandboxesKey) ? (
                  <ul role="group" className={css.treeLevel}>
                    {shownSandboxes.length === 0
                      ? <li role="none"><p className={css.treeHint} style={{ paddingLeft: 24 + (depth + 2) * 14 }}>{t('noSandboxesHere')}</p></li>
                      : shownSandboxes.map((b) => (
                        <SandboxNode key={b.name} sandbox={b} machine={p.name} depth={depth + 2} t={t} active={active}
                          open={isOpen(`w:${p.name}/${b.name}`)} signal={sandboxSignal(b)} onToggle={onToggle} onOpen={onOpen} />
                      ))}
                  </ul>
                ) : null}
              </Row>
            ) : null}
          </ul>
        ) : null}
      </Row>
    )
  }

  // The LayerFS Home and Docker stand alone; created machines sit under their type.
  const typed = (p: Place) => !!p.platform && !BUILT_IN.has(p.platform)
  const rank = (p: Place) => (p.name === 'native' ? 0 : p.platform === 'docker' ? 1 : 2)
  const loose = places.filter((p) => !typed(p)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  const types = [...new Set(places.filter(typed).map((p) => p.platform))].sort((a, b) => mc.kind(a).localeCompare(mc.kind(b)))
  const canCreate = !!fleet && fleet.platforms.some((x) => x.how === 'created')
  const running = jobs.filter((j) => !j.ended)
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
        <Input icon={<IconSearchOutlineRegular size={13} />} placeholder={t('filterPlaceholder')} aria-label={t('searchPlaceholder')}
          value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); onQuery('') } }} />
      </div>
      <div className={css.treeScroll}>
        <ul className={css.tree} role="tree" aria-label={t('treeLabel')}>
          <Row depth={0} icon={<IconGaugeOutlineRegular size={14} />} label={t('overview')} active={active === 'overview'} onOpen={() => onOpen('overview')} />
          <Row depth={0} group expandable open={isOpen('g:machines')} label={t('groupMachines')}
            active={active === 'machines'}
            signal={isOpen('g:machines') ? null : worstSignal([hidden(false, rows), ...places.map(machineSignal)])}
            onToggle={() => onToggle('g:machines')} onOpen={() => onOpen('machines')}
            actions={canCreate ? (
              <Button variant="ghost" size="sm" className={css.sideButton} aria-label={t('newMachine')} title={t('newMachine')}
                icon={<IconPlusOutlineRegular size={13} />} onClick={onNewMachine} />
            ) : undefined}>
            {isOpen('g:machines') ? (
              <ul role="group" className={css.treeLevel}>
                {fleetRead.status === 'error' && !fleet
                  ? <li role="none"><p className={css.treeHint}>{t('machinesUnread')}</p></li>
                  : null}
                {loose.map((p) => machineNode(p, 1))}
                {types.map((platform) => {
                  const members = places.filter((p) => p.platform === platform).sort((a, b) => a.name.localeCompare(b.name))
                  const nodes = members.map((p) => machineNode(p, 2, true)).filter(Boolean)
                  if (q !== '' && nodes.length === 0) return null
                  const key = `t:${platform}` as TreeKey
                  const creatable = !!fleet?.platforms.some((x) => x.platform === platform && x.how === 'created')
                  return (
                    <Row key={key} depth={1} expandable open={isOpen(key)} label={mc.kind(platform)}
                      icon={<MachineGlyph platform={platform} size={15} mono />} meta={String(members.length)}
                      signal={isOpen(key) ? null : worstSignal(members.map(machineSignal))}
                      onToggle={() => onToggle(key)}
                      verbs={creatable ? (
                        <Button variant="ghost" size="sm" className={css.sideButton} aria-label={t('newMachineOf', { kind: mc.kind(platform) })}
                          title={t('newMachineOf', { kind: mc.kind(platform) })} icon={<IconPlusOutlineRegular size={13} />} onClick={onNewMachine} />
                      ) : undefined}>
                      {isOpen(key) ? <ul role="group" className={css.treeLevel}>{nodes}</ul> : null}
                    </Row>
                  )
                })}
              </ul>
            ) : null}
          </Row>
          <Row depth={0} group expandable open={isOpen(PG)} label={t('groupPostgresql')}
            signal={hidden(isOpen(PG), pgRows)} onToggle={() => onToggle(PG)}
            actions={(
              <Button variant="ghost" size="sm" className={css.sideButton} aria-label={t('connectDatabase')} title={t('connectDatabase')}
                icon={<IconPlusOutlineRegular size={13} />} onClick={onConnectDatabase} />
            )}>
            {isOpen(PG) ? (
              <ul role="group" className={css.treeLevel}>
                {view.stores.every((s) => s.kind !== 'postgresql') ? (
                  <Row depth={1} dim icon={<IconPlusOutlineRegular size={13} />} label={t('connectDatabaseRow')} title={t('noDatabasesBody')} onOpen={onConnectDatabase} />
                ) : pgRows.length === 0 ? (
                  <li role="none"><p className={css.treeHint}>{t('nothingMatches')}</p></li>
                ) : storeNodes(pgRows, 1)}
              </ul>
            ) : null}
          </Row>
          <Row depth={0} group expandable open={isOpen('g:backups')} label={t('tabBackups')}
            signal={isOpen('g:backups') ? null : worstSignal(view.buckets.map((b) => bucketSignal(bucketFiles(b, view.stores), t)))}
            onToggle={() => onToggle('g:backups')}
            actions={(
              <>
                {view.buckets.length > 0 ? (
                  <Button variant="ghost" size="sm" className={css.sideButton} aria-label={t('listAll')} title={t('listAll')}
                    disabled={listingAll}
                    icon={listingAll ? <StateDot state="ongoing" size={13} /> : <IconRefreshOutlineRegular size={13} />} onClick={onListAll} />
                ) : null}
                <Button variant="ghost" size="sm" className={css.sideButton} aria-label={t('addBucket')} title={t('addBucket')}
                  icon={<IconPlusOutlineRegular size={13} />} onClick={onAddBucket} />
              </>
            )}>
            {isOpen('g:backups') ? (
              <ul role="group" className={css.treeLevel}>
                {view.buckets.length === 0 ? (
                  <Row depth={1} dim icon={<IconPlusOutlineRegular size={13} />} label={t('connectBucketRow')} title={t('noBucketsBody')} onOpen={onAddBucket} />
                ) : buckets.length === 0 ? (
                  <li role="none"><p className={css.treeHint}>{t('nothingMatches')}</p></li>
                ) : providersOf(buckets).map((provider) => {
                  // grouped by provider like machines by type: Cloudflare R2, MinIO, then any other
                  const members = buckets.filter((b) => providerKey(b.provider) === provider)
                  const key = `p:${provider}` as TreeKey
                  return (
                    <Row key={key} depth={1} expandable open={isOpen(key)} label={providerWords(provider === 'other' ? null : provider, t)}
                      icon={<BucketMark provider={provider} size={14} />} meta={String(members.length)}
                      signal={isOpen(key) ? null : worstSignal(members.map((b) => bucketSignal(bucketFiles(b, view.stores), t)))}
                      onToggle={() => onToggle(key)}>
                      {isOpen(key) ? (
                        <ul role="group" className={css.treeLevel}>
                          {members.map((b) => (
                            <BucketNode key={b.name} bucket={b} stores={view.stores} t={t} active={active} listing={listing === b.name}
                              open={isOpen(`b:${b.name}`)} onToggle={onToggle} onOpen={onOpen} />
                          ))}
                        </ul>
                      ) : null}
                    </Row>
                  )
                })}
              </ul>
            ) : null}
          </Row>
        </ul>
      </div>
      {running.length > 0 ? (
        <section className={css.transfers} aria-label={t('transfers')}>
          <h3 className={css.transfersTitle}>{t('transfers')}</h3>
          <ul className={css.transfersList}>
            {running.map((j) => (
              <li key={j.id}>
                <button type="button" className={css.transfer} title={t('transferOpen', { name: j.store })} onClick={() => onOpen(`store:${j.store}`)}>
                  <StateDot state="ongoing" size={12} />
                  <span className={css.transferLabel}>{doingWords(j, t)}</span>
                  <span className={css.transferShare}>{`${Math.round(shareOf(j) * 100)}%`}</span>
                </button>
                <span className={css.transferBar} aria-hidden="true"><span className={css.transferFill} style={{ width: `${Math.round(shareOf(j) * 100)}%` }} /></span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  )
}

/** A machine row's verbs: power, then the machine's menu (power, settings, remove) and its dialogs. */
function MachineVerbs({ m, onRemoved }: { m: MachineInfo, onRemoved: () => void }): ReactNode {
  const { t, useStartups } = useMachinesContext()
  const startup = useStartups((all) => all[m.name])
  const { run, pending: localPending } = useMachineRun()
  const pending = localPending ?? (startup?.status === 'running' ? startup.kind : null)
  const [dialog, setDialog] = useState<'settings' | 'remove' | 'force-stop' | null>(null)
  const power = powerOf(m)
  const label = power ? t(power === 'stop' ? 'powerRunningTitle' : 'powerStoppedTitle', { name: m.name }) : ''
  return (
    <>
      {pending !== null
        ? <span className={css.sideButton} role="img" aria-label={t('starting')}><StateDot state="ongoing" size={12} /></span>
        : power ? (
          <Button variant="ghost" size="sm" className={css.sideButton} aria-label={label} title={label} icon={<PowerGlyph size={13} />}
            onClick={(e) => { e.stopPropagation(); void run(power, power === 'start' ? { kind: 'start', name: m.name, platform: m.platform } : { kind: 'stop', name: m.name }) }} />
        ) : null}
      <MachineMenu m={m} pending={pending} run={run} onDialog={setDialog} />
      <MachineDialogs m={m} dialog={dialog} onClose={() => setDialog(null)} pending={pending} run={run} onRemoved={onRemoved} />
    </>
  )
}

/** One Sandbox: its row (with the project it is bound to), and its Workspaces read when it opens. */
function SandboxNode({ sandbox: b, machine, depth, t, active, open, signal, onToggle, onOpen }: {
  sandbox: MachineSandbox, machine: string, depth: number, t: StorageT, active: TabId | null, open: boolean, signal: RowSignal | null
  onToggle: (key: TreeKey) => void, onOpen: (id: TabId) => void
}): ReactNode {
  const { readSandbox } = useMachinesContext()
  const key = `w:${machine}/${b.name}` as TreeKey
  const tab = `sandbox:${machine}/${b.name}` as TabId
  const [read, setRead] = useState<{ data: WorkspaceInfo[] | null, error: boolean }>({ data: null, error: false })
  useEffect(() => {
    if (!open) return
    let gone = false
    readSandbox(b.name).then((info) => { if (!gone) setRead({ data: info.workspaces ?? [], error: false }) }, () => { if (!gone) setRead((r) => ({ data: r.data, error: true })) })
    return () => { gone = true }
  }, [open, b.name, b.workspaces, b.state, readSandbox])
  const ref = b.project ? projectRef(b.project) : null
  return (
    <Row depth={depth} expandable open={open} icon={<SandboxGlyph size={14} />} label={b.name}
      meta={b.workspaces != null ? String(b.workspaces) : undefined}
      signal={signal} active={active === tab} onToggle={() => onToggle(key)} onOpen={() => onOpen(tab)}
      actions={ref ? (
        <button type="button" className={css.bindChip} title={t('boundProject', { name: ref.name })}
          onClick={(e) => { e.stopPropagation(); onOpen(ref.store ? `project:${ref.store}/${ref.name}` : tab) }}>
          <LayerfsGlyph size={11} />{ref.name}
        </button>
      ) : undefined}>
      {open ? (
        <ul role="group" className={css.treeLevel}>
          {read.data === null
            ? <li role="none"><p className={css.treeHint} style={{ paddingLeft: 24 + (depth + 1) * 14 }}>{read.error ? t('workspacesFailed') : t('workspacesReading')}</p></li>
            : read.data.length === 0
              ? <li role="none"><p className={css.treeHint} style={{ paddingLeft: 24 + (depth + 1) * 14 }}>{t('workspacesNone')}</p></li>
              : read.data.map((ws) => (
                <Row key={ws.ws} depth={depth + 1} icon={<IconWorkspaceTreeOutlineRegular size={13} />} label={workspaceName(ws)}
                  meta={ws.branch} title={ws.path} onOpen={() => onOpen(tab)} />
              ))}
        </ul>
      ) : null}
    </Row>
  )
}

function StoreNode({ store: s, projects, attachment: a, depth, signal, t, now, active, open, draggable, verbs, attachable, boundTo, onToggle, onOpen, onDrag }: {
  store: StoreRow, projects: readonly string[], depth: number, signal: RowSignal | null, t: StorageT, now: number
  /** Set when this row is a PostgreSQL Store shown under a machine it is attached to. */
  attachment?: PgAttachment
  active: TabId | null, open: boolean, draggable: boolean
  verbs: StoreVerbs, attachable: boolean
  /** The Sandboxes bound to one of this Store's projects. */
  boundTo: (store: string, project: string) => MachineSandbox[]
  onToggle: (key: TreeKey) => void, onOpen: (id: TabId) => void
  /** The drag starts (its Store's name) or ends (null). */
  onDrag: (name: string | null) => void
}): ReactNode {
  const key = (a ? `s:${s.name}@${a.machine}` : `s:${s.name}`) as TreeKey
  const machineWord = a ? (a.machine === 'native' ? t('groupHome') : a.machine) : ''
  // A SQLite Store linked to a bucket wears a cloud; its drift shows on the dot.
  const files = s.links.map((l) => `${l.bucket}/${l.file}`).join(', ')
  const latest = latestBackup(s)
  const cover = s.kind === 'sqlite' && s.links.length > 0
    ? latest !== null ? t('backupCoverage', { files, ago: ago(latest, now, t as Translate) }) : t('backupCoverageNone', { files })
    : null
  const meta = cover || s.size ? (
    <>
      {cover ? <span className={css.treeCover} role="img" aria-label={cover} title={cover}><CloudGlyph /></span> : null}
      {s.size ? bytes(s.size.bytes) : null}
    </>
  ) : a?.own && a.target ? serverOf(a.target)
    : s.kind === 'postgresql' && s.postgresql?.target ? serverOf(s.postgresql.target) : undefined
  // A SQLite Store at home pushes to a machine; one on a machine pulls home; a PostgreSQL Store attaches (detaches under a machine).
  const idle = !s.job && s.state !== 'busy'
  const verb = a
    ? attachable ? { label: t('detachVerb', { name: s.name, machine: machineWord }), icon: <UnlinkGlyph />, run: () => verbs.detach(s.name, a.machine) } : null
    : s.kind === 'postgresql'
    ? attachable ? { label: t('attachVerb', { name: s.name }), icon: <IconLinkOutlineRegular size={13} />, run: () => verbs.attach(s.name) } : null
    : !idle ? null
      : inHome(s)
        ? s.state === 'idle' ? { label: t('pushVerb', { name: s.name }), icon: <PushGlyph />, run: () => verbs.push(s.name) } : null
        : { label: t('pullVerb', { name: s.name }), icon: <PullGlyph />, run: () => verbs.pull(s.name) }
  return (
    <Row depth={depth} expandable open={open} icon={<StoreGlyph kind={s.kind} size={14} mono />} label={s.name} meta={meta} signal={signal}
      title={a ? t('attachedTo', { machine: machineWord }) : undefined}
      active={active === `store:${s.name}`} onToggle={() => onToggle(key)} onOpen={() => onOpen(`store:${s.name}`)}
      verbs={verb ? <Button variant="ghost" size="sm" className={css.sideButton} aria-label={verb.label} title={verb.label} icon={verb.icon} onClick={verb.run} /> : undefined}
      draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.setData(STORE_MIME, s.name); e.dataTransfer.effectAllowed = s.kind === 'postgresql' ? 'link' : 'move'; onDrag(s.name) }}
      onDragEnd={() => onDrag(null)}>
      {open ? (
        <ul role="group" className={css.treeLevel}>
          {projects.length === 0 ? (
            <li role="none"><p className={css.treeHint}>{t('noProjects')}</p></li>
          ) : projects.map((p) => {
            const sandboxes = boundTo(s.name, p)
            const first = sandboxes[0]
            return (
              <Row key={p} depth={depth + 1} icon={<LayerfsGlyph size={14} />} label={p} active={active === `project:${s.name}/${p}`} onOpen={() => onOpen(`project:${s.name}/${p}`)}
                actions={first ? (
                  <button type="button" className={css.bindChip}
                    title={sandboxes.map((b) => t('boundSandbox', { name: b.name, machine: b.machine === 'native' ? t('groupHome') : b.machine ?? '?' })).join('\n')}
                    onClick={(e) => { e.stopPropagation(); onOpen(`sandbox:${first.machine ?? ''}/${first.name}`) }}>
                    <SandboxGlyph size={11} />{first.name}{sandboxes.length > 1 ? <span className={css.bindMore}>{t('moreBound', { n: sandboxes.length - 1 })}</span> : null}
                  </button>
                ) : undefined} />
            )
          })}
        </ul>
      ) : null}
    </Row>
  )
}

/** `user@host:port/db` as its server, `host:port`. */
const serverOf = (target: string) => target.replace(/^[^@]*@/, '').replace(/\/.*$/, '')

function BucketNode({ bucket: b, stores, t, active, listing, open, onToggle, onOpen }: {
  bucket: BucketRow, stores: readonly StoreRow[], t: StorageT, active: TabId | null, listing: boolean, open: boolean
  onToggle: (key: TreeKey) => void, onOpen: (id: TabId) => void
}): ReactNode {
  const key = `b:${b.name}` as TreeKey
  const rows = bucketFiles(b, stores)
  // one row per file: LayerFS lists a file once per linked Store
  const files = rows.filter((r, i) => rows.findIndex((x) => x.file === r.file) === i)
  return (
    <Row depth={2} expandable open={open} icon={<BucketGlyph size={14} />} label={b.name}
      signal={open || listing ? null : bucketSignal(rows, t)}
      active={active === `bucket:${b.name}`} onToggle={() => onToggle(key)} onOpen={() => onOpen(`bucket:${b.name}`)}
      actions={listing ? <StateDot state="ongoing" size={12} /> : undefined}>
      {open ? (
        <ul role="group" className={css.treeLevel}>
          {rows.length === 0 ? (
            <li role="none"><p className={css.treeHint}>{b.files ? t('bucketEmptyListed') : listing ? t('bucketListing') : t('bucketEmptyUnlisted')}</p></li>
          ) : files.map((r) => {
            const worst = worstSignal(rows.filter((x) => x.file === r.file).map((x) => {
              const chip = backupChip(x.state, t)
              const state = chip.tone === 'danger' ? 'error' as const : chip.tone === 'warning' ? 'warning' as const : null
              return state ? { state, reason: x.reason ?? chip.label } : null
            }))
            const id = `backup:${b.name}/${r.file}` as TabId
            return (
              <Row key={r.file} depth={3} icon={<FileGlyph />} label={r.file} meta={r.bytes !== null ? bytes(r.bytes) : undefined}
                signal={worst} active={active === id} onOpen={() => onOpen(id)} />
            )
          })}
        </ul>
      ) : null}
    </Row>
  )
}

/** A bucket's provider as a tree key: `r2`, `minio`, else `other`. */
const providerKey = (provider: string | null | undefined): string => (provider === 'r2' || provider === 'minio' ? provider : 'other')

/** The providers present, in a fixed order: Cloudflare R2, MinIO, other. */
function providersOf(buckets: readonly BucketRow[]): string[] {
  const present = new Set(buckets.map((b) => providerKey(b.provider)))
  return ['r2', 'minio', 'other'].filter((p) => present.has(p))
}
