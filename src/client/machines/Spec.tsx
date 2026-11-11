/**
 * The machine page's Spec tab: everything LayerFS says about one machine, in
 * cards — Overview (platform, state, origin, tool and LayerFS versions,
 * readiness), Resources, Sandboxes, Stores, Connection — then its settings
 * (built-ins) or the danger zone. Reads only; nothing here starts, stops or
 * changes the machine except the buttons at the end.
 */
import type { ReactNode } from 'react'
import { Button, IconSettingsOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, Fact, Facts, Meter, Section } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import type { MachinesKey } from './locale.ts'
import { BUILT_IN, bytes, gib, heldWords, inUse, machineState, shortImage, type AvailableView, type MachineInfo, type MachineLive, type MachineSandbox, type MachineStore } from './model.ts'
import { MachineStateChip } from './parts.tsx'
import css from './machines.module.css'

const RUNS_AS: Record<string, MachinesKey> = { docker: 'runsContainers', native: 'runsProcessesNotIsolated', namespaces: 'runsNamespacesCgroup' }
const KERNEL: Record<string, MachinesKey> = { nfs: 'kernelNfs', fuse: 'kernelFuse' }
const CALLS: Record<string, MachinesKey> = { in_process: 'callsInProcess', worker: 'callsWorker' }
const HOW: Record<string, MachinesKey> = { built_in: 'howBuiltIn', created: 'howCreated' }

