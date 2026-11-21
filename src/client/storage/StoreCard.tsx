/**
 * The Store pieces the explorer and the Store page share: where a Store is,
 * the Store menu, the words under its name and why it needs you now.
 */
import { useContext, type ReactNode } from 'react'
import { Button, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { FixAction, FixContext, LinkButton, MoreMenu, resolveFix, usePressGuard } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { blockedWords, brokenWords, compactWaitsFor, inHome, latestBackup, storeStateWords, storeTip, storeWaitsFor } from './model.ts'
import { useMachinesMaybe } from '../machines/context.tsx'
import type { MachineInfo } from '../machines/model.ts'
import { refusalLabels } from './parts.tsx'
import type { StorageJob, StoreBackupLink, StoreRow } from './types.ts'
import css from './Storage.module.css'

export interface StoreActions {
  push: () => void
  pull: () => void
  move: () => void
  backup: () => void
  backupTo: (link: StoreBackupLink) => void
  /** Confirm, then compact the Store; absent when the selected LayerFS runtime has no store.compact. */
  compact?: (() => void) | undefined
  restore: (bucket: string, file: string) => void
  remove: () => void
  disconnect: () => void
  start: () => void
  addProject: () => void
  retry: (job: StorageJob) => void
  dismiss: (job: StorageJob) => void
  openMachine: (name: string) => void
  /** PostgreSQL: edit the Store's connection, or (`machine`) that machine's own. */
  editConnection: (machine?: string) => void
  /** PostgreSQL: the check from a machine (this computer unless named); LayerFS records what it saw. */
  check: (machine?: string) => void
  /** PostgreSQL: Connect a machine: the check from a machine not yet connected, then its own address if it fails (spec v23). */
  connectMachine: () => void
  /** PostgreSQL: confirm, then remove a machine's own connection (it dials the Store's again). */
  removeOwn: (machine: string) => void
  /** PostgreSQL: Connect a database on this Store's server, with its user and password. */
  newOnServer: () => void
}

/** Where a Store is: the home, a machine (opens it on Machines), or its PostgreSQL server. */
export function Location({ store: s, t, onMachine }: { store: StoreRow, t: StorageT, onMachine: (name: string) => void }): ReactNode {
  if (s.kind === 'postgresql') return <span className={css.mono} title={s.postgresql?.target ?? undefined}>{s.postgresql?.target ?? t('postgresql')}</span>
  if (inHome(s)) return <span>{t('layerfsHome')}</span>
  return <LinkButton onClick={() => s.machine && onMachine(s.machine)}>{s.machine ?? '?'}</LinkButton>
}

/** A saved PostgreSQL login's own actions (a login group's header): a new password, and Remove while no Store names it. */
export interface LoginActions {
  rotate: (auth: string) => void
  remove: (auth: string) => void
}

/**
 * A Store's ⋯ menu: every Store-wide action. A PostgreSQL Store's (spec v23
 * §5.1): Check (from this computer; on a machine page, `machine`: from that
 * one), Change login…, Disconnect a machine for each machine with an address
 * of its own, and Disconnect.
 */
export function StoreMenu({ store: s, on, t, machine, runningJob }: { store: StoreRow, on: StoreActions, t: StorageT, machine?: string | undefined, runningJob?: boolean | undefined }): ReactNode {
  const pg = s.kind === 'postgresql'
  const storeBlocked = storeWaitsFor(s, t, !!runningJob)
  // LayerFS compacts a Store where it lives (a machine's sqlite Store on its worker); the 2.0 state alone decides
  const compactBlocked = compactWaitsFor(s, t, !!runningJob)
  return (
    <MoreMenu label={t('storeActions', { name: s.name })}>
      {(close) => {
        const run = (fn: () => void) => () => { close(); fn() }
        const compact = on.compact ? <MenuItemButton disabled={compactBlocked !== null} disabledReason={compactBlocked ?? undefined} onSelect={run(on.compact)}>{t('compactStore')}</MenuItemButton> : null
        return pg ? (
          <>
            <MenuItemButton onSelect={run(() => on.check(machine))}>{t('pgCheck')}</MenuItemButton>
            <MenuItemButton onSelect={run(() => on.editConnection())}>{t('pgChangeLogin')}</MenuItemButton>
            {(s.ownConnections ?? []).map((c) => (
              <MenuItemButton key={c.machine} onSelect={run(() => on.removeOwn(c.machine))}>{t('pgDisconnectMachine', { machine: c.machine === 'native' ? t('layerfsHome') : c.machine })}</MenuItemButton>
            ))}
            {compact}
            <MenuItemButton danger separatorBefore onSelect={run(on.disconnect)}>{t('disconnect')}</MenuItemButton>
          </>
        ) : (
          <>
            {inHome(s)
              ? <MenuItemButton disabled={storeBlocked !== null} disabledReason={storeBlocked ?? undefined} onSelect={run(on.push)}>{t('pushTo')}</MenuItemButton>
              : (
                <>
                  <MenuItemButton disabled={storeBlocked !== null} disabledReason={storeBlocked ?? undefined} onSelect={run(on.pull)}>{t('pullHome')}</MenuItemButton>
                  <MenuItemButton disabled={storeBlocked !== null} disabledReason={storeBlocked ?? undefined} onSelect={run(on.move)}>{t('moveTo')}</MenuItemButton>
                </>
              )}
            <MenuItemButton disabled={storeBlocked !== null} disabledReason={storeBlocked ?? undefined} onSelect={run(on.backup)}>{t('backupTo')}</MenuItemButton>
            {s.links.map((l) => (
              <MenuItemButton key={l.bucket} disabled={storeBlocked !== null} disabledReason={storeBlocked ?? undefined} onSelect={run(() => on.backupTo(l))}>
                {`${t('backupNow')} · ${l.bucket}/${l.file}`}
              </MenuItemButton>
            ))}
            {compact}
            <MenuItemButton danger separatorBefore onSelect={run(on.remove)}>{t('remove')}</MenuItemButton>
          </>
        )
      }}
    </MoreMenu>
  )
}

/** The words under a Store's name: family · place · size · backups. */
export function StoreSub({ store: s, t, now, onMachine }: { store: StoreRow, t: StorageT, now: number, onMachine: (name: string) => void }): ReactNode {
  const pg = s.kind === 'postgresql'
  const latest = latestBackup(s)
  return (
    <span className={css.cardSub}>
      <span>{pg ? t('postgresql') : t('sqlite')}</span>
      <span className={css.dotSep} aria-hidden="true">·</span>
      <Location store={s} t={t} onMachine={onMachine} />
      {!pg ? (
        <>
          <span className={css.dotSep} aria-hidden="true">·</span>
          <span>{s.size ? (s.size.stale && s.size.seen ? `${bytes(s.size.bytes)} (${t('msSizeSeen', { when: ago(s.size.seen, now, t as Translate) })})` : bytes(s.size.bytes)) : t('sizeUnavailable')}</span>
          <span className={css.dotSep} aria-hidden="true">·</span>
          <span>{!s.links.length ? t('noBackup') : [s.links.length === 1 ? t('backupOne') : t('backups', { n: s.links.length }), latest !== null && ago(latest, now, t as Translate)].filter(Boolean).join(' · ')}</span>
        </>
      ) : null}
    </span>
  )
}

/** Why a Store needs you now, if it does: its state word and reason (the fix is the one action beside it). */
export function storeNotice(s: StoreRow, machineState: string | null | undefined, t: StorageT): string | null {
  if (s.state === 'broken') return brokenWords(s, t)
  // waiting on its stopped machine: a word, never the bare sentence (K FAIL 1)
  if (stoppedBlock(s) && s.blockedBy?.machine) return t('waitingOnMachine', { machine: s.blockedBy.machine })
  if (s.state === 'blocked' && s.blockedBy?.machine) return blockedWords(s.blockedBy, t)
  if (s.state === 'broken' || s.state === 'blocked' || s.state === 'unknown') return storeStateWords(s.state, t, s.reason ?? s.blockedBy?.reason)
  if (s.kind === 'sqlite' && machineState === 'stopped') return t('machineStopped', { machine: s.machine ?? '?' })
  return null
}

/**
 * A broken Store's one action: its `fix` line where Center can run it
 * ({@link FixContext}): Compact for an unknown outcome, Save a login… for a
 * PostgreSQL Store that names no saved login (the save-login dialog), and so
 * on. Null when the line stays a tip.
 */
export function StoreFixAction({ store: s, t }: { store: Pick<StoreRow, 'state' | 'fix'>, t: StorageT }): ReactNode {
  const fixes = useContext(FixContext)
  // a broken Store's fix, or a blocked one's (`layerfs machine start M` for a stopped machine: R2-2)
  const resolved = fixes && (s.state === 'broken' || s.state === 'blocked') ? resolveFix(fixes, s.fix) : null
  return resolved?.fix && fixes ? <FixAction line={resolved.line} fix={resolved.fix} runner={fixes} labels={refusalLabels(t)} /> : null
}

/** A Store waiting on its stopped machine (`blocked_by { machine, reason: stopped }`, LayerFS gives no fix). */
export const stoppedBlock = (s: Pick<StoreRow, 'state' | 'blockedBy'>): boolean => s.state === 'blocked' && ['', 'stopped'].includes(s.blockedBy?.reason ?? '')

/** The machine a Store waits on while that machine is broken (not stopped or busy), or null (F3). */
export const brokenBlock = (s: Pick<StoreRow, 'state' | 'blockedBy'>): string | null =>
  s.state === 'blocked' && s.blockedBy?.machine && !['', 'stopped', 'busy'].includes(s.blockedBy.reason) ? s.blockedBy.machine : null

/** That machine's record from the Machines read, where the page has one. */
function useBlockingMachine(s: Pick<StoreRow, 'state' | 'blockedBy'>): MachineInfo | null {
  const mc = useMachinesMaybe()
  const name = brokenBlock(s)
  // the context is there or not for the whole life of a page part, so the hook is called the same way each render
  const m = mc ? mc.useMachines((snapshot) => (snapshot.data?.available && name ? snapshot.data.machines.find((x) => x.name === name) ?? null : null)) : null
  return m ?? null
}

/** A Store's status tip: LayerFS's sentence for the Store; for one blocked by a broken machine, that machine's sentence (else its reason). */
export function useStoreTip(s: StoreRow, t: StorageT): string | undefined {
  const m = useBlockingMachine(s)
  if (stoppedBlock(s) && s.blockedBy?.machine && !s.message) return t('waitingOnMachineTip', { machine: s.blockedBy.machine, store: s.name })
  if (!brokenBlock(s)) return storeTip(s, t)
  return m?.message ?? m?.fix ?? s.blockedBy?.reason ?? undefined
}

/**
 * A Store's one action on its status line: a broken Store's own fix; a Store
 * blocked by a broken machine, that machine's fix where Center runs it
 * (Remove record, Run doctor…), else Repair <m>, which opens the machine.
 * Never the raw reason.
 */
export function StoreAction({ store: s, t, onStart }: { store: StoreRow, t: StorageT, /** The Store's own Start <machine> (its card's actions). */ onStart?: (() => void) | undefined }): ReactNode {
  const m = useBlockingMachine(s)
  const machine = brokenBlock(s)
  if (s.state === 'broken') return <StoreFixAction store={s} t={t} />
  if (machine) return <MachineRepair machine={machine} record={m} t={t} />
  // waiting on a stopped machine with no fix from LayerFS: Start <m>, the machines page's own guarded start (K FAIL 1)
  if (stoppedBlock(s) && !s.fix && s.blockedBy?.machine && onStart) return <MachineStartAction machine={s.blockedBy.machine} t={t} onStart={onStart} />
  return s.state === 'blocked' ? <StoreFixAction store={s} t={t} /> : null
}

/**
 * Start <m> for a Store waiting on it: the Store's own start (StoreActions.start,
 * the Store page's existing "Start <machine>"), named by its machine, behind the
 * press guard (the same settle as the power controls): a stray click on a
 * control that just appeared starts nothing.
 */
export function MachineStartAction({ machine, t, onStart }: { machine: string, t: StorageT, onStart: () => void }): ReactNode {
  const guard = usePressGuard(`start:${machine}`)
  return (
    <Button size="sm" variant="outline" disabled={guard.settling} aria-disabled={guard.settling || undefined} aria-label={t('startMachineNamed', { machine })} data-start-machine={machine}
      onClick={guard((e) => { e.stopPropagation(); onStart() })}>
      {t('startMachineNamed', { machine })}
    </Button>
  )
}

/** A broken machine's one action for what waits on it: its fix, else Repair <m> (its page). */
export function MachineRepair({ machine, record, t }: { machine: string, record: Pick<MachineInfo, 'fix' | 'message'> | null | undefined, t: StorageT }): ReactNode {
  const fixes = useContext(FixContext)
  const mc = useMachinesMaybe()
  const resolved = resolveFix(fixes, record?.fix)
  if (resolved?.fix && fixes) return <FixAction line={resolved.line} fix={resolved.fix} runner={fixes} labels={refusalLabels(t)} />
  return mc ? (
    <Button size="sm" variant="outline" title={record?.message ?? record?.fix ?? undefined} data-repair={machine}
      onClick={(e) => { e.stopPropagation(); mc.openStorageTab(`machine:${machine}`) }}>
      {t('repairMachine', { machine })}
    </Button>
  ) : null
}
