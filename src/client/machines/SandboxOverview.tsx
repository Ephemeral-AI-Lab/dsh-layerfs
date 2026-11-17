/**
 * A Sandbox page's Overview tab (SandboxDetail.tsx picks the tab), styled
 * like the machine page's Overview (Overview.tsx):
 *
 * - Details, headed by the Sandbox's icon, name and state with Diagnose,
 *   Refresh and its menu: project, machine, image, Workspaces mounted of capacity,
 *   runtime, route, created, up time and id. Drawn from the `sandbox.list`
 *   row until sandbox.get answers.
 * - Usage, from the sampler's last read (machine.stats): processor, memory,
 *   processes and out-of-memory kills as they are now, no history. A Sandbox with no
 *   cgroup of its own (a host process) says so once, and shows its whole
 *   machine in muted figures instead of four dashes. Without machine.stats
 *   the caller's `fallback` (sandbox.get's usage line) stands in.
 * - On disk (machine.space): the run folder split into Workspace changes,
 *   own files, and runtime and log.
 * - Daemon (sandbox.get): reachable or not, its control slots as squares,
 *   pid and start, and the retained failures behind "View".
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Card, LinkButton, Loading, Meter } from '../ui/index.tsx'
import { cachedAnswer } from '../ui/use-query.ts'
import { useMachinesContext } from './context.tsx'
import { displayRef } from './images.ts'
import { useMetrics } from './MachineStats.tsx'
import { cpuShare } from './machine-tabs.ts'
import { latest, machineCpu, processors, sandboxFigures, upTime } from './metrics.ts'
import { useWords } from './MetricsViews.tsx'
import { daemonLook, daemonSlots, gib, type SandboxImagesView, type SandboxInfo } from './model.ts'
import { sandboxSpaceReason, spaceSize } from './space.ts'
import { useMachineSpace } from './SpaceViews.tsx'
import css from './machines.module.css'

export interface SandboxOverviewProps {
  name: string
  machine: string
  /** The machine's title with its kind ("LayerFS Home (Native)"). */
  machineTitle: string
  info: SandboxInfo | null
  /** What the list row knows until sandbox.get answers. */
  listed: { project?: string | null, workspaces?: number | null } | undefined
  /** sandbox.get is still being read (no error yet) while `info` is null. */
  loading: boolean
  /** Shown in place of Usage when the pinned CLI has no machine.stats. */
  fallback: ReactNode
  onMachine: () => void
  onWorkspaces: () => void
  /** Diagnose, Refresh and the Sandbox menu, in the Details card's head. */
  actions?: ReactNode
  /** The Sandbox's glyph and state chip, beside its name at the head of the Details card. */
  icon?: ReactNode
  badge?: ReactNode
}

