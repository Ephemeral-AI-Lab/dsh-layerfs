/**
 * The machines board: one table, a row per machine (those that need you
 * first) with aligned columns (name, state, memory, disk, what it holds,
 * power and menu). A row opens to show its Stores and Sandboxes, each column
 * with its add verb (Add Store, New Sandbox) and each row a menu; the row's
 * name opens the machine's tab. It is the home page's Machines tab
 * (HomeOverview.tsx), whose tab bar carries New machine and Diagnose host;
 * the `machines` page id opens that tab.
 */
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronRightOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { DoctorAction } from '../doctor/Doctor.tsx'
import { Card, Empty, LoadError, Loading, Meter, Notice, Refusal, refusalOf } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { MachineGlyph, MachinesGlyph } from './icons.tsx'
import type { View } from './context.tsx'
import { Inventory, creatingOn, storeLines, useMachineTitle, type StoreMenuOf } from './Inventory.tsx'
import {
  RANK, downReason, gib, machineOrder, machineState, runsFix, runtimeOf, sandboxesOn, unreadableNamed, unreadableRecord, unreportedDiskKey,
  type AvailableView, type MachineInfo,
} from './model.ts'
import { engineStart, machineBlock, nativeGlyphOs, nativeNameKey, osOfView, stepReasons, type Readiness } from './needs.ts'
import { MachineDialogs, MachineMenu, MachineProgress, MachineStateChip, PowerButton, useMachineRun } from './parts.tsx'
import { ObservedDisk, useMachineStats } from './MachineStats.tsx'
import { MemoryCell } from './MetricsViews.tsx'
import { Blocked } from './Readiness.tsx'
import { SpaceCell } from './SpaceViews.tsx'
import { NewSandboxDialog } from './Sandboxes.tsx'
import css from './machines.module.css'
import { clockTime } from '../ui/locale-sync.ts'

/**
 * `onAddStore`: Storage's Add Store dialog for a machine (move a SQLite Store
 * there, or connect a PostgreSQL one); `storeMenu`: a Store row's menu for a
 * machine (Storage's Store actions). Without them the Stores column has
 * neither.
 */
export function Board({ go, onAddStore, storeMenu }: {
  go: (view: View) => void
  onAddStore?: ((machine: string) => void) | undefined
  storeMenu?: ((machine: string) => StoreMenuOf) | undefined
}): ReactNode {
  const { t, useMachines, useStartups, reload, refusal } = useMachinesContext()
  const read = useMachines((s) => s)
  const startups = useStartups((s) => s)
  const view = read.data
  const available = view?.available ? view : null
  const starting = useMemo(() => new Set(Object.values(startups).filter((s) => s.status === 'running').map((s) => s.name)), [startups])
  const machines = useMemo(() => {
    if (!available) return []
    const rank = (m: MachineInfo) => (starting.has(m.name) ? RANK.busy : RANK[machineState(m, available.live[m.name]).key])
    return machineOrder(available.machines).sort((a, b) => rank(a) - rank(b))
  }, [available, starting])
  const [choices, choose] = useOpenChoices()

  return (
    <>
      {view && read.error != null && (
        <Notice tone="warning" role="status">
          {/* the word, LayerFS's code and words as its tip; never a path or parse error inline (UI pass 3 F9) */}
          <p title={`${refusalOf(read.error).code}: ${refusalOf(read.error).message}`}>{unreadableNamed(read.error) ? t('staleUnreadable', { name: unreadableNamed(read.error)! }) : t('staleRead', { time: read.observedAt ? clockTime(read.observedAt) : '—' })}</p>
        </Notice>
      )}
      {!view
        ? read.status === 'error'
          ? <LoadError title={t('readMachinesFailed')} error={read.error} labels={refusal} retryLabel={t('retry')} onRetry={reload} />
          : <Loading label={t('readingMachines')} />
        : !available
          ? <Empty icon={<MachinesGlyph size={20} />} title={t('noMachinesTitle')}>{t('noMachinesBody', { version: view.layerfs ?? '1.x' })}</Empty>
          : (
            <>
              {Object.entries(available.readErrors ?? {}).map(([part, e]) => (
                <Notice key={part} tone="danger" role="status">
                  <p title={`${e.error.code}: ${e.error.message}`}>{t('partUnreadWord', { part, time: clockTime(e.at) })}</p>
                </Notice>
              ))}
              <Card className={css.fleet}>
                <div className={css.fleetTable} role="table" aria-label={t('panel')}>
                  <FleetHead />
                  {machines.map((m) => (
                    <MachineRow key={m.name} m={m} view={available} only={machines.length === 1} chosen={choices[m.name]} onToggle={(open) => choose(m.name, open)}
                      onOpen={() => go({ kind: 'machine', name: m.name })} onAddStore={onAddStore} storeMenu={storeMenu?.(m.name)} />
                  ))}
                </div>
              </Card>
            </>
          )}
    </>
  )
}

