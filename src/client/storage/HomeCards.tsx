/**
 * The Overview's card sections, each a wrapping grid of cards:
 *
 * - Projects: one card per project (trouble first), with its size (packed
 *   bytes on disk, main's files beside), the Store that holds it, and its
 *   Sandboxes. Where the Store runs and its backups are on the Store card.
 * - Machines: one card per machine: Start or Stop, its disk, the Stores on it
 *   (SQLite) or attached to it (PostgreSQL), its Sandboxes, and a transfer
 *   arriving on it.
 * - Connections: one card per PostgreSQL server, its databases and their
 *   projects, each database with the machines attached to it.
 *
 * Every name opens its editor tab; every button goes through the Storage
 * page's own dialogs and actions.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconChevronRightOutlineRegular, IconTrashOutlineRegular, MenuItemButton, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { MachineGlyph, SandboxGlyph } from '../machines/icons.tsx'
import { downReason, shortSandbox, workerDown, type AvailableView, type MachineInfo, type MachineSandbox } from '../machines/model.ts'
import { sandboxRuns } from '../machines/stats.ts'
import { machineBlock } from '../machines/needs.ts'
import { MoreMenu } from '../ui/index.tsx'
import { cachedAnswer, useQuery } from '../ui/use-query.ts'
import { enc, type LayerfsApi } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import type { TabId } from './tabs.ts'
import type { StorageT } from './locale.ts'
import { attachmentsOf, attachRefusal, doingWords, shareOf, type RowSignal } from './model.ts'
import { HomeGlyph, StoreGlyph } from './parts.tsx'
import type { StoreActions } from './StoreCard.tsx'
import { Signal } from './Signal.tsx'
import type { BucketRow, StorageJob, StorageView, StoreBackupLink, StoreRow } from './types.ts'
import { orderProjects, sizeCacheKey, type ProjectSize, type ProjectSort } from './project-list.ts'
import { projectSplit, type ProjectSplit } from './machine-stores.ts'
import { MachineLine } from './MachineStores.tsx'
import type { StoreProjectsView } from './store-page.ts'
import css from './HomeCards.module.css'

export type Place = (machine: string | null | undefined) => string

/** How often a project card asks again while its first size count runs. */
export const SIZE_POLL_MS = 3000




function Name({ children, onClick, title }: { children: ReactNode, onClick: () => void, title?: string }): ReactNode {
  return <button type="button" className={css.name} title={title} onClick={(e) => { e.stopPropagation(); onClick() }}>{children}</button>
}

/**
 * What keeps a Store's projects from opening, worst first: down, unresolved,
 * an unreachable PostgreSQL server, a machine that cannot reach it, or its
 * machine stopped. Backup state is not trouble here: the Store card shows it.
 */
/** A Store's trouble, short; `detail` is LayerFS's full words, `restart` the machine whose worker would fix it. */
export type Trouble = RowSignal & { detail?: string, restart?: MachineInfo }

export function storeTrouble(s: StoreRow, view: StorageView, t: StorageT, place: Place, fleet?: AvailableView | null): Trouble | null {
  // its machine's worker does not answer: say that, and offer the fix, instead of LayerFS's long refusal
  const host = s.kind === 'sqlite' ? fleet?.machines.find((m) => m.name === s.machine) : undefined
  // its machine cannot run here at all (Docker quit, Lima removed): say so; a restart would only fail
  if (host && fleet && machineBlock(host, fleet)) return { state: 'warning', reason: t('machineUnavailable', { machine: place(host.name) }) }
  if (host && workerDown(host, fleet?.status[host.name])) {
    return { state: 'error', reason: t('ovStoreWorkerDown', { machine: place(host.name) }), detail: s.down ?? downReason(host, fleet?.status[host.name]) ?? undefined, restart: host }
  }
  if (s.state === 'down') return { state: 'error', reason: t('stateDown'), detail: s.down ?? undefined }
  if (s.state === 'unresolved') return { state: 'error', reason: t('unresolved') }
  if (s.postgresql?.reachable === false) return { state: 'error', reason: s.postgresql.error ?? t('unreachable') }
  const broken = attachmentsOf(s).find((a) => a.lastError)
  if (broken) return { state: 'error', reason: t('ovAttachBroken', { store: s.name, machine: place(broken.machine) }) }
  if (s.kind === 'sqlite' && view.machines.find((m) => m.name === s.machine)?.state === 'stopped') return { state: 'warning', reason: t('machineStopped', { machine: place(s.machine) }) }
  return null
}

