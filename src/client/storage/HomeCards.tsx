/**
 * The Overview's card sections, each a wrapping grid of cards:
 *
 * - Projects: one card per project (trouble first), with the Store that
 *   holds it, the machines it runs on (a PostgreSQL Store's project runs on
 *   every machine the Store is attached to), the buckets holding its Store's
 *   backups, and its Sandboxes.
 * - Stores: one card per Store: its kind and size, where it lives, its
 *   projects, and its backups (each bucket with Back up now, then Back up to
 *   another bucket); the Store menu holds push, pull, move and remove.
 * - Machines: one card per machine: Start or Stop, its disk, the Stores on it
 *   (SQLite) or attached to it (PostgreSQL), its Sandboxes, and a transfer
 *   arriving on it.
 * - Backups: every SQLite Store with its backups (the protection list), then
 *   one card per bucket with the files it keeps; a file not from this home
 *   can be restored as a new Store.
 *
 * Every name opens its editor tab; every button goes through the Storage
 * page's own dialogs and actions.
 */
import { useState, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, IconTrashOutlineRegular, MenuItemButton, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { useMachinesContext } from '../machines/context.tsx'
import { MachineGlyph, SandboxGlyph } from '../machines/icons.tsx'
import { downReason, gib, machineState, sandboxesOn, shortSandbox, sizeOf, workerDown, type AvailableView, type MachineInfo, type MachineSandbox } from '../machines/model.ts'
import { MachineDialogs, MachineMenu, MachineProgress, PowerButton, useMachineRun } from '../machines/parts.tsx'
import { machineBlock, stepReasons } from '../machines/needs.ts'
import { FixPanel } from '../machines/Readiness.tsx'
import { MoreMenu } from '../ui/index.tsx'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import type { TabId } from './tabs.ts'
import type { StorageT } from './locale.ts'
import { attachmentsOf, backupChip, bucketFiles, canAddProject, doingWords, latestBackup, linkState, listedOf, shareOf, type RowSignal } from './model.ts'
import { BucketGlyph, HomeGlyph, StoreGlyph } from './parts.tsx'
import { BucketMark, providerWords } from './BucketPage.tsx'
import { StoreMenu, type StoreActions } from './StoreCard.tsx'
import { Signal } from './Signal.tsx'
import type { StorageJob, StorageView, StoreBackupLink, StoreRow } from './types.ts'
import css from './HomeCards.module.css'

type Place = (machine: string | null | undefined) => string

/** Projects a Store card lists before "+N more". */
const STORE_PROJECTS = 4
/** Machine tags a project card shows before "+N". */
const MACHINE_TAGS = 3

/**
 * A backup's state for the Overview. A backup older than its Store is
 * normal (the Store keeps changing), so it reads neutral; only a missing
 * file or a conflict stays red.
 */
function calmChip(...args: Parameters<typeof backupChip>): ReturnType<typeof backupChip> {
  const chip = backupChip(...args)
  return chip.tone === 'warning' ? { ...chip, tone: 'neutral' } : chip
}

/** A dot's state from a tone. */
const dotOf = (tone: string): 'done' | 'error' | 'warning' | 'idle' =>
  tone === 'success' ? 'done' : tone === 'danger' ? 'error' : tone === 'warning' ? 'warning' : 'idle'

const projectsWords = (n: number, t: StorageT) => (n === 1 ? t('ovProjectCount') : t('ovProjectsCount', { n }))

function Name({ children, onClick, title }: { children: ReactNode, onClick: () => void, title?: string }): ReactNode {
  return <button type="button" className={css.name} title={title} onClick={(e) => { e.stopPropagation(); onClick() }}>{children}</button>
}

/**
 * What keeps a Store's projects from opening, worst first: down, unresolved,
 * an unreachable PostgreSQL server, a machine that cannot reach it, or its
 * machine stopped. Backup state is not trouble here: the Store card shows it.
 */
/** A Store's trouble, short; `detail` is LayerFS's full words, `restart` the machine whose worker would fix it. */
type Trouble = RowSignal & { detail?: string, restart?: MachineInfo }

function storeTrouble(s: StoreRow, view: StorageView, t: StorageT, place: Place, fleet?: AvailableView | null): Trouble | null {
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
function RestartButton({ m, t, onRestart }: { m: MachineInfo, t: StorageT, onRestart: (m: MachineInfo) => Promise<unknown> }): ReactNode {
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
function JobLine({ job, t, label }: { job: StorageJob, t: StorageT, label?: string }): ReactNode {
  const share = Math.round(shareOf(job) * 100)
  return (
    <span className={css.job}>
      <span className={css.jobLine}><StateDot state="ongoing" size={10} /><span className={css.statusText}>{label ?? doingWords(job, t)}</span><span className={css.num}>{`${share}%`}</span></span>
      <span className={css.bar}><span style={{ width: `${share}%` }} /></span>
    </span>
  )
}

/** The bucket a link points at, as its provider mark. */
const providerOf = (view: StorageView, bucket: string) => view.buckets.find((b) => b.name === bucket)?.provider

/** A Store's backup in one bucket: that bucket's mark and name, its state as a dot. */
function BucketChip({ s, link, view, t, onOpen }: { s: StoreRow, link: StoreBackupLink, view: StorageView, t: StorageT, onOpen: (id: TabId) => void }): ReactNode {
  const chip = calmChip(linkState(s, link.bucket, link.file, view.buckets), t)
  return (
    <button type="button" className={css.machineChip} title={`${link.bucket}/${link.file} · ${chip.label}`}
      onClick={(e) => { e.stopPropagation(); onOpen(`bucket:${link.bucket}`) }}>
      <span className={css.smallIcon}><BucketMark provider={providerOf(view, link.bucket)} size={12} /></span>
      <span className={css.chipText}>{link.bucket}</span>
      <StateDot state={dotOf(chip.tone)} size={6} />
    </button>
  )
}

/** A machine as a small chip: its glyph and name, red when its tie to the Store is broken. */
function MachineChip({ name, platform, place, broken, onOpen }: {
  name: string, platform: string | undefined, place: Place, broken?: string | null | undefined, onOpen: (id: TabId) => void
}): ReactNode {
  return (
    <button type="button" className={css.machineChip} data-tone={broken ? 'danger' : undefined} title={broken ?? place(name)}
      onClick={(e) => { e.stopPropagation(); onOpen(`machine:${name}`) }}>
      <span className={css.smallIcon}>{name === 'native' ? <HomeGlyph size={12} /> : <MachineGlyph platform={platform ?? 'unknown'} size={12} mono />}</span>
      <span className={css.chipText}>{place(name)}</span>
    </button>
  )
}

/** Where a Store's projects run: its one machine (SQLite), or every machine it is attached to (PostgreSQL), the rest as "+N". */
function Placement({ s, machines, t, place, onOpen, limit }: {
  s: StoreRow, machines: readonly MachineInfo[], t: StorageT, place: Place, onOpen: (id: TabId) => void, limit?: number
}): ReactNode {
  const platformOf = (name: string) => machines.find((m) => m.name === name)?.platform ?? (name === 'native' ? 'native' : undefined)
  if (s.kind === 'sqlite') return s.machine ? <MachineChip name={s.machine} platform={platformOf(s.machine)} place={place} onOpen={onOpen} /> : <span className={css.muted}>—</span>
  const attached = attachmentsOf(s)
  if (attached.length === 0) return <span className={css.muted}>{t('ovNotAttached')}</span>
  const shown = limit ? attached.slice(0, limit) : attached
  const rest = attached.slice(shown.length)
  return (
    <>
      {shown.map((a) => <MachineChip key={a.machine} name={a.machine} platform={platformOf(a.machine)} place={place} broken={a.lastError?.message} onOpen={onOpen} />)}
      {rest.length ? <span className={css.moreChip} title={rest.map((a) => place(a.machine)).join(', ')}>{t('ovMoreCount', { n: rest.length })}</span> : null}
    </>
  )
}

/** A Sandbox as a chip that opens it. */
function SandboxChip({ b, t, place, onOpen }: { b: MachineSandbox, t: StorageT, place: Place, onOpen: (id: TabId) => void }): ReactNode {
  return (
    <button type="button" className={css.chip} onClick={(e) => { e.stopPropagation(); onOpen(`sandbox:${b.machine ?? ''}/${b.name}`) }}
      title={[b.project, t('ovSandboxOn', { sandbox: b.name, machine: place(b.machine) })].filter(Boolean).join(' · ')}>
      <StateDot state={b.state === 'running' ? 'done' : 'idle'} size={6} />
      <SandboxGlyph size={11} /><span className={css.chipText}>{shortSandbox(b.name)}</span>
    </button>
  )
}

/**
 * A project's Sandboxes. A Sandbox names its project `store/project`; a bare
 * project name is only trusted when no other Store has a project of that name.
 */
function sandboxesOfProject(sandboxes: readonly MachineSandbox[], stores: readonly StoreRow[], store: string, project: string): MachineSandbox[] {
  const unique = stores.filter((x) => x.projects.includes(project)).length === 1
  return sandboxes.filter((b) => b.project === `${store}/${project}` || (unique && b.project === project))
}

// ---------- projects: one card per project ----------

export function ProjectCards({ stores, view, fleet, machines, t, jobs, place, onOpen, onRemove, onRestart }: {
  stores: readonly StoreRow[], view: StorageView, fleet: AvailableView | null, machines: readonly MachineInfo[], t: StorageT
  jobs: readonly StorageJob[], place: Place, onOpen: (id: TabId) => void
  /** Delete a project (the page's confirm dialog). */
  onRemove: (store: string, project: string) => void
  /** Start a machine's worker again (a Store whose machine does not answer). */
  onRestart?: (m: MachineInfo) => Promise<unknown>
}): ReactNode {
  const sandboxes = fleet?.sandboxes ?? []
  const rank = (x: Trouble | null) => (x?.state === 'error' ? 0 : x?.state === 'warning' ? 1 : 2)
  // Trouble first, then the Stores' own order.
  const projects = stores
    .flatMap((s, order) => s.projects.map((p) => ({ s, p, order, trouble: storeTrouble(s, view, t, place, fleet) })))
    .sort((a, b) => rank(a.trouble) - rank(b.trouble) || a.order - b.order || a.p.localeCompare(b.p))
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
                {boxes.length ? <span className={css.sub}>{boxes.length === 1 ? t('ovOneSandbox') : t('ovSandboxCount', { n: boxes.length })}</span> : null}
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
              <dt>{t('ovFieldStore')}</dt>
              <dd>
                <button type="button" className={css.storeChip} data-kind={s.kind} title={s.name}
                  onClick={(e) => { e.stopPropagation(); onOpen(`store:${s.name}`) }}>
                  <StoreGlyph kind={s.kind} size={12} /><span className={css.chipText}>{s.name}</span>
                </button>
                <span className={css.muted}>{pg ? t('postgresql') : t('sqlite')}</span>
              </dd>
              <dt>{pg && attachmentsOf(s).length !== 1 ? t('ovFieldMachines') : t('ovFieldMachine')}</dt>
              <dd className={css.chipRow}><Placement s={s} machines={machines} t={t} place={place} onOpen={onOpen} limit={MACHINE_TAGS} /></dd>
              <dt>{t('ovFieldBackup')}</dt>
              <dd className={css.chipRow}>
                {pg
                  ? <span className={css.muted}>{t('ovPgServerBackup')}</span>
                  : s.links.length
                    ? s.links.map((l) => <BucketChip key={`${l.bucket}/${l.file}`} s={s} link={l} view={view} t={t} onOpen={onOpen} />)
                    : <span className={css.muted}>{t('ovNoBackupYet')}</span>}
              </dd>
              {boxes.length ? (
                <>
                  <dt>{t('ovTileSandboxes')}</dt>
                  <dd className={css.chipRow}>{boxes.map((b) => <SandboxChip key={b.name} b={b} t={t} place={place} onOpen={onOpen} />)}</dd>
                </>
              ) : null}
            </dl>
            {job ? <footer className={css.cardFoot}><JobLine job={job} t={t} label={`${s.name} · ${doingWords(job, t)}`} /></footer> : null}
          </article>
        )
      })}
    </div>
  )
}