export function SpecTab({ m, live, view, sandboxes, stores, pending, onSettings, onRemove }: {
  m: MachineInfo
  live: MachineLive | undefined
  view: AvailableView
  sandboxes: MachineSandbox[]
  stores: MachineStore[]
  pending: string | null
  onSettings: () => void
  onRemove: () => void
}): ReactNode {
  const { t, tw, kind } = useMachinesContext()
  const p = view.platforms.find((x) => x.platform === m.platform)
  const state = machineState(m, live)
  const held = inUse(m)
  const used = m.disk && live?.freeDisk != null ? Math.max(0, m.disk - live.freeDisk) : null
  const share = used !== null && m.disk ? used / m.disk : null
  const running = sandboxes.filter((b) => b.state === 'running').length
  const workspaces = sandboxes.reduce((n, b) => n + (b.workspaces ?? 0), 0)
  const routes = [...new Set(sandboxes.flatMap((b) => (b.route ? [b.route] : [])))]
  const images = [...new Set(sandboxes.flatMap((b) => (b.image ? [b.image] : [])))]
  const storeBytes = stores.reduce((n, s) => n + (s.size ?? 0), 0)
  const builtIn = BUILT_IN.has(m.platform)
  const shared = m.platform === 'native' ? t('sharedNative') : m.platform === 'docker' ? t('sharedDocker') : null
  const missing = p?.missing ?? []
  const postgresql = (view.postgresql ?? []).length
  const pick = (map: Record<string, MachinesKey>, key: string | null | undefined) => (key ? (map[key] ? t(map[key]) : key) : null)
  return (
    <div className={css.spec}>
      <div className={css.specGrid}>
        <Section title={t('overview')}>
          <Card>
            <Facts>
              <Fact label={t('platform')}>{kind(m.platform)}{p?.description ? <span className={css.factSub}>{p.description}</span> : null}</Fact>
              <Fact label={t('state')}><MachineStateChip m={m} live={live} pending={null} /></Fact>
              {p?.how && <Fact label={t('origin')}>{pick(HOW, p.how)}</Fact>}
              <Fact label={t('tool')} mono>{live?.toolVersion ?? p?.version ?? null}</Fact>
              <Fact label={t('layerfs')} mono>{view.layerfs}</Fact>
              <Fact label={t('readiness')} tone={missing.length ? 'danger' : undefined}>
                {!p ? t('notListed') : missing.length ? t('missingList', { list: missing.join(', ') }) : t('readyHere')}
              </Fact>
              {live?.down && <Fact label={t('downBecause')} tone="danger">{live.down}</Fact>}
              {state.op && <Fact label={t('operation')} mono>{`${state.op.name} · ${state.op.phase}`}</Fact>}
              {m.error && <Fact label={t('error')} tone="danger">{m.error}</Fact>}
            </Facts>
          </Card>
        </Section>

        <Section title={t('resources')}>
          <Card>
            <Facts>
              <Fact label={t('cpus')}>{m.cpus ?? shared}</Fact>
              <Fact label={t('memory')}>{m.memory != null ? gib(m.memory) : shared}</Fact>
              <Fact label={t('disk')}>{m.disk != null ? gib(m.disk) : shared}</Fact>
              {share !== null
                ? (
                  <Fact label={t('diskUse')}>
                    <span className={css.factMeter}>
                      <Meter share={share} label={t('diskUse')} />
                      <span>{t('diskUsedFree', { used: gib(used!), free: gib(live!.freeDisk) })}</span>
                    </span>
                  </Fact>
                )
                : live?.freeDisk != null && <Fact label={t('freeDisk')}>{gib(live.freeDisk)}</Fact>}
            </Facts>
          </Card>
        </Section>

        <Section title={t('sandboxes')}>
          <Card>
            <Facts>
              <Fact label={t('runAs')}>{pick(RUNS_AS, m.backend) ?? t('runsUnknown')}</Fact>
              {p?.kernel && <Fact label={t('filesOver')}>{pick(KERNEL, p.kernel)}</Fact>}
              <Fact label={t('defaultImage')} mono={!!m.image} title={m.image}>{m.image ? shortImage(m.image) : m.backend === 'native' ? t('imageNone') : t('noneSet')}</Fact>
              <Fact label={t('hereNow')}>
                {sandboxes.length
                  ? t('hereNowValue', { running: String(running), total: String(sandboxes.length), ws: t(workspaces === 1 ? 'factWorkspaceOne' : 'factWorkspaces', { n: String(workspaces) }) })
                  : t('none')}
              </Fact>
              {routes.length > 0 && <Fact label={t('routesInUse')} mono>{routes.join(', ')}</Fact>}
              {images.length > 0 && <Fact label={t('imagesInUse')} mono>{images.map(shortImage).join(', ')}</Fact>}
            </Facts>
          </Card>
        </Section>

        <Section title={t('stores')}>
          <Card>
            <Facts>
              <Fact label={t('sqliteStores')}>
                {m.supports?.sqlite === false ? t('notHere') : stores.length ? `${stores.map((s) => s.name).join(', ')}${stores.some((s) => s.size != null) ? ` · ${bytes(storeBytes)}` : ''}` : t('noneOnDisk')}
              </Fact>
              {p?.sqlite && <Fact label={t('sqliteCallsIn')}>{pick(CALLS, p.sqlite)}</Fact>}
              <Fact label={t('pgSandboxes')} tone={m.supports?.postgresql_sandbox === false ? 'muted' : undefined}>
                {m.supports?.postgresql_sandbox
                  ? t(postgresql === 1 ? 'pgSupportedOne' : 'pgSupported', { n: String(postgresql) })
                  : m.supports?.postgresql_sandbox === false ? (m.supports.reason ?? t('no')) : t('notSaid')}
              </Fact>
              {p?.postgresql.store_calls && <Fact label={t('pgCallsIn')}>{pick(CALLS, p.postgresql.store_calls)}</Fact>}
            </Facts>
          </Card>
        </Section>

        {(m.docker || m.wsl) && (
          <Section title={t('connection')}>
            <Card>
              <Facts>
                {m.docker && <Fact label={t('dockerSocket')} mono>{m.docker}</Fact>}
                {m.wsl && <Fact label={t('wslDistribution')}>{m.wsl}</Fact>}
              </Facts>
            </Card>
          </Section>
        )}
      </div>

      <Card tone={builtIn ? undefined : 'danger'} className={css.zone}>
        {builtIn
          ? (
            <>
              <span className={css.zoneText}>{t('builtInNoRemove')}</span>
              <Button size="sm" variant="outline" icon={<IconSettingsOutlineRegular size={13} />} onClick={onSettings}>{t('updateSettings')}</Button>
            </>
          )
          : (
            <>
              <span className={css.zoneText}>
                <span className={css.zoneTitle}>{t('dangerZone')}</span>
                {held && <span className={css.muted}>{tw(heldWords(held))}</span>}
              </span>
              <Button size="sm" variant="outline" className={css.dangerOutline} icon={<IconTrashOutlineRegular size={13} />} disabled={!!held || pending !== null} onClick={onRemove}>
                {t('removeNamed', { name: m.name })}
              </Button>
            </>
          )}
      </Card>
    </div>
  )
}