/** Restart worker inside a signal's hover card: busy while it runs, LayerFS's refusal as its tooltip. */
export function RestartButton({ m, t, onRestart }: { m: MachineInfo, t: StorageT, onRestart: (m: MachineInfo) => Promise<unknown> }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <Button variant="outline" size="sm" disabled={busy} title={failed ?? t('ovRestartWorkerTitle', { machine: m.name })}
      onClick={() => { setBusy(true); setFailed(null); void onRestart(m).catch((e: unknown) => setFailed(String((e as Error)?.message ?? e))).finally(() => setBusy(false)) }}>
      {busy ? t('ovRestarting') : failed ? t('ovRestartFailed') : t('ovRestartWorker')}
    </Button>
  )
}

/** A running push, pull, move, backup or restore, with its progress. */
export function JobLine({ job, t, label }: { job: StorageJob, t: StorageT, label?: string }): ReactNode {
  const share = Math.round(shareOf(job) * 100)
  return (
    <span className={css.job}>
      <span className={css.jobLine}><StateDot state="ongoing" size={10} /><span className={css.statusText}>{label ?? doingWords(job, t)}</span><span className={css.num}>{`${share}%`}</span></span>
      <span className={css.bar}><span style={{ width: `${share}%` }} /></span>
    </span>
  )
}





/** A Sandbox as a chip that opens it. */
function SandboxChip({ b, t, place, onOpen }: { b: MachineSandbox, t: StorageT, place: Place, onOpen: (id: TabId) => void }): ReactNode {
  return (
    <button type="button" className={css.chip} onClick={(e) => { e.stopPropagation(); onOpen(`sandbox:${b.machine ?? ''}/${b.name}`) }}
      title={[b.project, t('ovSandboxOn', { sandbox: b.name, machine: place(b.machine) })].filter(Boolean).join(' · ')}>
      <StateDot state={sandboxRuns(b) ? 'done' : 'idle'} size={6} />
      <SandboxGlyph size={11} /><span className={css.chipText}>{shortSandbox(b.name)}</span>
    </button>
  )
}

/**
 * A project's Sandboxes. A Sandbox names its project `store/project`; a bare
 * project name is only trusted when no other Store has a project of that name.
 */
export function sandboxesOfProject(sandboxes: readonly MachineSandbox[], stores: readonly StoreRow[], store: string, project: string): MachineSandbox[] {
  const unique = stores.filter((x) => x.projects.includes(project)).length === 1
  return sandboxes.filter((b) => b.project === `${store}/${project}` || (unique && b.project === project))
}

// ---------- projects: one card per project ----------

/**
 * A project's size on disk (its Store's packed bytes when it is alone there,
 * else what its saves wrote first), main's files beside. Drawn from the last
 * answer at once; "Counting…" only until a first count gives a number, polled meanwhile.
 */
function SizeValue({ api, store, project, alone, tick, t }: { api: LayerfsApi, store: string, project: string, alone: boolean, tick: number, t: StorageT }): ReactNode {
  const key = `${store}/${project}`
  const q = useQuery(() => api.call<ProjectSize>('GET', `/api/projects/${enc(key)}/size${alone ? '?alone=1' : ''}`), [api, key, alone],
    { refresh: [tick], cache: sizeCacheKey(key), persist: true })
  const z = q.data
  const waiting = !!z && z.stored === null && z.counting
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(q.reload, SIZE_POLL_MS)
    return () => clearTimeout(timer)
  }, [z, waiting, q.reload])
  if (!z) return <span className={css.muted}>{q.error ? '—' : t('ovSizeCounting')}</span>
  if (z.stored === null) return <span className={css.muted}>{z.counting ? t('ovSizeCounting') : '—'}</span>
  return (
    <>
      <span className={css.sizeValue} title={alone ? t('ovSizeTitleAlone') : t('ovSizeTitle')}>{bytes(z.stored)}</span>
      {z.files !== null ? <span className={css.factKind} title={t('ovSizeFilesTitle')}>{t('ovSizeFiles', { bytes: bytes(z.files) })}</span> : null}
    </>
  )
}