/** How much a machine needs you: failed, missing or unresolved (danger); its platform not ready here, or stopped while it holds Stores (warning). */
export function attentionOf(m: MachineInfo, view: AvailableView): 'danger' | 'warning' | null {
  // a machine that cannot run here is a fix to make, not a failure; its record may still say failed or unreachable
  if (blockedOf(m, view)) return 'warning'
  if (machineState(m, view.live[m.name]).key === 'needs') return 'danger'
  return m.state === 'stopped' && m.stores.length > 0 ? 'warning' : null
}

/** What keeps `m` from running here (needs.ts machineBlock). */
export const blockedOf = (m: MachineInfo, view: AvailableView): Readiness | null => machineBlock(m, view)

/** The machine's mark: the native machine's is this computer's OS. */
export const glyphOs = (m: MachineInfo, view: AvailableView) => (m.platform === 'native' ? nativeGlyphOs(osOfView(view)) : undefined)

/**
 * A machine's disk in words, with a meter. With a CLI that has machine.stats
 * it is the observed data disk (used, total, free and what that filesystem
 * is; MachineStats.tsx), read every `every` ms while this line is on screen.
 * Without it, the line is what it was: free space from machine get --with live against
 * the record's requested size.
 */
export function DiskLine({ m, view }: { m: MachineInfo, view: AvailableView }): ReactNode {
  const { offered, read } = useMachineStats(m)
  return offered ? <ObservedDisk m={m} read={read} /> : <RecordDisk m={m} view={view} />
}

/**
 * The disk line of a CLI without machine.stats: free space as reported, a
 * meter against the size the record was created with. Without a reported
 * free space, the recorded size labelled "allocated" (keyed on what was
 * observed, never on the platform).
 */
function RecordDisk({ m, view }: { m: MachineInfo, view: AvailableView }): ReactNode {
  const { t } = useMachinesContext()
  const live = view.live[m.name]
  const used = m.disk && live?.freeDisk != null ? Math.max(0, m.disk - live.freeDisk) : null
  const share = used !== null && m.disk ? used / m.disk : null
  if (live?.freeDisk == null) {
    return <span className={css.muted}>{m.disk != null ? t('mxAllocatedDisk', { size: gib(m.disk) }) : t(unreportedDiskKey(m))}</span>
  }
  return (
    <span className={css.diskLine}>
      {share !== null && <Meter share={share} label={t('diskUse')} className={css.diskMeter} />}
      <span>{m.disk != null ? t('diskFreeOf', { free: gib(live.freeDisk), total: gib(m.disk) }) : t('diskFree', { free: gib(live.freeDisk) })}</span>
    </span>
  )
}


/**
 * A machine's disk in its row: with machine stats --with space, LayerFS's data, what is
 * not LayerFS's and free space as one bar (SpaceViews.tsx SpaceCell); else the
 * observed data disk from machine.stats; else what the record says.
 */
function DiskCell({ m, view }: { m: MachineInfo, view: AvailableView }): ReactNode {
  const { t } = useMachinesContext()
  const { offered, read } = useMachineStats(m)
  const r = offered ? read?.stats?.resources : undefined
  const observed = r?.diskTotal != null && r.diskUsed != null && r.diskTotal > 0
    ? (
      <span className={css.cellStack} data-mx-disk>
        <Meter share={r.diskUsed / r.diskTotal} label={t('diskUse')} className={css.cellBar} />
        <span className={css.cellText} title={t('mxDiskOf', { used: gib(r.diskUsed), total: gib(r.diskTotal) })}>
          {r.diskFree != null ? t('diskFreeOf', { free: gib(r.diskFree), total: gib(r.diskTotal) }) : t('mxDiskOf', { used: gib(r.diskUsed), total: gib(r.diskTotal) })}
        </span>
      </span>
    )
    : <span className={css.cellText}><RecordDisk m={m} view={view} /></span>
  return <SpaceCell m={m} fallback={observed} />
}