export function SandboxOverview(p: SandboxOverviewProps): ReactNode {
  const { useMachines } = useMachinesContext()
  const metrics = useMachines((s) => (s.data?.available ? s.data.features?.inspect?.machineStats === true : false))
  return (
    <div className={css.ovStack} data-sandbox-overview={p.name}>
      <DetailsCard {...p} />
      {metrics ? <UsageCard name={p.name} machine={p.machine} /> : p.fallback}
      <div className={css.sbovPair}>
        <DiskCard name={p.name} machine={p.machine} />
        <DaemonCard info={p.info} loading={p.loading} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- details

function Item({ label, children, mono, title, ...data }: { label: string, children?: ReactNode, mono?: boolean, title?: string | undefined } & Record<`data-${string}`, string | undefined>): ReactNode {
  const none = children === null || children === undefined || children === '' || children === false
  return (
    <div className={css.dtItem} data-tone={none ? 'muted' : undefined} {...data}>
      <dt>{label}</dt>
      <dd className={mono && !none ? css.mono : undefined} title={title}>{none ? '—' : children}</dd>
    </div>
  )
}

function DetailsCard({ name, machine, machineTitle, info, listed, onMachine, onWorkspaces, actions, icon, badge }: SandboxOverviewProps): ReactNode {
  const { t } = useMachinesContext()
  const { snapshot } = useMetrics(machine)
  const project = info?.project ?? listed?.project ?? null
  const mounted = info ? info.workspaces.length : listed?.workspaces ?? null
  const capacity = info?.workspaceCapacity
  const startedAt = snapshot.sandboxes[name] ? sandboxFigures(snapshot, name)?.row?.startedAt ?? null : null
  const started = startedAt ?? info?.daemon?.startedAt ?? null
  const live = info ? info.state === 'running' : true
  const created = info?.created != null ? new Date(info.created < 1e12 ? info.created * 1000 : info.created).toLocaleString() : null
  const id = info?.runtimeId ?? info?.id ?? null
  return (
    <Card className={css.ovDetails} data-sandbox-details={name}>
      <header className={css.sbovHead}>
        {icon && <span className={css.sbovHeadIcon} aria-hidden="true">{icon}</span>}
        {/* the page's h1 (screen readers only) already names it */}
        <span className={css.sbovHeadName} title={name} aria-hidden="true">{name}</span>
        {badge}
        <span className={css.columnSpacer} />
        {actions && <span className={css.sbovHeadActions}>{actions}</span>}
      </header>
      <dl className={css.sbovGrid}>
        <Item label={t('project')} mono data-sbov="project">{project}</Item>
        <Item label={t('sbovMachine')} data-sbov="machine"><LinkButton onClick={onMachine}>{machineTitle}</LinkButton></Item>
        <Item label={t('image')} data-sbov="image">{info ? <ImageName info={info} machine={machine} /> : null}</Item>
        <Item label={t('workspaces')} data-sbov="workspaces">
          {mounted != null && (
            <LinkButton onClick={onWorkspaces}>
              {capacity != null ? t('sbovMountedOf', { n: String(mounted), of: String(capacity) }) : t('sbovMounted', { n: String(mounted) })}
            </LinkButton>
          )}
        </Item>
        <Item label={t('runtime')} data-sbov="runtime">{info ? [...new Set([info.runtime, info.backend].filter(Boolean))].join(' · ') : null}</Item>
        <Item label={t('filesystemRoute')} data-sbov="route">{info?.route}</Item>
        <Item label={t('created')} data-sbov="created">{created}</Item>
        <Item label={t('mxUpTime')} data-sbov="up">{live && started != null ? upTime(started, snapshot.now ?? Date.now()) : null}</Item>
        <Item label={t('sbovId')} mono title={id ?? undefined} data-sbov="id">{id}</Item>
      </dl>
    </Card>
  )
}

/** The Sandbox's image: its name when the machine's last images answer knows the id, else the id as LayerFS gives it. */
function ImageName({ info, machine }: { info: SandboxInfo, machine: string }): ReactNode {
  const { t } = useMachinesContext()
  const known = info.image ? cachedAnswer<SandboxImagesView>(`machines:images:${info.machine ?? machine}`)?.ready.find((r) => r.id === info.image) : undefined
  const name = known ? (known.source === 'bundle' ? t('imageLayerfsDefault') : known.name || displayRef(known.refs)) : null
  if (name) return <span title={info.image ?? undefined}>{name}</span>
  if (info.image) return <span className={css.mono} title={info.image}>{info.image}</span>
  return info.backend === 'native' ? <>{t('imageNone')}</> : null
}

// ---------------------------------------------------------------- usage

function Column({ label, children, ...data }: { label: string, children: ReactNode } & Record<`data-${string}`, string | undefined>): ReactNode {
  return (
    <div className={css.ovCol} {...data}>
      <div className={css.ovColHead} title={label}>{label}</div>
      {children}
    </div>
  )
}

function NotRead({ why, word }: { why?: string | null, word?: string }): ReactNode {
  const { t } = useMachinesContext()
  return <><div className={css.ovNotRead}>{word ?? t('ovNotRead')}</div>{why && <div className={css.ovWhy} title={why}>{why}</div>}</>
}

/** Usage while the sampler reads the Sandbox's machine; the reasons LayerFS gives for a Sandbox it cannot measure on its own. */
const UNMEASURED = new Set(['host_process', 'no_cgroup', 'cgroup_v1'])

function UsageCard({ name, machine }: { name: string, machine: string }): ReactNode {
  const { t } = useMachinesContext()
  const w = useWords()
  const { offered, snapshot } = useMetrics(machine)
  const f = useMemo(() => sandboxFigures(snapshot, name), [snapshot, name])
  const entry = snapshot.machines[machine]
  const machineCpuSamples = useMemo(() => (entry ? machineCpu(entry.points, snapshot.tick) : []), [entry, snapshot.tick])
  if (!offered || !snapshot.loaded) return null
  if (!f) {
    if (entry?.latest && !entry.latest.stats.sandboxes.items) return <p className={css.muted} data-mx-older>{t('mxOlderWorker')}</p>
    return null
  }
  const row = f.row, u = f.gap ? null : row?.usage ?? null
  const why = f.gap ?? row?.usageReason ?? row?.liveReason
  // no cgroup of its own: one note, and the whole machine instead
  const unmeasured = !f.gap && !!row && !row.usage && UNMEASURED.has(row.usageReason ?? '')
  const at = entry?.points.at(-1)?.t ?? null
  const head = (
    <header className={css.ovUsageHead}>
      <h3 className={css.columnTitle}>{t('ovUsage')}</h3>
      <span className={css.columnSpacer} />
      {at != null && <span className={css.columnCount}>{t('ovReadAt', { time: new Date(at).toLocaleTimeString() })}</span>}
    </header>
  )
  if (unmeasured) {
    const r = entry?.latest?.stats.resources
    const cpuNow = latest(machineCpuSamples)
    return (
      <Card className={css.ovUsage} data-ov-usage={name} data-sandbox-usage="none" data-usage-reason={row?.usageReason ?? ''}>
        {head}
        <p className={css.sbovNote} data-sbov-unmeasured>{t('sbovUnmeasured', { reason: w.reason(row?.usageReason) })}</p>
        <div className={css.ovCols} data-cols="4" data-muted>
          <Column label={t('mxProcessor')} data-ov-tile="cpu">
            <NotRead word="—" why={cpuNow?.v != null ? t('sbovMachineCpu', { share: `${cpuShare(cpuNow.v)} %`, n: r?.cpus != null ? String(r.cpus) : '—' }) : t('sbovMachineCpuNotRead')} />
          </Column>
          <Column label={t('memory')} data-ov-tile="memory">
            <NotRead word="—" why={r?.memoryUsed != null && r.memoryTotal != null ? t('sbovMachineMemory', { used: gib(r.memoryUsed), total: gib(r.memoryTotal) }) : null} />
          </Column>
          <Column label={t('mxProcesses')} data-ov-tile="pids"><NotRead word="—" why={t('sbovNotCounted')} /></Column>
          <Column label={t('mxOomKills')} data-ov-tile="oom"><NotRead word="—" why={t('sbovNotCounted')} /></Column>
        </div>
      </Card>
    )
  }
  const cpuNow = latest(f.cpu)
  const peak = u?.memoryPeak ?? null
  const kills = u?.oomKills ?? null
  const reason = w.reason(why)
  return (
    <Card className={css.ovUsage} data-ov-usage={name} data-mx-sandbox={name} data-sandbox-usage={u ? 'observed' : 'none'} data-usage-reason={row?.usageReason ?? ''}>
      {head}
      <div className={css.ovCols} data-cols="4">
        <Column label={t('mxProcessor')} data-ov-tile="cpu">
          {cpuNow?.v != null
            ? <div className={css.ovValue} data-mx-figure="cpu">{processors(cpuNow.v)}{f.cpus != null && <span className={css.ovValueOf}>{t('sbovOfProcessors', { n: String(f.cpus) })}</span>}</div>
            : <NotRead why={w.gap(cpuNow?.reason ?? why)} />}
          {cpuNow?.v != null && f.cpus != null && f.cpus > 0 && <Meter share={cpuNow.v / f.cpus} label={t('mxProcessor')} tone="neutral" className={css.ovBar} />}
        </Column>
        <Column label={t('memory')} data-ov-tile="memory">
          {u?.memoryCurrent != null
            ? <div className={css.ovValue} data-mx-figure="memory">{gib(u.memoryCurrent)}{peak != null && <span className={css.ovValueOf}>{t('mxPeak', { size: gib(peak) })}</span>}</div>
            : <NotRead why={reason} />}
          {u?.memoryCurrent != null && u.memoryFile != null && <div className={css.ovFoot}><span>{t('mxFileShare', { size: gib(u.memoryFile) })}</span></div>}
        </Column>
        <Column label={t('mxProcesses')} data-ov-tile="pids">
          {u?.pids != null ? <div className={css.ovValue} data-mx-figure="pids">{String(u.pids)}</div> : <NotRead why={reason} />}
          <div className={css.ovFoot}><span>{t('sbovNow')}</span></div>
        </Column>
        <Column label={t('mxOomKills')} data-ov-tile="oom">
          {kills != null
            ? <div className={css.ovValue} data-tone={kills > 0 ? 'danger' : undefined} data-mx-figure="oom">{String(kills)}</div>
            : <NotRead why={u ? t('sbovNotCounted') : reason} />}
          <div className={css.ovFoot}><span>{t('sbovSinceStart')}</span></div>
        </Column>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------- disk

function DiskCard({ name, machine }: { name: string, machine: string }): ReactNode {
  const { t, tw, useMachines } = useMachinesContext()
  const m = useMachines((s) => (s.data?.available ? s.data.machines.find((x) => x.name === machine) ?? null : null))
  const { offered, read } = useMachineSpace(m ?? { name: machine, state: 'unknown' })
  if (!offered || !m) return null
  const row = read.data?.space?.sandboxes.find((r) => r.name === name)
  const add = (...v: (number | null)[]) => v.reduce<number>((a, b) => a + (b ?? 0), 0)
  const parts = row && row.bytes != null ? [
    { key: 'changes', label: t('sbovDiskChanges'), size: row.overlays ?? 0 },
    { key: 'files', label: t('sbovDiskFiles'), size: add(row.writes, row.home) },
    { key: 'runtime', label: t('sbovDiskRuntime'), size: add(row.runtime, row.log) },
  ] : null
  const sum = parts ? parts.reduce((a, x) => a + x.size, 0) : 0
  const why = row && row.bytes == null ? sandboxSpaceReason(row.reason) : null
  return (
    <Card className={css.sbovSmall} data-sandbox-disk={name}>
      <header className={css.columnHead}>
        <h3 className={css.columnTitle}>{t('spaceSandboxFigure')}</h3>
        <span className={css.columnSpacer} />
        {row?.bytes != null && <span className={css.sbovTotal} data-sandbox-disk-total>{row.reason === 'deadline' ? t('spaceAtLeast', { size: spaceSize(row.bytes) }) : spaceSize(row.bytes)}</span>}
      </header>
      {!row ? (read.data === undefined ? <Loading label={t('sbovReadingDisk')} /> : <p className={css.muted}>{t('notObservedYet')}</p>)
        : why ? <p className={css.muted}>{t('spaceNotReadBecause', { reason: tw(why) })}</p>
          : parts && (
            <>
              <span className={css.sbovBar} role="img" aria-label={parts.map((x) => `${x.label} ${spaceSize(x.size)}`).join(', ')}>
                {sum > 0 && parts.map((x) => x.size > 0 && <span key={x.key} data-part={x.key} style={{ width: `${(x.size / sum) * 100}%` }} />)}
              </span>
              <div className={css.sbovKeys}>
                {parts.map((x) => <span key={x.key}><i className={css.sbovKey} data-part={x.key} />{`${x.label} ${spaceSize(x.size)}`}</span>)}
              </div>
            </>
          )}
    </Card>
  )
}

// ---------------------------------------------------------------- daemon

function DaemonCard({ info, loading }: { info: SandboxInfo | null, loading: boolean }): ReactNode {
  const { t } = useMachinesContext()
  const [open, setOpen] = useState(false)
  if (!info) return loading ? <Card className={css.sbovSmall}><Loading label={t('readingSandbox')} /></Card> : null
  const look = daemonLook(info)
  const slots = daemonSlots(info)
  const retained = info.daemonCapacity?.retained
  const failures = retained?.failures ?? []
  const count = retained?.count ?? failures.length
  const d = info.daemon
  return (
    <Card className={css.sbovSmall} data-sandbox-daemon>
      <header className={css.columnHead}>
        <h3 className={css.columnTitle}>{t('sbovDaemon')}</h3>
        <span className={css.columnSpacer} />
        <span className={css.sbovTone} data-tone={look.tone}>{t(look.key)}</span>
      </header>
      {slots && slots.total > 0 && (
        <span className={css.sbovSlots} role="img" aria-label={t('sbSlotsFree', { free: String(slots.free), total: String(slots.total) })}>
          {Array.from({ length: Math.min(slots.total, 32) }, (_, i) => <i key={i} data-used={i >= slots.free || undefined} />)}
        </span>
      )}
      <p className={css.sbovLine}>
        {slots && t('sbSlotsFree', { free: String(slots.free), total: String(slots.total) })}
        {d !== undefined && (
          <span data-daemon-process={!d ? 'not-observed' : d.startedAt != null ? 'running' : 'ended'}>
            {slots ? ' · ' : ''}
            {!d ? t('sbProcessNotObserved') : [
              d.pid != null ? t('pidOf', { pid: String(d.pid) }) : t('sbNoPid'),
              d.startedAt != null ? t('sbStartedAt', { time: new Date(d.startedAt).toLocaleString() }) : t('sbProcessEnded'),
            ].join(' · ')}
          </span>
        )}
      </p>
      {count > 0 && (
        <p className={css.sbovLine} data-tone="warning">
          {count === 1 ? t('sbFailuresOne') : t('sbFailures', { n: String(count) })}
          {failures.length > 0 && <>{' '}<LinkButton onClick={() => setOpen((o) => !o)}>{open ? t('sbovHide') : t('sbovView')}</LinkButton></>}
        </p>
      )}
      {open && failures.length > 0 && (
        <table className={css.rows} aria-label={t('sbRetained')}>
          <thead><tr><th>{t('sbSlot')}</th><th className={css.colWide}>{t('sbCause')}</th><th>{t('sbAge')}</th></tr></thead>
          <tbody>
            {failures.map((x, i) => (
              <tr key={i}>
                <td className={css.mono}>{[x.class, x.slot].filter((v) => v != null).join(' ')}</td>
                <td className={css.colWide}>{x.cause ?? '—'}</td>
                <td className={css.muted}>{x.age_ms != null ? `${Math.round(x.age_ms / 1000)}s` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