export function ProjectCards({ api, tick, query, sort, frozen, onClearSearch, stores, view, fleet, t, jobs, place, onOpen, onRemove, onRestart }: {
  api: LayerfsApi
  /** The search and sort above the cards (project-list.ts); `frozen` is the Size order. */
  query: string, sort: ProjectSort, frozen: readonly string[] | null
  onClearSearch: () => void
  /** Bumped by the Overview's refresh: each card reads its size again. */
  tick: number
  stores: readonly StoreRow[], view: StorageView, fleet: AvailableView | null, t: StorageT
  jobs: readonly StorageJob[], place: Place, onOpen: (id: TabId) => void
  /** Delete a project (the page's confirm dialog). */
  onRemove: (store: string, project: string) => void
  /** Start a machine's worker again (a Store whose machine does not answer). */
  onRestart?: (m: MachineInfo) => Promise<unknown>
}): ReactNode {
  const sandboxes = fleet?.sandboxes ?? []
  const rank = (x: Trouble | null) => (x?.state === 'error' ? 0 : x?.state === 'warning' ? 1 : 2)
  // Default: trouble first, then the Stores' own order; then the search and sort.
  const projects = orderProjects(stores
    .flatMap((s, order) => s.projects.map((p) => ({ s, p, store: s.name, project: p, order, trouble: storeTrouble(s, view, t, place, fleet) })))
    .sort((a, b) => rank(a.trouble) - rank(b.trouble) || a.order - b.order || a.p.localeCompare(b.p)), query, sort, frozen)
  if (projects.length === 0) {
    return (
      <div className={css.noMatch} role="status">
        <span>{t('ovNoMatch', { query: query.trim() })}</span>
        <Button variant="outline" size="sm" onClick={onClearSearch}>{t('ovClearSearch')}</Button>
      </div>
    )
  }
  return (
    <div className={css.cards}>
      {projects.map(({ s, p, trouble }) => {
        const pg = s.kind === 'postgresql'
        const boxes = sandboxesOfProject(sandboxes, stores, s.name, p)
        const job = jobs.find((j) => j.store === s.name && !j.ended)
        const open = () => onOpen(`project:${s.name}/${p}`)
        return (
          <article key={`${s.name}/${p}`} className={css.card} data-kind="project" data-clickable onClick={open}>
            <header className={css.cardHead}>
              <span className={css.icon} data-kind="project"><LayerfsGlyph size={17} /></span>
              <span className={css.titles}>
                <span className={css.nameLine}>
                  <Name onClick={open}>{p}</Name>
                  <Signal state={trouble ? trouble.state : 'ok'} title={trouble?.reason ?? t('ovSignalReady')} detail={trouble?.detail}
                    action={trouble?.restart && onRestart ? <RestartButton m={trouble.restart} t={t} onRestart={onRestart} /> : undefined} />
                </span>
              </span>
              {/* The card opens the project on click: nothing in its actions (the menu's portal included) reaches it. */}
              <span className={css.headActions} onClick={(e) => e.stopPropagation()}>
                <Button variant="outline" size="sm" onClick={open}>{t('ovOpen')}</Button>
                <MoreMenu label={t('projectActions', { name: p })}>
                  {(close) => (
                    <MenuItemButton danger icon={<IconTrashOutlineRegular size={14} />} onSelect={() => { close(); onRemove(s.name, p) }}>
                      {t('removeProject')}
                    </MenuItemButton>
                  )}
                </MoreMenu>
              </span>
            </header>
            <dl className={css.facts}>
              <dt>{t('ovFieldSize')}</dt>
              <dd><SizeValue api={api} store={s.name} project={p} alone={s.projects.length === 1} tick={tick} t={t} /></dd>
              <dt>{t('ovFieldStore')}</dt>
              <dd>
                <button type="button" className={css.storeChip} data-kind={s.kind} title={s.name}
                  onClick={(e) => { e.stopPropagation(); onOpen(`store:${s.name}`) }}>
                  <StoreGlyph kind={s.kind} size={12} /><span className={css.chipText}>{s.name}</span>
                </button>
                <span className={css.factKind}>{pg ? t('postgresql') : t('sqlite')}</span>
              </dd>
              {/* Always shown, so every card has the same rows. */}
              <dt>{t('ovTileSandboxes')}</dt>
              <dd className={css.chipRow}>
                {boxes.length
                  ? boxes.map((b) => <SandboxChip key={b.name} b={b} t={t} place={place} onOpen={onOpen} />)
                  : <span className={css.muted}>{t('none')}</span>}
              </dd>
            </dl>
            {job ? <footer className={css.cardFoot}><JobLine job={job} t={t} label={`${s.name} · ${doingWords(job, t)}`} /></footer> : null}
          </article>
        )
      })}
    </div>
  )
}

