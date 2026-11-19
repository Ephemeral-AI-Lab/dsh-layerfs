/**
 * The Overview's card sections, each a wrapping grid of cards:
 *
 * - Projects: one card per project (trouble first), with its size (packed
 *   bytes on disk, main's files beside), the Store that holds it, and its
 *   Sandboxes. Where the Store runs and its backups are on the Store card.
 * - Machines: one card per machine: Start or Stop, its disk, the Stores on it
 *   (SQLite) or that run on it (PostgreSQL), its Sandboxes, and a transfer
 *   arriving on it.
 *
 * Every name opens its editor tab; every button goes through the Storage
 * page's own dialogs and actions.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconTrashOutlineRegular, MenuItemButton, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { SandboxGlyph } from '../machines/icons.tsx'
import { downReason, shortSandbox, workerDown, type AvailableView, type MachineInfo, type MachineSandbox } from '../machines/model.ts'
import { sandboxRuns } from '../machines/stats.ts'
import { machineBlock } from '../machines/needs.ts'
import { MoreMenu, usePressGuard } from '../ui/index.tsx'
import { useQuery } from '../ui/use-query.ts'
import { enc, type LayerfsApi } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import type { TabId } from './tabs.ts'
import type { StorageT } from './locale.ts'
import { blockedWords, brokenWords, doingWords, shareOf, storeStateWords, storeTip, type RowSignal } from './model.ts'
import { StoreGlyph } from './parts.tsx'
import { brokenBlock, MachineRepair, StoreFixAction } from './StoreCard.tsx'
import { Signal } from './Signal.tsx'
import type { StorageJob, StorageView, StoreRow } from './types.ts'
import { orderProjects, sizeCacheKey, type ProjectSize, type ProjectSort } from './project-list.ts'
import css from './HomeCards.module.css'

export type Place = (machine: string | null | undefined) => string

/** How often a project card asks again while its first size count runs. */
export const SIZE_POLL_MS = 3000




function Name({ children, onClick, title }: { children: ReactNode, onClick: () => void, title?: string }): ReactNode {
  return <button type="button" className={css.name} title={title} onClick={(e) => { e.stopPropagation(); onClick() }}>{children}</button>
}

/**
 * What keeps a Store's projects from opening, worst first: down, unresolved,
 * an unreachable PostgreSQL server, or its machine stopped. Backup state is
 * not trouble here: the Store card shows it.
 */
/** A Store's trouble, short; `detail` is LayerFS's full words, `restart` the machine whose worker would fix it, `store` the broken Store whose fix is the one action. */
export type Trouble = RowSignal & { detail?: string, restart?: MachineInfo, store?: StoreRow, repair?: { machine: string, record: MachineInfo | null } }

export function storeTrouble(s: StoreRow, view: StorageView, t: StorageT, place: Place, fleet?: AvailableView | null): Trouble | null {
  // its machine's worker does not answer: say that, and offer the fix, instead of LayerFS's long refusal
  const host = s.kind === 'sqlite' ? fleet?.machines.find((m) => m.name === s.machine) : undefined
  // its machine cannot run here at all (Docker quit, Lima removed): say so; a restart would only fail
  if (host && fleet && machineBlock(host, fleet)) return { state: 'warning', reason: t('machineUnavailable', { machine: place(host.name) }) }
  if (host && workerDown(host, fleet?.live[host.name])) {
    return { state: 'error', reason: t('ovStoreWorkerDown', { machine: place(host.name) }), detail: downReason(host, fleet?.live[host.name]) ?? undefined, restart: host }
  }
  // the six-state word and its reason; `detail` is LayerFS's sentence (else its fix line), the fix the one action
  if (s.state === 'broken') {
    const tip = storeTip(s, t)
    return { state: 'error', reason: brokenWords(s, t), ...(tip ? { detail: tip } : {}), store: s }
  }
  // blocked by a broken machine (F3): the word, that machine's sentence as the tip, its fix (else Repair <m>) as the one action
  const repair = brokenBlock(s)
  if (repair) {
    const record = fleet?.machines.find((m) => m.name === repair) ?? null
    const tip = record?.message ?? record?.fix ?? s.blockedBy?.reason
    return { state: 'warning', reason: blockedWords(s.blockedBy!, t, place), ...(tip ? { detail: tip } : {}), repair: { machine: repair, record } }
  }
  if (s.state === 'blocked') return { state: 'warning', reason: s.blockedBy?.machine ? blockedWords(s.blockedBy, t, place) : storeStateWords(s.state, t, s.blockedBy?.reason) }
  if (s.state === 'unknown') return { state: 'warning', reason: storeStateWords(s.state, t) }
  if (s.kind === 'sqlite' && view.machines.find((m) => m.name === s.machine)?.state === 'stopped') return { state: 'warning', reason: t('machineStopped', { machine: place(s.machine) }) }
  return null
}

/** A trouble's one action: Restart worker, else the broken Store's fix where Center runs it. */
export function troubleAction(trouble: Trouble | null, t: StorageT, onRestart?: (m: MachineInfo) => Promise<unknown>): ReactNode {
  if (trouble?.restart && onRestart) return <RestartButton m={trouble.restart} t={t} onRestart={onRestart} />
  if (trouble?.repair) return <MachineRepair machine={trouble.repair.machine} record={trouble.repair.record} t={t} />
  return trouble?.store ? <StoreFixAction store={trouble.store} t={t} /> : undefined
}

/** Restart <machine>'s worker inside a signal's hover card (a press that names the machine it starts): busy while it runs, LayerFS's refusal as its tooltip. */
export function RestartButton({ m, t, onRestart }: { m: MachineInfo, t: StorageT, onRestart: (m: MachineInfo) => Promise<unknown> }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  // click safety (UI pass 3 F6): keyed to this machine, dropped while the card has just appeared or changed under the pointer
  const guard = usePressGuard(`restart:${m.name}:${m.state}:${m.reason ?? ''}`)
  return (
    <Button variant="outline" size="sm" disabled={busy} title={failed ?? t('ovRestartWorkerTitle', { machine: m.name })} data-machine={m.name}
      onClick={guard(() => { setBusy(true); setFailed(null); void onRestart(m).catch((e: unknown) => setFailed(String((e as Error)?.message ?? e))).finally(() => setBusy(false)) })}>
      {busy ? t('ovRestarting') : failed ? t('ovRestartFailed') : t('ovRestartWorker', { machine: m.name })}
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
                    action={troubleAction(trouble, t, onRestart)} />
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
