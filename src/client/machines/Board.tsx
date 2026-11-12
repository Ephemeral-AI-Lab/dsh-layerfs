/**
 * The Machines board: the page head (New machine, Refresh), one line of
 * facts, and a card per machine
 * (those that need you first), then the manual-power note. A card opens the
 * machine's page.
 */
import { useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconPlusOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { DoctorAction } from '../doctor/Doctor.tsx'
import { Card, Empty, LinkButton, LoadError, Loading, Meter, Notice, Page, PageHead, Refusal } from '../ui/index.tsx'
import { AddMachineDialog } from './AddMachineDialog.tsx'
import { useMachinesContext } from './context.tsx'
import { MachineGlyph, MachinesGlyph } from './icons.tsx'
import type { View } from './MachinesPage.tsx'
import {
  RANK, clearingCall, downReason, factsOf, gib, machineOrder, machineState, runtimeOf, sandboxesOn, storesOn,
  type AvailableView, type MachineInfo,
} from './model.ts'
import { MachineDialogs, MachineMenu, MachineProgress, MachineStateChip, PowerButton, useInspect, useMachineRun } from './parts.tsx'
import css from './machines.module.css'

/** Stores a card names before "+N". */
const STORES_SHOWN = 3

/** The Storage page's panel id (the dsh-layerfs Storage area). */
export const STORAGE_PANEL = 'layerfs-storage'

export function Board({ go }: { go: (view: View) => void }): ReactNode {
  const { t, api, doctorT, useMachines, useStartups, reload, refusal } = useMachinesContext()
  const read = useMachines((s) => s)
  const startups = useStartups((s) => s)
  const [adding, setAdding] = useState(false)
  const view = read.data
  const available = view?.available ? view : null
  const starting = useMemo(() => new Set(Object.values(startups).filter((s) => s.status === 'running').map((s) => s.name)), [startups])
  const machines = useMemo(() => {
    if (!available) return []
    const rank = (m: MachineInfo) => (starting.has(m.name) ? RANK.busy : RANK[machineState(m, available.status[m.name]).key])
    return machineOrder(available.machines).sort((a, b) => rank(a) - rank(b))
  }, [available, starting])

  return (
    <Page wide label={t('panel')}>
      <PageHead
        title={t('panel')}
        intro={t('boardIntro')}
        actions={(
          <>
            <DoctorAction api={api} t={doctorT} target="host" label={doctorT('diagnoseHost')} />
            <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={reload}>{t('refresh')}</Button>
            {available && <Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={13} />} onClick={() => setAdding(true)}>{t('newMachine')}</Button>}
          </>
        )}
      />
      {view && read.error != null && (
        <Notice tone="warning" role="status">
          <p>{t('staleRead', { time: read.observedAt ? new Date(read.observedAt).toLocaleTimeString() : '—' })}</p>
          <Refusal error={read.error} labels={refusal} compact />
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
              <FactsLine view={available} starting={starting.size} />
              {Object.entries(available.readErrors ?? {}).map(([part, e]) => (
                <Notice key={part} tone="danger" role="status">
                  <p>{t('partUnread', { part, time: new Date(e.at).toLocaleTimeString(), code: e.error.code, message: e.error.message })}</p>
                </Notice>
              ))}
              <section className={css.grid} aria-label={t('panel')}>
                {machines.map((m) => (
                  <MachineCard key={m.name} m={m} view={available} onOpen={() => go({ kind: 'machine', name: m.name })} />
                ))}
              </section>
              <p className={css.footnote}>{t('powerNote')}</p>
              {adding && <AddMachineDialog view={available} onClose={() => setAdding(false)} onMade={(name) => go({ kind: 'machine', name })} platforms={available.platforms} />}
            </>
          )}
    </Page>
  )
}

