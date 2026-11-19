/**
 * The Overview's Details card and danger zone (Overview.tsx): what LayerFS
 * says about one machine — platform, readiness, tool version and what is on
 * it; how its Sandboxes run and reach their files, the worker, PostgreSQL
 * support; where Store calls run, the LayerFS version and the connection —
 * in a grid of three groups, then, for a created VM, Remove. Reads only;
 * nothing here changes the machine except the buttons.
 */
import type { ReactNode } from 'react'
import { Button, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, LinkButton } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import type { MachinesKey } from './locale.ts'
import { storeLines } from './Inventory.tsx'
import { BUILT_IN, fixAction, fixRemoves, heldWords, inUse, machineState, opWords, sandboxesOn, supports, unreadableRecord, vmGone, type AvailableView, type MachineInfo, type MachineLive } from './model.ts'
import { pgStoresHere, pgSupportKey } from './notices.ts'
import { useMachineStats } from './MachineStats.tsx'
import { upTime, unitsOf } from './metrics.ts'
import { liveCounts } from './stats.ts'
import css from './machines.module.css'

const RUNS_AS: Record<string, MachinesKey> = { docker: 'runsContainers', native: 'runsProcessesNotIsolated', namespaces: 'runsNamespacesCgroup' }
const KERNEL: Record<string, MachinesKey> = { nfs: 'kernelNfs', fuse: 'kernelFuse' }
const CALLS: Record<string, MachinesKey> = { in_process: 'callsInProcess', worker: 'callsWorker' }
const HOW: Record<string, MachinesKey> = { built_in: 'howBuiltIn', created: 'howCreated' }

/** One fact of the Details grid: a small label above its value. An empty value is a dash. */
function Item({ label, children, mono, tone, title }: { label: string, children?: ReactNode, mono?: boolean, tone?: 'danger' | 'success' | 'muted' | undefined, title?: string | undefined }): ReactNode {
  const none = children === null || children === undefined || children === '' || children === false
  return (
    <div className={css.dtItem} data-tone={none ? 'muted' : tone}>
      <dt>{label}</dt>
      <dd className={mono && !none ? css.mono : undefined} title={title}>{none ? '—' : children}</dd>
    </div>
  )
}

/** One group of the Details grid, titled. */
function Group({ title, children }: { title: string, children: ReactNode }): ReactNode {
  return (
    <section className={css.dtGroup} aria-label={title}>
      <h4 className={css.dtGroupTitle}>{title}</h4>
      <dl className={css.dtList}>{children}</dl>
    </section>
  )
}

/**
 * The Details card: the machine's facts in three groups (the machine, its
 * Sandboxes, where Store calls run and how it is reached), side by side when
 * there is room. `actions` (Run diagnostics, settings) sit in its head;
 * `onTab` makes the contents line open the Sandboxes and Stores tabs.
 */