/** What a machine holds, in two short lines: its Stores and its Sandboxes (those being created count). */
function HoldsCell({ m, view }: { m: MachineInfo, view: AvailableView }): ReactNode {
  const { t, useCreations } = useMachinesContext()
  const sandboxes = sandboxesOn(view, m)
  const creations = useCreations((all) => all)
  const stores = storeLines(view, m).length
  const boxes = sandboxes.length + creatingOn(creations, m.name, sandboxes).length
  return (
    <span className={css.cellStack}>
      <span className={css.cellText} data-holds="stores">{stores === 0 ? t('holdsNoStores') : t(stores === 1 ? 'holdsStoreOne' : 'holdsStores', { n: String(stores) })}</span>
      <span className={css.cellText} data-holds="sandboxes">{boxes === 0 ? t('holdsNoSandboxes') : t(boxes === 1 ? 'holdsSandboxOne' : 'holdsSandboxes', { n: String(boxes) })}</span>
    </span>
  )
}

/** The table's head row: the columns' names. */
function FleetHead(): ReactNode {
  const { t } = useMachinesContext()
  return (
    <div className={clsx(css.fleetRow, css.fleetHead)} role="row">
      <span role="columnheader" aria-hidden="true" />
      <span role="columnheader">{t('colMachine')}</span>
      <span role="columnheader">{t('state')}</span>
      <span role="columnheader" className={css.fleetMemory}>{t('memory')}</span>
      <span role="columnheader" className={css.fleetDisk}>{t('disk')}</span>
      <span role="columnheader" className={css.fleetHolds}>{t('colHolds')}</span>
      <span role="columnheader" aria-hidden="true" />
    </div>
  )
}

/** Whether a click on the row came from one of its own controls (or a menu portalled out of it), which handle themselves. */
function fromControl(e: MouseEvent<HTMLElement>): boolean {
  const target = e.target as Element
  if (!e.currentTarget.contains(target)) return true
  return target.closest('button, a, input, select, [role="menu"], [role="menuitem"]') !== null
}

/**
 * One machine: its row (name, state, memory, disk, what it holds, power and
 * menu) and, when open, what it holds (its Stores and Sandboxes) with the
 * reason it needs you. The row toggles; its name opens the machine's tab.
 * Open by default when it needs you, is blocked or is starting, or is the
 * only machine; a choice made here is kept for this viewer.
 */