// ---------- stores: one card per Store, with its projects ----------

export function StoreCards({ stores, view, fleet, machines, t, now, jobs, place, pgSize, onOpen, actionsFor, onAddBucket }: {
  stores: readonly StoreRow[], view: StorageView, fleet: AvailableView | null, machines: readonly MachineInfo[], t: StorageT, now: number
  /** Pushes, pulls, moves and backups still running. */
  jobs: readonly StorageJob[]
  place: Place, pgSize: (name: string) => number | null
  onOpen: (id: TabId) => void, actionsFor: (s: StoreRow) => StoreActions
  /** No bucket yet: a backup needs one first. */
  onAddBucket: () => void
}): ReactNode {
  const sandboxes = fleet?.sandboxes ?? []
  const attachable = view.features?.attach === true
  return (
    <div className={css.cards}>
      {stores.map((s) => {
        const on = actionsFor(s)
        const pg = s.kind === 'postgresql'
        const size = pg ? pgSize(s.name) : s.size?.bytes ?? null
        const job = jobs.find((j) => j.store === s.name && !j.ended)
        const blocked = s.state === 'down' || s.state === 'busy' || s.state === 'unresolved' || !!job
        const shown = s.projects.slice(0, STORE_PROJECTS)
        const trouble = storeTrouble(s, view, t, place, fleet)
        const working = !trouble && (!!job || s.state === 'busy')
        return (
          <article key={s.name} className={css.card} data-kind={s.kind}>
            <header className={css.cardHead}>
              <span className={css.icon} data-kind={s.kind}><StoreGlyph kind={s.kind} size={16} /></span>
              <span className={css.titles}>
                <span className={css.nameLine}>
                  <Name onClick={() => onOpen(`store:${s.name}`)} title={s.name}>{s.name}</Name>
                  <Signal state={trouble ? trouble.state : working ? 'ongoing' : 'ok'}
                    title={trouble?.reason ?? (working ? (job ? doingWords(job, t) : [s.op?.name, s.op?.phase].filter(Boolean).join(' · ') || t('ovSignalBusy')) : t('ovSignalReady'))}
                    detail={trouble?.detail} />
                </span>
                <span className={css.sub}>{[pg ? t('postgresql') : t('sqlite'), size !== null ? bytes(size) : null, projectsWords(s.projects.length, t)].filter(Boolean).join(' · ')}</span>
              </span>
              <span className={css.headActions}>
                <StoreMenu store={s} on={on} t={t} />
              </span>
            </header>
            <div className={css.placeRow}>
              <span className={css.placeLabel}>{pg ? t('ovRunsOn') : t('ovLivesOnLabel')}</span>
              <span className={css.chipRow}>
                <Placement s={s} machines={machines} t={t} place={place} onOpen={onOpen} />
                {pg && attachable ? <button type="button" className={css.addChip} onClick={() => on.attach()}>{t('ovAttach')}</button> : null}
              </span>
            </div>

            <div className={css.projects}>
              {s.projects.length === 0 ? (
                <p className={css.none}>
                  {t('ovNoProjectsYet')}
                  {canAddProject(s) ? <button type="button" className={css.inlineLink} onClick={on.addProject}>{t('ovAddProject')}</button> : null}
                </p>
              ) : shown.map((p) => {
                const boxes = sandboxesOfProject(sandboxes, stores, s.name, p)
                return (
                  <div key={p} className={css.project}>
                    <span className={css.projectIcon}><LayerfsGlyph size={13} /></span>
                    <Name onClick={() => onOpen(`project:${s.name}/${p}`)} title={p}>{p}</Name>
                    <span className={css.chips}>
                      {boxes.length === 1 ? <SandboxChip b={boxes[0]!} t={t} place={place} onOpen={onOpen} /> : null}
                      {/* Several Sandboxes: one count chip, so the project's name keeps its room; the project page lists them. */}
                      {boxes.length > 1 ? (
                        <button type="button" className={css.chip} onClick={(e) => { e.stopPropagation(); onOpen(`project:${s.name}/${p}`) }}
                          title={boxes.map((b) => t('ovSandboxOn', { sandbox: b.name, machine: place(b.machine) })).join('\n')}>
                          <StateDot state={boxes.some((b) => b.state === 'running') ? 'done' : 'idle'} size={6} />
                          <SandboxGlyph size={11} /><span className={css.chipText}>{t('ovSandboxCount', { n: boxes.length })}</span>
                        </button>
                      ) : null}
                    </span>
                  </div>
                )
              })}
              {s.projects.length > shown.length ? (
                <button type="button" className={css.moreLink} onClick={() => onOpen(`store:${s.name}`)}>
                  {t('ovMoreProjects', { n: s.projects.length - shown.length })}
                </button>
              ) : null}
            </div>

            <StoreBackups s={s} view={view} t={t} now={now} job={job} blocked={blocked}
              on={on} onOpen={onOpen} onAddBucket={onAddBucket} />
          </article>
        )
      })}
    </div>
  )
}