/** Running, stopped, startups, Sandboxes, Workspaces, needs you, operations in flight. */
function FactsLine({ view, starting }: { view: AvailableView, starting: number }): ReactNode {
  const { t } = useMachinesContext()
  const f = factsOf(view)
  const n = (k: number) => String(k)
  const parts: { text: string, tone?: 'strong' | 'danger' }[] = [
    { text: t('factRunning', { n: n(f.running) }), ...(f.running > 0 ? { tone: 'strong' as const } : {}) },
    { text: t('factStopped', { n: n(f.stopped) }) },
    ...starting > 0 ? [{ text: t(starting === 1 ? 'factStartupOne' : 'factStartups', { n: n(starting) }) }] : [],
    ...f.busy > 0 ? [{ text: t('factBusy', { n: n(f.busy) }) }] : [],
    ...f.unknown > 0 ? [{ text: t('factUnknown', { n: n(f.unknown) }) }] : [],
    { text: t(f.sandboxes === 1 ? 'factSandboxOne' : 'factSandboxes', { n: n(f.sandboxes) }) },
    { text: f.workspacesKnown ? t(f.workspaces === 1 ? 'factWorkspaceOne' : 'factWorkspaces', { n: n(f.workspaces) }) : t('factWorkspacesUnknown') },
    ...f.needs > 0 ? [{ text: t(f.needs === 1 ? 'factNeedsOne' : 'factNeeds', { n: n(f.needs) }), tone: 'danger' as const }] : [],
    ...f.ops > 0 ? [{ text: t(f.ops === 1 ? 'factOpOne' : 'factOps', { n: n(f.ops) }), tone: 'strong' as const }] : [],
  ]
  return (
    <p className={css.facts}>
      {parts.map((p, i) => (
        <span key={i} className={css.factPart} data-tone={p.tone}>
          {i > 0 && <span className={css.factDot} aria-hidden="true">·</span>}
          {p.text}
        </span>
      ))}
    </p>
  )
}

/** How much a machine needs you: failed, missing or unresolved (danger); stopped while it holds Stores (warning). */
export function attentionOf(m: MachineInfo, view: AvailableView): 'danger' | 'warning' | null {
  if (machineState(m, view.status[m.name]).key === 'needs') return 'danger'
  return m.state === 'stopped' && m.stores.length > 0 ? 'warning' : null
}