function MachineRow({ m, view, chosen, onToggle, onOpen, onAddStore, storeMenu, only }: {
  m: MachineInfo, view: AvailableView, chosen: boolean | undefined, onToggle: (open: boolean) => void, onOpen: () => void
  onAddStore?: ((machine: string) => void) | undefined, storeMenu?: StoreMenuOf | undefined, only: boolean
}): ReactNode {
  const { t, tw, kind, api, doctorT, useStartups, refusal, stateWord } = useMachinesContext()
  const title = useMachineTitle()
  const startup = useStartups((all) => all[m.name])
  const live = view.live[m.name]
  const startingNow = startup?.status === 'running'
  const reason = startingNow ? null : downReason(m, live)
  const attention = startingNow ? null : attentionOf(m, view)
  const block = startingNow ? null : blockedOf(m, view)
  // only the Docker Engine is not running: Start launches it, then the machine
  const engine = engineStart(m, block, osOfView(view))
  const { run, pending: localPending, error } = useMachineRun()
  const pending = localPending ?? (startingNow ? startup.kind : null)
  const [dialog, setDialog] = useState<'settings' | 'remove' | 'force-stop' | null>(null)
  const [creating, setCreating] = useState(false)
  const name = title(m)
  const open = chosen ?? (only || attention !== null || startingNow || error !== null)
  const detailId = `machine-detail-${m.name}`
  const plus = <IconPlusOutlineRegular size={11} />
  // an unreadable record: nothing goes on the machine until diagnostics say what is wrong (the reason Remove gives too)
  const noUse = unreadableRecord(m) ? t('recordUnreadableNoRemove') : null
  const storeAction = onAddStore && !block
    ? <button type="button" className={css.columnAction} disabled={noUse !== null} onClick={() => onAddStore(m.name)} title={noUse ?? t('addStoreTo', { name })} data-no-use={noUse ? '' : undefined}>{plus}{t('addStore')}</button>
    : null
  // a Sandbox on a stopped machine starts it first (the dialog says so); not while a start or stop runs
  const sandboxAction = !block
    ? <button type="button" className={css.columnAction} disabled={pending !== null || noUse !== null} onClick={() => setCreating(true)} title={noUse ?? t('newSandboxOn', { name })} data-no-use={noUse ? '' : undefined}>{plus}{t('newSandbox')}</button>
    : null
  const sub = m.platform === 'native' ? `${t(nativeNameKey(osOfView(view)))} · ${tw(runtimeOf(m))}` : m.platform ? `${kind(m.platform)} · ${tw(runtimeOf(m))}` : t('platformUnknown')
  // an unreadable record: the page's sentence, LayerFS's own words as its tip
  const unreadable = unreadableRecord(m)
  return (
    <div className={css.fleetMachine} data-machine={m.name} data-open={open || undefined} data-tone={attention ?? undefined} role="rowgroup" aria-label={name}>
      <div className={css.fleetRow} role="row" onClick={(e) => { if (!fromControl(e)) onToggle(!open) }}>
        <button type="button" className={css.fleetToggle} aria-expanded={open} aria-controls={detailId}
          aria-label={t(open ? 'collapseMachine' : 'expandMachine', { name })} title={t(open ? 'collapseMachine' : 'expandMachine', { name })}
          onClick={() => onToggle(!open)}>
          <IconChevronRightOutlineRegular size={12} />
        </button>
        <span className={css.blockIdentity} role="cell">
          <span className={css.blockGlyph} aria-hidden="true"><MachineGlyph platform={m.platform} os={glyphOs(m, view)} size={16} /></span>
          <span className={css.blockNames}>
            <button type="button" className={css.blockName} onClick={onOpen} title={t('openMachine', { name })}>{name}</button>
            <span className={css.blockSub} title={sub}>{sub}</span>
          </span>
        </span>
        <span role="cell" className={css.fleetState}><MachineStateChip m={m} live={live} pending={pending} blocked={engine ? 'engine' : !!block} /></span>
        <span role="cell" className={css.fleetMemory}><MemoryCell m={m} /></span>
        <span role="cell" className={css.fleetDisk}>
          {/* a blocked machine reports no disk: why it cannot run shows here, without opening the row */}
          {block ? <span className={css.cellStack}><span className={css.cellText} title={stepReasons(block, tw)}>{stepReasons(block, tw)}</span></span> : <DiskCell m={m} view={view} />}
        </span>
        <span role="cell" className={css.fleetHolds}><HoldsCell m={m} view={view} /></span>
        <span role="cell" className={css.fleetActions}>
          {m.platform === 'native' || (block && !engine) ? null : <PowerButton m={m} pending={pending} run={run} compact engine={engine} />}
          <MachineMenu m={m} pending={pending} run={run} onOpen={onOpen} onDialog={setDialog} />
        </span>
      </div>
      {open && (
        <div className={css.fleetDetail} id={detailId}>
          {block && <Blocked m={m} block={block} action={engine ? <PowerButton m={m} pending={pending} run={run} engine /> : undefined} />}
          {!block && (reason || attention === 'danger') && (
            <div className={css.blockReason}>
              {/* the state's word, LayerFS's message as its tip; the row's fix button is its one action, else Run diagnostics */}
              <span className={css.blockReasonText} title={reason ?? undefined}>{unreadable ? t('recordUnreadable') : reason ? stateWord(machineState(m, live)) : t('needsInspect', { state: t(machineState(m, live).label ?? 'stateUnknown') })}</span>
              {attention === 'danger' && !runsFix(m) && <DoctorAction api={api} t={doctorT} target="machine" name={m.name} label={doctorT('runDiagnostics')} />}
            </div>
          )}
          {error !== null && <div className={css.blockReason}><Refusal error={error} labels={refusal} compact /></div>}
          {startingNow && <div className={css.blockProgress}><MachineProgress name={m.name} compact /></div>}
          <Inventory m={m} view={view} storeAction={storeAction} sandboxAction={sandboxAction} storeMenu={storeMenu} sandboxMenus flat />
        </div>
      )}
      <MachineDialogs m={m} dialog={dialog} onClose={() => setDialog(null)} pending={pending} run={run} />
      {creating && <NewSandboxDialog machine={m} taken={view.sandboxes.map((b) => b.name)} onClose={() => setCreating(false)} />}
    </div>
  )
}

const OPEN_KEY = 'dsh-layerfs:machines-open'

/** The rows opened or closed here, kept for this viewer (a convenience: nothing breaks without storage). */
function useOpenChoices(): [Record<string, boolean>, (name: string, open: boolean) => void] {
  const [choices, setChoices] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean> } catch { return {} }
  })
  const choose = (name: string, open: boolean) => setChoices((all) => {
    const next = { ...all, [name]: open }
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
    return next
  })
  return [choices, choose]
}