/**
 * A Store's backups: every bucket file it is backed up to, each with its
 * state, when it was last backed up, and Back up now; then Back up to
 * another bucket. A PostgreSQL Store shows its server's health instead (it
 * backs itself up). A running transfer and an operation from elsewhere sit
 * on top; what keeps the Store from opening is the card's signal.
 */
function StoreBackups({ s, view, t, now, job, blocked, on, onOpen, onAddBucket }: {
  s: StoreRow, view: StorageView, t: StorageT, now: number, job: StorageJob | undefined, blocked: boolean
  on: StoreActions, onOpen: (id: TabId) => void, onAddBucket: () => void
}): ReactNode {
  const pg = s.kind === 'postgresql'
  const noBucket = view.buckets.length === 0
  const server = s.postgresql
  return (
    <footer className={css.backups}>
      {job ? <JobLine job={job} t={t} /> : null}
      {!job && s.state === 'busy' && s.op ? (
        <p className={css.trouble} data-tone="ongoing"><StateDot state="ongoing" size={10} />{[s.op.name, s.op.phase].filter(Boolean).join(' · ')}</p>
      ) : null}
      <div className={css.backupsHead}>
        <span className={css.label}>{pg ? t('ovServer') : t('ovBackups')}</span>
        {!pg && s.links.length > 0 && !noBucket ? (
          <button type="button" className={css.inlineLink} disabled={blocked} onClick={on.backup}>{t('ovBackUpElsewhere')}</button>
        ) : null}
      </div>
      {pg ? (
        <div className={css.backupRow}>
          <span className={css.status} data-tone={server?.reachable === false ? 'danger' : server?.reachable ? 'success' : undefined}>
            <StateDot state={server?.reachable === false ? 'error' : server?.reachable ? 'done' : 'idle'} size={7} />
            {server?.reachable === false ? t('ovServerDown') : server?.reachable ? t('ovServerUp') : t('ovServerUnchecked')}
          </span>
          <span className={css.end}>
            {[server?.version ? `${t('postgresql')} ${server.version.split(' ')[0]}` : null, server?.latencyMs != null ? `${server.latencyMs} ms` : null].filter(Boolean).join(' · ')}
          </span>
        </div>
      ) : null}
      {pg ? <p className={css.none}>{t('ovServerBacksUp')}</p> : null}
      {!pg && s.links.length === 0 ? (
        <div className={css.backupRow}>
          <span className={css.muted}>{t('ovNeverBackedUp')}</span>
          {noBucket
            ? <Button variant="outline" size="sm" onClick={onAddBucket}>{t('ovAddBucketFirst')}</Button>
            : <Button variant="ghost" size="sm" disabled={blocked} onClick={on.backup}>{t('ovBackUp')}</Button>}
        </div>
      ) : null}
      {!pg ? s.links.map((l) => {
        const listed = listedOf(s, l.bucket, l.file, view.buckets)
        const chip = calmChip(listed?.state, t)
        const why = listed?.untracked ? t('ovUntrackedWhy', { machine: s.machine ?? '' }) : listed?.reason ?? undefined
        return (
          <div key={`${l.bucket}/${l.file}`} className={css.backupRow}>
            <span className={css.smallIcon}><BucketMark provider={providerOf(view, l.bucket)} size={13} /></span>
            <span className={css.backupWhere}>
              <Name onClick={() => onOpen(`bucket:${l.bucket}`)} title={`${l.bucket}/${l.file}`}>{l.bucket}</Name>
              <span className={css.backupMeta}>
                <span className={css.status} data-tone={chip.tone} title={why}><StateDot state={dotOf(chip.tone)} size={6} />{chip.label}</span>
                {l.last?.at ? <span className={css.muted}>{ago(l.last.at, now, t as Translate)}</span> : null}
              </span>
            </span>
            <Button variant="ghost" size="sm" disabled={blocked} title={t('ovBackUpNowTitle', { place: `${l.bucket}/${l.file}` })} onClick={() => on.backupTo(l)}>
              {t('ovBackUpNow')}
            </Button>
          </div>
        )
      }) : null}
    </footer>
  )
}

