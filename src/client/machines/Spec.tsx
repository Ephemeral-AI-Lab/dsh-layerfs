/**
 * The Overview's Details card and danger zone (Overview.tsx): what LayerFS
 * says about one machine that the resource tiles and the Sandbox and Store
 * lists do not show — platform, how its Sandboxes run and reach their files,
 * the worker and tool versions, readiness, where Store calls run, PostgreSQL
 * support and the connection — then, for a created VM, Remove. Reads only;
 * nothing here changes the machine except the buttons.
 */
import type { ReactNode } from 'react'
import { Button, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, Fact, Facts } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import type { MachinesKey } from './locale.ts'
import { BUILT_IN, heldWords, inUse, machineState, type AvailableView, type MachineInfo, type MachineLive } from './model.ts'
import { useMachineStats } from './MachineStats.tsx'
import { upTime } from './metrics.ts'
import css from './machines.module.css'

const RUNS_AS: Record<string, MachinesKey> = { docker: 'runsContainers', native: 'runsProcessesNotIsolated', namespaces: 'runsNamespacesCgroup' }
const KERNEL: Record<string, MachinesKey> = { nfs: 'kernelNfs', fuse: 'kernelFuse' }
const CALLS: Record<string, MachinesKey> = { in_process: 'callsInProcess', worker: 'callsWorker' }
const HOW: Record<string, MachinesKey> = { built_in: 'howBuiltIn', created: 'howCreated' }

/** The Details card; `actions` (Run diagnostics, settings) sit in its head. */
export function MachineDetailsCard({ m, live, view, actions }: { m: MachineInfo, live: MachineLive | undefined, view: AvailableView, actions?: ReactNode }): ReactNode {
  const { t, kind } = useMachinesContext()
  const p = view.platforms.find((x) => x.platform === m.platform)
  const state = machineState(m, live)
  const worker = useMachineStats(m).read?.stats?.worker ?? null
  const missing = p?.missing ?? []
  const postgresql = (view.postgresql ?? []).length
  const pick = (map: Record<string, MachinesKey>, key: string | null | undefined) => (key ? (map[key] ? t(map[key]) : key) : null)
  return (
    <Card className={css.ovDetails} data-machine-details={m.name}>
      <header className={css.columnHead}>
        <h3 className={css.columnTitle}>{t('details')}</h3>
        <span className={css.columnSpacer} />
        {actions}
      </header>
      <Facts label={t('details')}>
        <Fact label={t('platform')} title={p?.description ?? undefined}>{kind(m.platform)}</Fact>
        {p?.how && <Fact label={t('origin')}>{pick(HOW, p.how)}</Fact>}
        <Fact label={t('ovSandboxesRun')}>{pick(RUNS_AS, m.backend) ?? t('runsUnknown')}</Fact>
        {p?.kernel && <Fact label={t('filesOver')}>{pick(KERNEL, p.kernel)}</Fact>}
        {worker && (
          <Fact label={t('worker')}>
            {worker.version ? t('workerVersion', { version: worker.version }) : null}
            {worker.startedAt != null ? <span className={css.factSub}>{t('mxUpFor', { time: upTime(worker.startedAt, Date.now()) })}</span> : null}
          </Fact>
        )}
        <Fact label={t('tool')} mono>{live?.toolVersion ?? p?.version ?? null}</Fact>
        <Fact label={t('layerfs')} mono>{view.layerfs}</Fact>
        <Fact label={t('readiness')} tone={missing.length ? 'danger' : undefined}>
          {!p ? t('notListed') : missing.length ? t('missingList', { list: missing.join(', ') }) : t('readyHere')}
        </Fact>
        {p?.sqlite && <Fact label={t('ovStoreCalls')}>{pick(CALLS, p.sqlite)}</Fact>}
        <Fact label={t('pgSandboxes')} tone={m.supports?.postgresql_sandbox === false ? 'muted' : undefined}>
          {m.supports?.postgresql_sandbox
            ? t(postgresql === 1 ? 'pgSupportedOne' : 'pgSupported', { n: String(postgresql) })
            : m.supports?.postgresql_sandbox === false ? (m.supports.reason ?? t('no')) : t('notSaid')}
        </Fact>
        {p?.postgresql.store_calls && <Fact label={t('pgCallsIn')}>{pick(CALLS, p.postgresql.store_calls)}</Fact>}
        {m.docker && <Fact label={t('dockerSocket')} mono>{m.docker}</Fact>}
        {m.wsl && <Fact label={t('wslDistribution')}>{m.wsl}</Fact>}
        {live?.down && <Fact label={t('downBecause')} tone="danger">{live.down}</Fact>}
        {state.op && <Fact label={t('operation')} mono>{`${state.op.name} · ${state.op.phase}`}</Fact>}
        {m.error && <Fact label={t('error')} tone="danger">{m.error}</Fact>}
      </Facts>
    </Card>
  )
}

/** A created VM's Remove, refused while something holds the machine; built-in machines have none. */
export function DangerZone({ m, pending, onRemove }: { m: MachineInfo, pending: string | null, onRemove: () => void }): ReactNode {
  const { t, tw } = useMachinesContext()
  if (BUILT_IN.has(m.platform)) return null
  const held = inUse(m)
  return (
    <Card tone="danger" className={css.zone}>
      <span className={css.zoneText}>
        <span className={css.zoneTitle}>{t('dangerZone')}</span>
        {held && <span className={css.muted}>{tw(heldWords(held))}</span>}
      </span>
      <Button size="sm" variant="outline" className={css.dangerOutline} icon={<IconTrashOutlineRegular size={13} />} disabled={!!held || pending !== null} onClick={onRemove}>
        {t('removeNamed', { name: m.name })}
      </Button>
    </Card>
  )
}