// ---------- connections: one card per PostgreSQL server LayerFS Home connects to ----------

/** Project rows a database shows before "+N projects" (one more fits in that line's place, so it is shown instead). */
const DB_ROWS = 3
/** Machine marks a folded database shows before "+N" (the menu lists them all). */
const MARKS = 3
/** A server with more databases than this starts with them folded. */
const OPEN_UP_TO = 3
/** Databases a server card lists before "Show all". */
const DB_CAP = 5
const FOLD_KEY = 'dsh-layerfs:connections-open'

/** A PostgreSQL Store's server (`host:port`), the key the Connections tab groups by. */
export const serverKey = (s: StoreRow): string => {
  const pg = s.postgresql
  if (pg?.server) return pg.server
  const target = pg?.target
  if (!target) return s.name
  const rest = target.slice(target.indexOf('@') + 1)
  const slash = rest.indexOf('/')
  return slash >= 0 ? rest.slice(0, slash) : rest
}

/** Databases this viewer folded or opened, by `server|store` (a per-browser convenience; storage may be blocked). */
function readFolds(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') as Record<string, boolean> } catch { return {} }
}

/**
 * The Connections tab: one card per PostgreSQL server LayerFS Home connects
 * to. The head names the server and says the host's check in words; then
 * each database (a Store) with its size and the machines attached to it as
 * marks, its projects beneath it; the foot has the totals and Add database
 * (another database on that server, with the same user and password).
 */
export function ConnectionCards({ api, stores, view, t, onOpen, actionsFor, onConnect }: {
  api: LayerfsApi
  /** The PostgreSQL Stores. */
  stores: readonly StoreRow[]
  view: StorageView
  t: StorageT
  onOpen: (id: TabId) => void
  actionsFor: (s: StoreRow) => StoreActions
  onConnect: () => void
}): ReactNode {
  const [folds, setFolds] = useState(readFolds)
  if (stores.length === 0) {
    return (
      <div className={css.emptyCard}>
        <span className={css.icon} data-kind="postgresql"><StoreGlyph kind="postgresql" size={16} /></span>
        <span className={css.titles}>
          <span className={css.emptyTitle}>{t('ovNoConnections')}</span>
          <span className={css.sub}>{t('ovNoConnectionsBody')}</span>
        </span>
        <Button variant="outline" size="sm" onClick={onConnect}>{t('connectDatabase')}</Button>
      </div>
    )
  }
  const toggle = (key: string, open: boolean) => {
    const next = { ...folds, [key]: open }
    setFolds(next)
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)) } catch { /* it still folds */ }
  }
  const groups = new Map<string, StoreRow[]>()
  for (const s of stores) groups.set(serverKey(s), [...(groups.get(serverKey(s)) ?? []), s])
  return (
    <div className={css.serverCards}>
      {[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([server, list]) => (
        <ServerCard key={server} api={api} server={server} stores={[...list].sort((a, b) => a.name.localeCompare(b.name))} view={view} t={t}
          isOpen={(name, n) => folds[`${server}|${name}`] ?? n <= OPEN_UP_TO} onToggle={(name, open) => toggle(`${server}|${name}`, open)}
          onOpen={onOpen} actionsFor={actionsFor} />
      ))}
    </div>
  )
}