// ---------- machines: one card per machine, with its Stores ----------

export function MachineCards({ machines, fleet, stores, t, jobs, place, pgSize, onOpen, onAddStore, onNewSandbox }: {
  machines: readonly MachineInfo[], fleet: AvailableView | null, stores: readonly StoreRow[], t: StorageT
  jobs: readonly StorageJob[], place: Place, pgSize: (name: string) => number | null, onOpen: (id: TabId) => void
  onAddStore: (machine: string) => void, onNewSandbox: (machine: string) => void
}): ReactNode {
  return (
    <div className={css.cards}>
      {machines.map((m) => <MachineCard key={m.name} m={m} fleet={fleet} stores={stores} t={t} jobs={jobs} place={place} pgSize={pgSize} onOpen={onOpen} onAddStore={onAddStore} onNewSandbox={onNewSandbox} />)}
    </div>
  )
}

/** One machine: its state as a signal (why it needs you on hover), Start or Stop with its progress, its disk, Stores and Sandboxes (each with its Add), and what is arriving. */
function MachineCard({ m, fleet, stores, t, jobs, place, pgSize, onOpen, onAddStore, onNewSandbox }: {
  m: MachineInfo, fleet: AvailableView | null, stores: readonly StoreRow[], t: StorageT, jobs: readonly StorageJob[]
  place: Place, pgSize: (name: string) => number | null, onOpen: (id: TabId) => void
  onAddStore: (machine: string) => void, onNewSandbox: (machine: string) => void
}): ReactNode {
  const mc = useMachinesContext()
  const startup = mc.useStartups((all) => all[m.name])
  const { run, pending: localPending } = useMachineRun()
  const [dialog, setDialog] = useState<'settings' | 'remove' | 'force-stop' | null>(null)
  const starting = startup?.status === 'running'
  const pending = localPending ?? (starting ? startup.kind : null)
  const live = fleet?.status[m.name]
  const look = machineState(m, live)
  const block = starting || !fleet ? null : machineBlock(m, fleet)
  const reason = starting ? null : downReason(m, live)
  const free = live?.freeDisk ?? null
  const own = stores.filter((s) => s.kind === 'sqlite' && s.machine === m.name)
  const attached = stores.filter((s) => s.kind === 'postgresql' && attachmentsOf(s).some((a) => a.machine === m.name))
  const boxes = fleet ? sandboxesOn(fleet, m) : []
  const runningBoxes = boxes.filter((b) => b.state === 'running').length
  const used = m.disk && free != null ? Math.max(0, m.disk - free) / m.disk : null
  const low = m.disk && free != null ? free / m.disk < 0.1 : false
  // A push or move arriving here, or a pull arriving in the home.
  const arriving = jobs.find((j) => !j.ended && ((j.kind === 'push' || j.kind === 'move') ? j.target === m.name : j.kind === 'pull' && m.name === 'native'))
  const sub = m.platform === 'native' ? mc.kind(m.platform) : m.platform === 'docker' ? mc.kind(m.platform) : `${mc.kind(m.platform)} · ${mc.tw(sizeOf({ ...m, disk: null } as MachineInfo, undefined)).split(' · ').slice(0, 2).join(' · ')}`
  return (
    <article className={css.card} data-kind="machine" data-stopped={look.key === 'stopped' || undefined}>
      <header className={css.cardHead}>
        <span className={css.icon}>{m.name === 'native' ? <HomeGlyph size={15} /> : <MachineGlyph platform={m.platform} size={15} mono />}</span>
        <span className={css.titles}>
          <span className={css.nameLine}>
            <Name onClick={() => onOpen(`machine:${m.name}`)}>{place(m.name)}</Name>
            {block
              ? <Signal state="warning" title={mc.t('stateUnavailable')} detail={mc.t('unavailableWhy', { kind: mc.kind(m.platform), reason: stepReasons(block, mc.tw) })} action={<FixPanel fixes={block.fixes} className={css.fixCard} />} />
              : <Signal state={starting || look.key === 'busy' ? 'ongoing' : look.key === 'running' ? 'ok' : look.key === 'needs' ? 'error' : 'idle'}
                title={mc.stateWord(look)} detail={reason} />}
            {block ? <span className={css.muted}>{mc.t('stateUnavailable')}</span> : look.key !== 'running' && look.key !== 'needs' ? <span className={css.muted}>{mc.stateWord(look)}</span> : null}
          </span>
          <span className={css.sub}>{sub}</span>
        </span>
        <span className={css.headActions}>
          {m.platform !== 'native' && !block ? <PowerButton m={m} pending={pending} run={run} /> : null}
          <MachineMenu m={m} pending={pending} run={run} onOpen={() => onOpen(`machine:${m.name}`)} onDialog={setDialog} />
        </span>
      </header>
      <MachineDialogs m={m} dialog={dialog} onClose={() => setDialog(null)} pending={pending} run={run} />
      {starting ? <div className={css.progress}><MachineProgress name={m.name} compact /></div> : null}

      <div className={css.diskRow}>
        <span className={css.placeLabel}>{t('ovDisk')}</span>
        <span className={css.end} data-tone={low ? 'warning' : undefined}>
          {m.disk && free != null ? t('ovDiskOf', { free: gib(free), total: gib(m.disk) }) : free != null ? t('ovFree', { free: gib(free) }) : t('ovDiskUnknown')}
        </span>
        {used !== null ? <span className={css.bar} data-tone={low ? 'warning' : undefined}><span style={{ width: `${Math.round(used * 100)}%` }} /></span> : null}
      </div>

      <div className={css.list}>
        <ListHead label={t('ovTileStores')} action={t('addStore')} onAction={() => onAddStore(m.name)} />
        {own.length === 0 && attached.length === 0 ? <p className={css.none}>{t('ovNothingHere')}</p> : null}
        {own.map((s) => (
          <div key={s.name} className={css.storeLine}>
            <span className={css.smallIcon}><StoreGlyph kind="sqlite" size={13} /></span>
            <Name onClick={() => onOpen(`store:${s.name}`)}>{s.name}</Name>
            <span className={css.muted}>{projectsWords(s.projects.length, t)}</span>
            <span className={css.end}>{s.size ? bytes(s.size.bytes) : ''}</span>
          </div>
        ))}
        {attached.map((s) => {
          const a = attachmentsOf(s).find((x) => x.machine === m.name)!
          const size = pgSize(s.name)
          return (
            <div key={s.name} className={css.storeLine}>
              <span className={css.smallIcon}><StoreGlyph kind="postgresql" size={13} /></span>
              <Name onClick={() => onOpen(`store:${s.name}`)}>{s.name}</Name>
              <span className={css.muted}>{a.lastError ? null : t('ovAttachedTag')}</span>
              {a.lastError
                ? <span className={css.tag} data-tone="danger" title={a.lastError.message}>{t('ovUnreachableTag')}</span>
                : <span className={css.end}>{size !== null ? bytes(size) : ''}</span>}
            </div>
          )
        })}
      </div>

      <div className={css.list}>
        <ListHead label={t('ovTileSandboxes')} action={t('newSandbox')} onAction={() => onNewSandbox(m.name)}
          disabled={look.key !== 'running' || pending !== null ? t('startBeforeSandbox') : null} />
        {boxes.length
          ? <span className={css.chips}>{boxes.map((b) => <SandboxChip key={b.name} b={{ ...b, machine: b.machine ?? m.name }} t={t} place={place} onOpen={onOpen} />)}</span>
          : <p className={css.none}>{t('ovNothingHere')}</p>}
      </div>

      {arriving ? <footer className={css.cardFoot}><JobLine job={arriving} t={t} label={`${arriving.store} · ${doingWords(arriving, t)}`} /></footer>
        : runningBoxes ? <footer className={css.cardFoot}><span className={css.status} data-tone="success"><StateDot state="done" size={7} />{runningBoxes === 1 ? t('ovOneSandboxRunning') : t('ovSandboxesRunning', { n: runningBoxes })}</span></footer>
          : null}
    </article>
  )
}