export function MachineDetailsCard({ m, live, view, actions, onTab }: { m: MachineInfo, live: MachineLive | undefined, view: AvailableView, actions?: ReactNode, onTab?: ((tab: 'sandboxes' | 'stores') => void) | undefined }): ReactNode {
  const { t, kind, stateWord } = useMachinesContext()
  const p = view.platforms.find((x) => x.platform === m.platform)
  const state = machineState(m, live)
  const worker = useMachineStats(m).read?.stats?.worker ?? null
  const missing = p?.missing ?? []
  // the PostgreSQL Stores that run here, counted as the Stores tab lists them
  const postgresql = pgStoresHere(view, m).length
  const unreadable = unreadableRecord(m)
  const sandboxes = sandboxesOn(view, m)
  const running = liveCounts(sandboxes).running
  const stores = storeLines(view, m).length
  const pick = (map: Record<string, MachinesKey>, key: string | null | undefined) => (key ? (map[key] ? t(map[key]) : key) : null)
  const sandboxWords = t(sandboxes.length === 1 ? 'countSandboxOne' : 'countSandboxes', { n: String(sandboxes.length) }) + (sandboxes.length ? ` · ${t('countRunning', { n: String(running) })}` : '')
  const storeWords = t(stores === 1 ? 'countStoreOne' : 'countStores', { n: String(stores) })
  return (
    <Card className={css.ovDetails} data-machine-details={m.name}>
      <header className={css.columnHead}>
        <h3 className={css.columnTitle}>{t('details')}</h3>
        <span className={css.columnSpacer} />
        {actions}
      </header>
      <div className={css.dtGrid}>
        <Group title={t('ovGroupMachine')}>
          <Item label={t('platform')} title={p?.description ?? undefined}>{[kind(m.platform), p?.how ? pick(HOW, p.how) : null].filter(Boolean).join(' · ')}</Item>
          {/* an unreadable record names no platform: its readiness is not known, not "not offered" */}
          <Item label={t('readiness')} tone={missing.length || vmGone(m) ? 'danger' : p ? 'success' : undefined} title={unreadable ? m.message ?? undefined : undefined}>
            {unreadable ? t('readinessRecordUnreadable') : vmGone(m) ? t('readinessVmGone') : !p ? t('notListed') : missing.length ? t('missingList', { list: missing.join(', ') }) : t('readyHere')}
          </Item>
          <Item label={t('tool')} mono>{live?.toolVersion ?? p?.version ?? null}</Item>
          <Item label={t('ovContentsFact')}>
            {onTab
              ? <><LinkButton onClick={() => onTab('sandboxes')}>{sandboxWords}</LinkButton>{' · '}<LinkButton onClick={() => onTab('stores')}>{storeWords}</LinkButton></>
              : `${sandboxWords} · ${storeWords}`}
          </Item>
          {/* why it is down: the state's word, LayerFS's message as its tip; the head's fix is its one action (no prose here) */}
          {unreadable
            ? <Item label={t('downBecause')} tone="danger" title={m.message ?? undefined}>{t('stateUnreadable')}</Item>
            : m.message && m.state !== 'ready' && m.state !== 'stopped' && <Item label={t('downBecause')} tone="danger" title={m.message}>{stateWord(state)}</Item>}
          {/* a live read that failed on a machine that is not down is not a reason it is down (never "Down because: Running", F9) */}
          {!m.message && !unreadable && live?.error && m.state !== 'ready' && m.state !== 'stopped' && <Item label={t('downBecause')} tone="danger" title={live.error.message}>{stateWord(state)}</Item>}
          {state.op && <Item label={t('operation')} mono>{opWords(state.op)}</Item>}
          {/* a fix the page runs is the head's one action; only a line it cannot run stays here to copy */}
          {m.fix && !unreadable && fixAction(m)?.kind === 'copy' && <Item label={t('fix')} mono>{m.fix}</Item>}
        </Group>
        <Group title={t('sandboxes')}>
          <Item label={t('ovSandboxesRun')}>{pick(RUNS_AS, m.backend) ?? t('runsUnknown')}</Item>
          {p?.route && <Item label={t('filesOver')}>{pick(KERNEL, p.route)}</Item>}
          {worker && (
            <Item label={t('worker')}>
              {[worker.version ? t('workerVersion', { version: worker.version }) : null, worker.startedAt != null ? t('mxUpFor', { time: upTime(worker.startedAt, Date.now(), unitsOf(t)) }) : null].filter(Boolean).join(' · ') || null}
            </Item>
          )}
          <Item label={t('pgSandboxes')} tone={supports(m, 'postgresql_sandbox') === false ? 'muted' : undefined}>
            {supports(m, 'postgresql_sandbox')
              ? t(pgSupportKey(postgresql), { n: String(postgresql) })
              : supports(m, 'postgresql_sandbox') === false ? t('no') : t('notSaid')}
          </Item>
        </Group>
        <Group title={t('ovGroupCalls')}>
          {p?.sqlite && <Item label={t('sqliteCallsIn')}>{pick(CALLS, p.sqlite)}</Item>}
          {p?.postgresql.store_calls && <Item label={t('pgCallsIn')}>{pick(CALLS, p.postgresql.store_calls)}</Item>}
          <Item label={t('layerfs')} mono>{view.layerfs}</Item>
          {m.docker && <Item label={t('dockerSocket')} mono>{m.docker}</Item>}
          {m.wsl && <Item label={t('wslDistribution')}>{m.wsl}</Item>}
        </Group>
      </div>
    </Card>
  )
}

/** A created VM's Remove, refused while something holds the machine; a built-in has one only when LayerFS's fix removes its record. */
export function DangerZone({ m, pending, onRemove }: { m: MachineInfo, pending: string | null, onRemove: () => void }): ReactNode {
  const { t, tw } = useMachinesContext()
  // a built-in has none, unless LayerFS's own fix removes its record (`machine remove <m>`: LayerFS decides, U8)
  // (or LayerFS's chain: its Stores, then its record; the guided Remove removes them in that order)
  const recordOnly = fixRemoves(m)
  if (BUILT_IN.has(m.platform) && !recordOnly) return null
  const held = recordOnly ? null : inUse(m)
  // LayerFS refuses to remove a machine whose record it cannot read (Failed): off, with the reason the list row's menu gives
  const unreadable = unreadableRecord(m)
  const why = unreadable ? t('recordUnreadableNoRemove') : held ? tw(heldWords(held)) : null
  return (
    <Card tone="danger" className={css.zone}>
      <span className={css.zoneText}>
        <span className={css.zoneTitle}>{t('dangerZone')}</span>
        {why && <span className={css.muted} data-remove-off={unreadable ? 'unreadable' : 'held'}>{why}</span>}
      </span>
      <Button size="sm" variant="outline" className={css.dangerOutline} icon={<IconTrashOutlineRegular size={13} />} disabled={!!why || pending !== null}
        title={why ?? undefined} onClick={onRemove}>
        {t('removeNamed', { name: m.name })}
      </Button>
    </Card>
  )
}