function ServerCard({ api, server, stores, view, t, isOpen, onToggle, onOpen, actionsFor }: {
  api: LayerfsApi, server: string, stores: StoreRow[], view: StorageView, t: StorageT
  isOpen: (store: string, databases: number) => boolean
  onToggle: (store: string, open: boolean) => void
  onOpen: (id: TabId) => void, actionsFor: (s: StoreRow) => StoreActions
}): ReactNode {
  const failing = stores.find((s) => s.postgresql?.reachable === false)?.postgresql ?? null
  const reached = stores.find((s) => s.postgresql?.reachable === true)?.postgresql ?? null
  const user = stores.find((s) => s.postgresql?.user)?.postgresql?.user ?? null
  const version = reached?.version ? t('msPgShort', { version: reached.version.split(' ')[0]! }) : null
  const check = failing ? t('hsUnreachable') : reached ? t('msReachableMs', { latency: reached.latencyMs ?? '—' }) : t('msNotCheckedShort')
  const projects = stores.reduce((n, s) => n + s.projects.length, 0)
  const [all, setAll] = useState(false)
  const listed = all || stores.length <= DB_CAP + 1 ? stores : stores.slice(0, DB_CAP)
  return (
    <article className={css.serverCard} data-kind="server" data-server={server}>
      <header className={css.serverHead}>
        <StoreGlyph kind="postgresql" size={16} />
        <span className={css.serverName} title={server}>{server}</span>
      </header>
      <span className={css.serverCheck} data-state={failing ? 'error' : reached ? 'ok' : 'idle'} title={failing?.error ?? undefined}>
        <StateDot state={failing ? 'error' : reached ? 'done' : 'idle'} size={6} />
        <span className={css.serverCheckText}>{[check, user, version].filter(Boolean).join(' · ')}</span>
      </span>
      <div className={css.databases}>
        {listed.map((s) => (
          <Database key={s.name} api={api} s={s} view={view} t={t} on={actionsFor(s)} open={isOpen(s.name, stores.length)} onToggle={(open) => onToggle(s.name, open)} onOpen={onOpen} />
        ))}
        {stores.length > DB_CAP + 1 ? (
          <button type="button" className={css.dbShowAll} onClick={() => setAll(!all)}>
            {all ? t('ccShowFewer') : t('ccShowAll', { n: stores.length })}
          </button>
        ) : null}
      </div>
      <footer className={css.serverFoot}>
        <span className={css.serverTotals}>
          {[stores.length === 1 ? t('msDatabaseOne') : t('msDatabases', { n: stores.length }), projects === 1 ? t('msProjectOne') : t('msProjectCount', { n: projects })].join(' · ')}
        </span>
        <button type="button" className={css.inlineLink} onClick={() => actionsFor(stores[0]!).newOnServer()}>+ {t('ovConnectHere')}</button>
      </footer>
    </article>
  )
}

/**
 * A database's projects with their packed bytes, as the Store cards read them
 * (shared cache). Read only while it is open; folded, the last answer (from
 * here or a Store card) still gives its size.
 */
function useDbSplit(api: LayerfsApi, s: StoreRow, open: boolean): ProjectSplit | null {
  const key = `store-projects:${s.name}`
  const q = useQuery(() => (open ? api.call<StoreProjectsView>('GET', `/api/stores/${enc(s.name)}/projects`) : Promise.resolve(null)), [api, s.name, open],
    { refresh: [s.projects.length], cache: open ? key : undefined })
  const data = q.data ?? (open ? null : cachedAnswer<StoreProjectsView>(key) ?? null)
  return data ? projectSplit(data.projects, null) : null
}

/**
 * One database: fold, name (opens the Store), its size and project count
 * (the same words folded or open), the machines attached as marks while
 * folded (a failing check in red; past three, "+N"), and a menu that attaches
 * it to another machine or detaches it from one. Open, the machines move
 * into an "Attached" line (each with its check, and Attach), its projects beneath.
 */