/** A card list's label with its add verb at the end; `disabled` says why the verb waits. */
function ListHead({ label, action, onAction, disabled }: { label: string, action: string, onAction: () => void, disabled?: string | null | undefined }): ReactNode {
  return (
    <div className={css.listHead}>
      <span className={css.label}>{label}</span>
      <button type="button" className={css.listAction} disabled={!!disabled} title={disabled ?? undefined} onClick={onAction}>
        <IconPlusOutlineRegular size={11} />{action}
      </button>
    </div>
  )
}

// ---------- backups: the protection list, then one card per bucket ----------

/** Every SQLite Store with where it is backed up and when, and Back up. A Store without a backup is listed plainly, not flagged. */
export function ProtectionList({ stores, view, t, now, jobs, onOpen, actionsFor, onAddBucket }: {
  stores: readonly StoreRow[], view: StorageView, t: StorageT, now: number, jobs: readonly StorageJob[]
  onOpen: (id: TabId) => void, actionsFor: (s: StoreRow) => StoreActions, onAddBucket: () => void
}): ReactNode {
  const sqlite = stores.filter((s) => s.kind === 'sqlite')
  if (sqlite.length === 0) return null
  const rows = [...sqlite].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <div className={css.protection}>
      {rows.map((s) => {
        const on = actionsFor(s)
        const job = jobs.find((j) => j.store === s.name && !j.ended && j.kind === 'backup')
        const blocked = s.state === 'down' || s.state === 'busy' || s.state === 'unresolved' || jobs.some((j) => j.store === s.name && !j.ended)
        const drifted = s.links.find((l) => linkState(s, l.bucket, l.file, view.buckets) !== 'current')
        const at = latestBackup(s)
        return (
          <div key={s.name} className={css.protectRow}>
            <span className={css.smallIcon}><StoreGlyph kind="sqlite" size={14} /></span>
            <span className={css.protectName}>
              <Name onClick={() => onOpen(`store:${s.name}`)}>{s.name}</Name>
              <span className={css.muted}>{[s.size ? bytes(s.size.bytes) : null, projectsWords(s.projects.length, t)].filter(Boolean).join(' · ')}</span>
            </span>
            <span className={css.protectWhere}>
              {job ? <JobLine job={job} t={t} />
                : s.links.length === 0
                  ? <span className={css.muted}>{t('ovNeverBackedUp')}</span>
                  : (
                    <span className={css.chipRow}>
                      {s.links.map((l) => <BucketChip key={`${l.bucket}/${l.file}`} s={s} link={l} view={view} t={t} onOpen={onOpen} />)}
                      {at !== null ? <span className={css.muted}>{ago(at, now, t as Translate)}</span> : null}
                    </span>
                  )}
            </span>
            <span className={css.headActions}>
              {view.buckets.length === 0
                ? <Button variant="outline" size="sm" onClick={onAddBucket}>{t('ovAddBucketFirst')}</Button>
                : s.links.length === 0
                  ? <Button variant="ghost" size="sm" disabled={blocked} onClick={on.backup}>{t('ovBackUp')}</Button>
                  : (
                    <Button variant="ghost" size="sm" disabled={blocked} title={t('ovBackUpNowTitle', { place: `${(drifted ?? s.links[0]!).bucket}/${(drifted ?? s.links[0]!).file}` })}
                      onClick={() => on.backupTo(drifted ?? s.links[0]!)}>
                      {t('ovBackUpNow')}
                    </Button>
                  )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * A self-hosted bucket's endpoint host, for the line under its name (the
 * logo already says the provider). An R2 endpoint names only an account id,
 * so R2 keeps its provider name.
 */
function whereOf(b: StorageView['buckets'][number]): string | null {
  if (b.provider === 'r2') return null
  if (b.url) { try { return new URL(b.url).host } catch { return b.url } }
  return b.region ?? null
}

export function BucketCards({ view, t, now, jobs, onOpen, onAddBucket, onList, onRestore }: {
  view: StorageView, t: StorageT, now: number, jobs: readonly StorageJob[], onOpen: (id: TabId) => void, onAddBucket: () => void
  /** Lists a bucket's files (`GET /api/buckets/<name>/files`). */
  onList: (bucket: string) => void
  /** Restores a bucket file as a new Store. */
  onRestore: (bucket: string, file: string) => void
}): ReactNode {
  if (view.buckets.length === 0) {
    return (
      <div className={css.emptyCard}>
        <span className={css.icon}><BucketGlyph size={16} /></span>
        <span className={css.titles}>
          <span className={css.emptyTitle}>{t('ovNoBuckets')}</span>
          <span className={css.sub}>{t('ovNoBucketsBody')}</span>
        </span>
        <Button variant="outline" size="sm" onClick={onAddBucket}>{t('ovAddBucket')}</Button>
      </div>
    )
  }
  return (
    <div className={css.cards}>
      {view.buckets.map((b) => {
        const unlisted = b.files === null && !b.error
        const files = b.error ? [] : bucketFiles(b, view.stores)
        const linked = files.filter((f) => f.state !== 'unlinked')
        const foreign = files.filter((f) => f.state === 'unlinked')
        const running = jobs.filter((j) => !j.ended && (j.kind === 'backup' || j.kind === 'restore') && j.target === b.name)
        const row = (f: typeof files[number]) => {
          const chip = calmChip(f.state, t)
          const foreignFile = f.state === 'unlinked'
          return (
            <div key={`${f.file}:${f.storeName ?? ''}`} className={css.storeLine}>
              <span className={css.smallIcon}><StoreGlyph kind="sqlite" size={13} /></span>
              {f.storeName && !foreignFile
                ? <Name onClick={() => onOpen(`store:${f.storeName}`)} title={f.file}>{f.storeName}</Name>
                : <span className={css.fileName} title={f.reason ?? f.file}>{f.file}</span>}
              <span className={css.muted}>{f.bytes != null ? bytes(f.bytes) : ''}</span>
              {foreignFile
                ? <span className={css.end}><button type="button" className={css.inlineLink} onClick={() => onRestore(b.name, f.file)}>{t('ovRestore')}</button></span>
                : <span className={css.status} data-tone={chip.tone} title={f.reason ?? undefined}><StateDot state={dotOf(chip.tone)} size={7} />{chip.label}</span>}
            </div>
          )
        }
        return (
          <article key={b.name} className={css.card} data-kind="bucket">
            <header className={css.cardHead}>
              <span className={css.icon} data-kind="bucket" title={providerWords(b.provider, t)}><BucketMark provider={b.provider} size={18} /></span>
              <span className={css.titles}>
                <span className={css.nameLine}>
                  <Name onClick={() => onOpen(`bucket:${b.name}`)}>{b.name}</Name>
                  <Signal state={b.error ? 'error' : unlisted ? 'idle' : 'ok'}
                    title={b.error ? t('ovBucketFailed') : unlisted ? t('ovBucketUnlisted') : t('ovSignalReady')} detail={b.error?.message} />
                </span>
                <span className={css.sub}>
                  {[whereOf(b) ?? providerWords(b.provider, t), b.error ? t('ovBucketFailed') : unlisted ? t('ovBucketUnlisted') : (files.length === 1 ? t('ovBucketFile') : t('ovBucketFiles', { n: files.length })), b.listed && !b.error ? t('ovListedAgo', { ago: ago(b.listed, now, t as Translate) }) : null].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className={css.headActions}>
                {unlisted || b.error
                  ? <Button variant="outline" size="sm" onClick={() => onList(b.name)}>{b.error ? t('ovTryAgain') : t('ovListFiles')}</Button>
                  : <Button variant="outline" size="sm" onClick={() => onOpen(`bucket:${b.name}`)}>{t('ovOpen')}</Button>}
              </span>
            </header>
            <div className={css.list}>
              {running.map((j) => <div key={j.id} className={css.jobRow}><JobLine job={j} t={t} label={`${j.store} · ${doingWords(j, t)}`} /></div>)}
              {!b.error && files.length === 0 ? <p className={css.none}>{unlisted ? t('ovBucketNotListedBody') : t('ovBucketEmpty')}</p> : null}
              {linked.map(row)}
              {foreign.length ? <span className={css.label}>{t('ovNotFromHome')}</span> : null}
              {foreign.map(row)}
            </div>
          </article>
        )
      })}
    </div>
  )
}