/** A machine overview: identity, allocation, inventory, Stores, disk and manual power. */
function MachineCard({ m, view, onOpen }: { m: MachineInfo, view: AvailableView, onOpen: () => void }): ReactNode {
  const { t, tw, kind, useStartups, refusal, openPanel } = useMachinesContext()
  const startup = useStartups((all) => all[m.name])
  const live = view.status[m.name]
  const state = machineState(m, live)
  const startingNow = startup?.status === 'running'
  const reason = startingNow ? null : downReason(m, live)
  const stores = storesOn(view, m)
  const boxes = sandboxesOn(view, m)
  const known = boxes.reduce((n, b) => n + (b.workspaces ?? 0), 0)
  const workspaces = boxes.some((b) => b.workspaces === null) ? (known > 0 ? `${known}+` : '—') : String(known)
  const attention = startingNow ? null : attentionOf(m, view)
  const { run, pending: localPending, error } = useMachineRun()
  const pending = localPending ?? (startingNow ? startup.kind : null)
  const { inspection, inspect } = useInspect(m.name)
  const [dialog, setDialog] = useState<'settings' | 'remove' | 'force-stop' | null>(null)
  const noAllocation = m.platform === 'native' || (m.cpus == null && m.memory == null && m.disk == null)
  const calls = state.state === 'unresolved' ? clearingCall('machine', m.name, state.op) : null
  const used = m.disk && live?.freeDisk != null ? Math.max(0, m.disk - live.freeDisk) : null
  const share = used !== null && m.disk ? used / m.disk : null
  const titleId = `lfs-machine-${m.name}`
  return (
    <Card tone={attention ?? undefined} className={clsx(css.machineCard)} aria-labelledby={titleId} data-machine={m.name}>
      <header className={css.cardHead}>
        <span className={css.kindTile} aria-hidden="true"><MachineGlyph platform={m.platform} os={m.backend === 'namespaces' ? 'linux' : m.backend == null ? 'pc' : undefined} size={18} /></span>
        <div className={css.cardTitleBlock}>
          <h2 id={titleId} className={css.cardTitle}>
            <button type="button" className={css.cardOpen} onClick={onOpen} title={t('openMachine', { name: m.name })}>{m.name}</button>
          </h2>
          <p className={css.cardSub}>{kind(m.platform)} · {tw(runtimeOf(m))}</p>
        </div>
        <div className={css.above}><MachineMenu m={m} pending={pending} run={run} onOpen={onOpen} onDialog={setDialog} /></div>
      </header>

      {noAllocation
        ? <p className={css.shared}>{t(m.platform === 'native' ? 'allocNative' : m.platform === 'docker' ? 'allocDocker' : 'allocUnreported')}</p>
        : (
          <dl className={css.capacity} aria-label={t('allocations')}>
            <div><dt>{t('cpu')}</dt><dd>{m.cpus != null ? t(m.cpus === 1 ? 'coresOne' : 'cores', { n: String(m.cpus) }) : t('notReported')}</dd></div>
            <div><dt>{t('memory')}</dt><dd>{m.memory != null ? gib(m.memory) : t('notReported')}</dd></div>
            <div><dt>{t('diskCapacity')}</dt><dd>{m.disk != null ? gib(m.disk) : t('notReported')}</dd></div>
          </dl>
        )}

      <dl className={css.inventory} aria-label={t('inventory')}>
        <div><dd>{boxes.length}</dd><dt>{t(boxes.length === 1 ? 'sandboxOne' : 'sandboxes')}</dt></div>
        <div title={workspaces.endsWith('+') ? t('workspacesPartly') : undefined}><dd>{workspaces}</dd><dt>{t(workspaces === '1' ? 'workspaceOne' : 'workspaces')}</dt></div>
        <div><dd>{view.readErrors?.stores ? '—' : stores.length}</dd><dt>{t(stores.length === 1 ? 'localStoreOne' : 'localStores')}</dt></div>
      </dl>

      <div className={css.storesLine}>
        <span className={css.storesLabel}>{t('stores')}</span>
        <span className={css.storesList}>
          {stores.length
            ? (
              <>
                {stores.slice(0, STORES_SHOWN).map((s) => (
                  <LinkButton key={s.name} className={css.above} onClick={() => openPanel(STORAGE_PANEL)} title={t('openStore', { name: s.name })}>{s.name}</LinkButton>
                ))}
                {stores.length > STORES_SHOWN && <span className={css.muted}>{t('moreCount', { n: String(stores.length - STORES_SHOWN) })}</span>}
              </>
            )
            : <span className={css.muted}>{t(view.readErrors?.stores ? 'storesUnread' : 'storesNone')}</span>}
        </span>
      </div>

      {(reason || attention || error !== null) && (
        <Notice tone={attention === 'danger' || error !== null ? 'danger' : attention === 'warning' ? 'warning' : undefined} className={css.cardNotice}>
          {(reason || attention) && (
            <p className={css.clamp} title={reason ?? undefined}>
              {reason || (attention === 'warning' ? t(stores.length === 1 ? 'startToUseStore' : 'startToUseStores') : t('needsInspect', { state: t(state.label ?? 'stateUnknown') }))}
            </p>
          )}
          {calls && <p><code>{t('inspectCall', { call: calls.status })}</code></p>}
          {error !== null && (
            <>
              <Refusal error={error} labels={refusal} compact />
              <span className={css.above}><LinkButton onClick={() => void inspect()}>{t('inspectState')}</LinkButton></span>
              {inspection && <p>{inspection}</p>}
            </>
          )}
          {attention && <span className={css.above}><LinkButton onClick={onOpen}>{t('viewDetails')}</LinkButton></span>}
        </Notice>
      )}

      <div className={css.disk} aria-label={t('diskStatus')}>
        <span className={css.diskLabel}>{t('disk')}</span>
        <span className={css.diskValue}>
          {live?.freeDisk != null
            ? (m.disk != null ? t('diskFreeOf', { free: gib(live.freeDisk), total: gib(m.disk) }) : t('diskFree', { free: gib(live.freeDisk) }))
            : t(m.platform === 'native' ? 'diskShared' : 'diskUnreported')}
        </span>
        {share !== null && <Meter share={share} label={t('diskUse')} className={css.diskMeter} />}
      </div>

      {m.platform === 'docker' && m.state === 'stopped' && pending !== 'start' && <p className={css.dockerNote}>{t('dockerStoppedNote')}</p>}
      <MachineProgress name={m.name} compact />

      <footer className={css.cardFoot}>
        <MachineStateChip m={m} live={live} pending={pending} />
        <div className={css.above}>
          {m.platform === 'native' ? <span className={css.muted}>{t('thisComputer')}</span> : <PowerButton m={m} pending={pending} run={run} />}
        </div>
      </footer>
      <MachineDialogs m={m} dialog={dialog} onClose={() => setDialog(null)} pending={pending} run={run} />
    </Card>
  )
}