function Database({ api, s, view, t, on, open, onToggle, onOpen }: {
  api: LayerfsApi, s: StoreRow, view: StorageView, t: StorageT, on: StoreActions, open: boolean, onToggle: (open: boolean) => void, onOpen: (id: TabId) => void
}): ReactNode {
  const split = useDbSplit(api, s, open)
  const counted = split?.rows.filter((r) => r.bytes !== null) ?? []
  const total = counted.length ? counted.reduce((n, r) => n + (r.bytes ?? 0), 0) : null
  const attached = attachmentsOf(s)
  const rows = split?.rows ?? [...s.projects].sort().map((name) => ({ name, bytes: null, share: 0, at: null, counting: true }))
  const shown = rows.length <= DB_ROWS + 1 ? rows : rows.slice(0, DB_ROWS)
  const down = s.postgresql?.reachable === false
  const count = s.projects.length === 1 ? t('msProjectOne') : t('msProjectCount', { n: s.projects.length })
  return (
    <section className={css.database} data-open={open || undefined} data-store={s.name}>
      <div className={css.dbRow}>
        <button type="button" className={css.fold} aria-expanded={open} aria-label={t('ccFold', { name: s.name })} onClick={() => onToggle(!open)}>
          <IconChevronRightOutlineRegular size={12} />
        </button>
        <span className={css.dbName}><Name onClick={() => onOpen(`store:${s.name}`)} title={s.postgresql?.database ?? s.name}>{s.name}</Name></span>
        {down
          ? <span className={css.dbSize} data-tone="danger" title={s.postgresql?.error ?? undefined}>{t('hsUnreachable')}</span>
          : <span className={css.dbSize}>{[total !== null ? bytes(total) : null, count].filter(Boolean).join(' · ')}</span>}
        <span className={css.marks}>
          {open ? null : attached.length === 0 ? <span className={css.dbNone}>{t('ovNotAttached')}</span> : attached.slice(0, MARKS).map((a) => {
            const platform = view.machines.find((m) => m.name === a.machine)?.platform
            const name = a.machine === 'native' ? t('layerfsHome') : a.machine
            return (
              <button key={a.machine} type="button" className={css.markButton} data-tone={a.lastError ? 'danger' : undefined}
                title={a.lastError ? `${name} · ${a.lastError.code}: ${a.lastError.message}` : name} aria-label={name} onClick={() => onOpen(`machine:${a.machine}`)}>
                {a.machine === 'native' ? <HomeGlyph size={13} /> : <MachineGlyph platform={platform ?? ''} size={13} mono />}
              </button>
            )
          })}
          {!open && attached.length > MARKS ? <span className={css.dbNone} title={attached.slice(MARKS).map((a) => a.machine).join(', ')}>+{attached.length - MARKS}</span> : null}
        </span>
        <MachinesMenu s={s} view={view} t={t} on={on} />
      </div>
      {open ? (
        <div className={css.dbProjects}>
          <div className={css.dbAttached}><MachineLine s={s} view={view} t={t} on={on} onOpenStore={(name) => onOpen(`store:${name}`)} /></div>
          {rows.length === 0 ? <span className={css.dbNone}>{t('msNoProjects')}</span> : shown.map((r) => (
            <button key={r.name} type="button" className={css.dbProject} onClick={() => onOpen(`project:${s.name}/${r.name}`)}>
              <span className={css.dbProjectName}>{r.name}</span>
              <span className={css.dbProjectSize}>{r.bytes !== null ? bytes(r.bytes) : r.counting ? t('spReading') : '—'}</span>
              {r.bytes !== null ? <span className={css.dbTrack} aria-hidden="true"><span style={{ width: `${Math.round(r.share * 1000) / 10}%` }} /></span> : <span />}
            </button>
          ))}
          {rows.length > shown.length ? <button type="button" className={css.dbMore} onClick={() => onOpen(`store:${s.name}`)}>{t('msMoreProjects', { n: rows.length - shown.length })}</button> : null}
        </div>
      ) : null}
    </section>
  )
}

/** A database's machines menu: detach it from each machine it is attached to, attach it to each other machine (a refused one says why). */
function MachinesMenu({ s, view, t, on }: { s: StoreRow, view: StorageView, t: StorageT, on: StoreActions }): ReactNode {
  const attached = attachmentsOf(s)
  const word = (m: string) => (m === 'native' ? t('layerfsHome') : m)
  const others = view.machines.filter((m) => !attached.some((a) => a.machine === m.name))
  const unsupported = view.features?.attach !== true ? t('attachUnsupported') : null
  return (
    <MoreMenu label={t('ccMachinesMenu', { name: s.name })} className={css.dbMenu}>
      {(close) => (
        <>
          {attached.map((a) => (
            <MenuItemButton key={`d:${a.machine}`} danger onSelect={() => { close(); on.detach(a.machine) }}>{t('msDetachFrom', { machine: word(a.machine) })}</MenuItemButton>
          ))}
          {others.map((m, i) => {
            const refused = unsupported ?? attachRefusal(view, s, m.name, t)
            return (
              <MenuItemButton key={`a:${m.name}`} disabled={!!refused} disabledReason={refused ?? undefined} separatorBefore={i === 0} onSelect={() => { close(); on.attach(m.name) }}>
                {t('ccAttachTo', { machine: word(m.name) })}
              </MenuItemButton>
            )
          })}
        </>
      )}
    </MoreMenu>
  )
}
