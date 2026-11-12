/**
 * The Health page (its own row under LayerFS in the sidebar, ../health): a
 * landing view over everything `layerfs doctor` can diagnose, plus the
 * PostgreSQL facts the host already holds. The hero gives the verdict and
 * Check all; the group cards count each kind of resource; what needs attention
 * follows; then every resource with only the checks that apply to it, each a
 * pill:
 *
 *   host, machine, Sandbox   its diagnosis
 *   Store                    integrity; a PostgreSQL Store adds its doctor
 *                            connection check, whether the host reaches it
 *                            now (`GET /api/storage`'s live probe) and each
 *                            attached machine's last check; a backed-up Store
 *                            shows each bucket's connection
 *   bucket                   its connection
 *
 * Doctor results come from `GET /api/doctor-jobs` with the host's summary; a
 * doctor pill opens the Doctor panel on that report. A row's Check and Check
 * all queue the cheap diagnoses; full integrity only runs from the panel.
 * Opening the page reads results and launches nothing.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Button, IconInspectOutlineRegular, IconShieldOutlineRegular, IconWarningOutlineRegular, IconWarningTriangleOutlineRegular, StateDot, Tag, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { busyState, DoctorPanel, type DoctorJob, type DoctorRequest, type DoctorTarget } from './Doctor.tsx'
import type { DoctorT } from './locale.ts'
import { ago } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { useQuery, type Query } from '../files/use-query.ts'
import { useMachinesContext } from '../machines/context.tsx'
import type { StorageT } from '../storage/locale.ts'
import { useHostEvents } from '../storage/hooks.ts'
import type { DoctorReport, PgAttachment, StorageView, StoreRow } from '../storage/types.ts'
import { MachinesGlyph, SandboxesGlyph, StoreGlyph } from '../machines/icons.tsx'
import { BucketGlyph } from '../storage/parts.tsx'
import { CopyLine } from '../ui/index.tsx'
import css from './Health.module.css'

type Group = 'host' | 'machines' | 'sandboxes' | 'stores' | 'buckets'

/** One doctor diagnosis: a target and resource. */
interface Probe { target: DoctorTarget, name?: string | undefined }

interface Cell { state: StateDotState, words: string, job: DoctorJob | null, at?: number | null | undefined, title?: string | undefined }

/** One check a resource shows: a doctor diagnosis, or a fact the host already holds. */
type Item =
  | { key: string, label: string, probe: Probe, /** Shown here, counted on its own row. */ mirror?: boolean }
  | { key: string, label: string, live: Cell, /** For findings: what failed and how to fix it. */ problem?: { message: string, fix: string | null } }

interface Row {
  key: string
  group: Group
  label: string
  sub: string
  /** The entity kind LayerFS's findings name. */
  kind: string
  items: Item[]
  /** What Check queues for this row: its cheap diagnoses. */
  checks: DoctorRequest[]
}

const probeKey = (p: Probe) => `${p.target}:${p.name ?? ''}`
const rank: Record<StateDotState, number> = { error: 4, warning: 3, ongoing: 2, done: 1, idle: 0 }
/** A latency in words: whole milliseconds, or under one. */
const msWords = (ms: number, t: DoctorT) => (ms < 1 ? t('healthLiveFast') : t('healthLiveReachableMs', { ms: Math.round(ms) }))
const worstOf = (cells: readonly Cell[]): Cell | null => (cells.length ? cells.reduce((a, b) => (rank[b.state] > rank[a.state] ? b : a)) : null)

/** The newest job for each diagnosis (the host lists newest first). */
function latestJobs(jobs: readonly DoctorJob[] | undefined): Map<string, DoctorJob> {
  const out = new Map<string, DoctorJob>()
  for (const job of jobs ?? []) {
    const key = probeKey({ target: job.request.target, name: job.request.name })
    if (!out.has(key)) out.set(key, job)
  }
  return out
}

function cellOf(job: DoctorJob | undefined, t: DoctorT): Cell {
  if (!job) return { state: 'idle', words: t('healthCellNone'), job: null }
  const at = job.ended ?? null
  if (job.state === 'queued') return { state: 'ongoing', words: t('healthCellQueued'), job }
  if (job.state === 'running') return { state: 'ongoing', words: t('healthCellRunning'), job }
  if (job.state === 'failed') return { state: 'error', words: t('healthCellFailed'), job, at, title: job.error }
  if (job.state === 'interrupted') return { state: 'warning', words: t('healthCellInterrupted'), job, at, title: job.error }
  if (job.state === 'unavailable' || !job.summary) return { state: 'idle', words: t('healthCellUnavailable'), job, at, title: job.error }
  const s = job.summary
  const mode = job.request.target === 'store.integrity' ? ` · ${s.mode === 'quick' ? t('healthModeQuick') : t('healthModeFull')}` : ''
  if (s.errors) return { state: 'error', words: (s.errors === 1 ? t('healthCellIssue') : t('healthCellIssues', { n: s.errors })) + mode, job, at }
  if (s.warnings) return { state: 'warning', words: (s.warnings === 1 ? t('healthCellWarning') : t('healthCellWarnings', { n: s.warnings })) + mode, job, at }
  if (!s.complete) return { state: 'warning', words: t('healthCellIncomplete') + mode, job, at }
  return { state: 'done', words: t('healthCellOk') + mode, job, at }
}

/** Whether the host reaches a PostgreSQL Store now (`GET /api/storage` probes it on every read). */
function liveItem(s: StoreRow, t: DoctorT): Item | null {
  const pg = s.postgresql
  if (!pg || pg.reachable === null) return null
  const live: Cell = pg.reachable
    ? { state: 'done', words: pg.latencyMs != null ? msWords(pg.latencyMs, t) : t('healthLiveReachable'), job: null, title: pg.version ?? undefined }
    : { state: 'error', words: t('healthLiveUnreachable'), job: null, title: pg.error ?? undefined }
  return { key: `${s.name}:live`, label: t('healthItemReachable'), live, ...!pg.reachable ? { problem: { message: pg.error ?? t('healthLiveUnreachable'), fix: null } } : {} }
}

/** One machine's last check of a PostgreSQL Store it is attached to. */
function attachItem(s: StoreRow, a: PgAttachment, t: DoctorT, place: (m: string) => string): Item {
  const checked = a.checked?.at ?? null
  const failed = a.lastError && (checked === null || (a.lastError.at ?? 0) >= checked)
  const live: Cell = failed
    ? { state: 'error', words: t('healthAttachFailed'), job: null, at: a.lastError!.at, title: a.lastError!.message }
    : a.checked
      ? { state: 'done', words: a.checked.latencyMs != null ? msWords(a.checked.latencyMs, t) : t('healthCellOk'), job: null, at: checked, title: a.checked.version ?? undefined }
      : { state: 'idle', words: t('healthCellNone'), job: null }
  return {
    key: `${s.name}:attach:${a.machine}`,
    label: t('healthItemAttached', { machine: place(a.machine) }),
    live,
    ...failed ? { problem: { message: `${place(a.machine)}: ${a.lastError!.message}`, fix: t('healthAttachFix') } } : {},
  }
}

interface MachineRow { name: string, platform: string }

function useMachineRows(): { machines: MachineRow[], sandboxes: { name: string, machine: string | null }[] } {
  const { useMachines } = useMachinesContext()
  const view = useMachines((s) => s).data
  return useMemo(() => view?.available
    ? { machines: view.machines.map((m) => ({ name: m.name, platform: m.platform })), sandboxes: view.sandboxes.map((b) => ({ name: b.name, machine: b.machine })) }
    : { machines: [], sandboxes: [] }, [view])
}

/** The rows: the host, then what the machines view and Storage record, each with only its own checks. */
function rowsOf(t: DoctorT, home: string, machines: ReturnType<typeof useMachineRows>, storage: StorageView | undefined): Row[] {
  const place = (m: string | null | undefined) => (m === 'native' ? home : m ?? '—')
  const rows: Row[] = [{
    key: 'host', group: 'host', label: t('healthHomeRow'), sub: t('healthSubHost'), kind: 'host',
    items: [{ key: 'host', label: t('healthItemHost'), probe: { target: 'host' } }], checks: [{ target: 'host' }],
  }]
  for (const m of [...machines.machines].sort((a, b) => Number(b.name === 'native') - Number(a.name === 'native'))) {
    rows.push({
      key: `m:${m.name}`, group: 'machines', label: place(m.name), sub: t('healthSubMachine', { platform: m.platform }), kind: 'machine',
      items: [{ key: `m:${m.name}`, label: t('healthItemMachine'), probe: { target: 'machine', name: m.name } }], checks: [{ target: 'machine', name: m.name }],
    })
  }
  for (const b of machines.sandboxes) {
    rows.push({
      key: `x:${b.name}`, group: 'sandboxes', label: b.name, sub: t('healthSubSandbox', { machine: place(b.machine) }), kind: 'sandbox',
      items: [{ key: `x:${b.name}`, label: t('healthItemSandbox'), probe: { target: 'sandbox', name: b.name } }], checks: [{ target: 'sandbox', name: b.name }],
    })
  }
  for (const s of storage?.stores ?? []) {
    const pg = s.kind === 'postgresql'
    const live = pg ? liveItem(s, t) : null
    const items: Item[] = [
      ...live ? [live] : [],
      ...pg ? [{ key: `${s.name}:conn`, label: t('healthItemConnection'), probe: { target: 'store.connection' as const, name: s.name } }] : [],
      ...(s.attachments ?? []).map((a) => attachItem(s, a, t, place)),
      { key: `${s.name}:integrity`, label: t('healthItemIntegrity'), probe: { target: 'store.integrity', name: s.name } },
      ...[...new Set(s.links.map((l) => l.bucket))].map((bucket) => ({ key: `${s.name}:backup:${bucket}`, label: t('healthItemBackup', { bucket }), probe: { target: 'backup.connection' as const, name: bucket }, mirror: true })),
    ]
    rows.push({
      key: `s:${s.name}`, group: 'stores', label: s.name, kind: 'store',
      sub: pg ? t('healthSubPg') : t('healthSubSqlite', { machine: place(s.machine) }),
      items,
      checks: [...pg ? [{ target: 'store.connection' as const, name: s.name }] : [], { target: 'store.integrity', name: s.name, quick: true }],
    })
  }
  for (const b of storage?.buckets ?? []) {
    rows.push({
      key: `b:${b.name}`, group: 'buckets', label: b.name, sub: b.provider ? t('healthSubBucketOf', { provider: b.provider }) : t('healthSubBucket'), kind: 'backup',
      items: [{ key: `b:${b.name}`, label: t('healthItemConnection'), probe: { target: 'backup.connection', name: b.name } }], checks: [{ target: 'backup.connection', name: b.name }],
    })
  }
  return rows
}

interface HealthProps {
  api: LayerfsApi
  t: DoctorT
  /** Storage's words, for times ("4 min ago"). */
  ts: StorageT
  storage: StorageView | undefined
  /** The no-target home sweep (`GET /api/doctor`). */
  sweep: Query<DoctorReport>
  onSweep: () => void
  now: number
}

/** The Health page: the hero, the groups, what needs attention, then every resource. */
export function HealthPage(props: HealthProps): ReactNode {
  return <Health {...props} />
}

function Health({ api, t, ts, storage, sweep, onSweep, now }: HealthProps): ReactNode {
  const [tick, setTick] = useState(0)
  const jobs = useQuery(() => api.call<DoctorJob[]>('GET', '/api/doctor-jobs'), [api, tick])
  useHostEvents(api, ['doctor'], () => setTick((n) => n + 1))
  const machines = useMachineRows()
  const rows = useMemo(() => rowsOf(t, ts('groupHome'), machines, storage), [t, ts, machines, storage])
  const latest = useMemo(() => latestJobs(jobs.data), [jobs.data])
  const [panel, setPanel] = useState<{ probe: Probe, job: DoctorJob | null } | null>(null)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cellFor = (item: Item): Cell => ('probe' in item ? cellOf(latest.get(probeKey(item.probe)), t) : item.live)
  const rowCell = (row: Row): Cell | null => worstOf(row.items.map(cellFor))

  const launch = async (requests: readonly DoctorRequest[]) => {
    setLaunching(true)
    setError(null)
    try {
      for (const request of requests) {
        const busy = latest.get(probeKey(request))
        if (busy && busyState(busy.state)) continue
        await api.call<DoctorJob>('POST', '/api/doctor-jobs', { ...request, key: crypto.randomUUID() })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLaunching(false)
      setTick((n) => n + 1)
    }
  }

  // Everything counted once: each row's own items (a Store's bucket pills are counted on the bucket's row).
  const counted = rows.flatMap((row) => row.items.filter((i) => !('probe' in i && i.mirror)).map((item) => ({ row, item, cell: cellFor(item) })))
  const reports = counted.filter((c) => 'probe' in c.item)
  const running = counted.filter((c) => c.cell.state === 'ongoing').length
  const done = reports.filter((r) => r.cell.job?.summary)
  const liveProblems = counted.filter((c) => !('probe' in c.item) && c.cell.state === 'error')
  const sweepFindings = sweep.data?.findings ?? []
  const errors = sweepFindings.filter((f) => f.severity === 'error').length + done.reduce((n, r) => n + r.cell.job!.summary!.errors, 0) + liveProblems.length
  const warnings = sweepFindings.filter((f) => f.severity === 'warning').length + done.reduce((n, r) => n + r.cell.job!.summary!.warnings, 0)
  const incomplete = done.filter((r) => !r.cell.job!.summary!.complete).length
  const unfinished = reports.filter((r) => r.cell.job && (r.cell.job.state === 'failed' || r.cell.job.state === 'interrupted')).length
  const quick = done.filter((r) => 'probe' in r.item && r.item.probe.target === 'store.integrity' && r.cell.job!.summary!.mode === 'quick').length
  const last = Math.max(sweep.data?.at ?? 0, ...reports.map((r) => r.cell.job?.ended ?? 0))
  const never = done.length === 0 && reports.every((r) => !r.cell.job) && !sweep.data
  const sweepFailed = sweep.error !== undefined && !sweep.data
  const tone: StateDotState = running ? 'ongoing' : errors || sweepFailed ? 'error' : warnings || incomplete || unfinished ? 'warning' : never ? 'idle' : 'done'
  const headline = [errors ? (errors === 1 ? t('healthCountError') : t('healthCountErrors', { n: errors })) : null, warnings ? (warnings === 1 ? t('healthCountWarning') : t('healthCountWarnings', { n: warnings })) : null].filter(Boolean).join(', ')

  const ring = { done: 0, warning: 0, error: 0, ongoing: 0, idle: 0 }
  for (const c of counted) ring[c.cell.state]++
  const total = counted.length

  const details: string[] = [
    incomplete ? t('healthNoteIncomplete', { n: incomplete }) : null,
    unfinished ? t('healthNoteUnfinished', { n: unfinished }) : null,
    quick ? t('healthNoteQuick', { n: quick }) : null,
    sweepFailed ? t('healthNoteSweepFailed') : null,
  ].filter((x): x is string => !!x)
  if (ring.idle && (errors || warnings || unfinished || incomplete || sweepFailed) && !never) details.push(t('healthGroupNone', { n: ring.idle }))
  const heroTitle = running ? t('healthHeroChecking')
    : errors ? (errors === 1 ? t('healthHeroError') : t('healthHeroErrors', { n: errors }))
      : never ? t('healthHeroNever')
        : warnings || unfinished || incomplete || sweepFailed ? t('healthHeroMostly')
          : ring.idle ? t('healthHeroSoFar') : t('healthHeroHealthy')
  const heroLine = running ? t('healthChecking', { n: running })
    : never ? t('healthNeverNote')
      : errors || warnings ? headline
        : unfinished || incomplete || sweepFailed ? t('healthCleanPartial')
          : ring.idle ? t('healthHeroSoFarLine', { n: ring.idle }) : t('healthHeroHealthyLine')

  const groups: { group: Group, label: string, icon: ReactNode }[] = [
    { group: 'host', label: t('healthGroupHost'), icon: <IconShieldOutlineRegular size={18} /> },
    { group: 'machines', label: t('healthGroupMachines'), icon: <MachinesGlyph size={18} /> },
    { group: 'sandboxes', label: t('healthGroupSandboxes'), icon: <SandboxesGlyph size={18} /> },
    { group: 'stores', label: t('healthGroupStores'), icon: <StoreGlyph size={18} /> },
    { group: 'buckets', label: t('healthGroupBuckets'), icon: <BucketGlyph size={18} /> },
  ]

  // Findings: errors first; the home sweep's, each report's and the host's own PostgreSQL facts, in LayerFS's words.
  const findings = [
    ...sweepFindings.map((f) => ({ severity: f.severity, entity: f.entity ? `${f.entity.kind} · ${f.entity.name}` : null, message: f.message, fix: f.fix, source: t('healthSourceSweep') as string | null })),
    ...done.flatMap((r) => r.cell.job!.summary!.findings.map((f) => ({ ...f, entity: `${r.row.kind} · ${r.row.label}`, source: 'probe' in r.item && r.item.probe.target.includes('.') ? r.item.probe.target : null }))),
    ...liveProblems.map((c) => ({ severity: 'error' as const, entity: `${c.row.kind} · ${c.row.label}`, message: 'problem' in c.item && c.item.problem ? c.item.problem.message : c.cell.words, fix: 'problem' in c.item && c.item.problem ? c.item.problem.fix : null, source: c.item.label })),
  ].sort((a, b) => Number(a.severity !== 'error') - Number(b.severity !== 'error'))

  const all = rows.flatMap((r) => r.checks)
  const legend: { state: StateDotState, n: number, label: string }[] = [
    { state: 'done', n: ring.done, label: t('healthLegendOk') },
    { state: 'warning', n: ring.warning, label: t('healthLegendWarning') },
    { state: 'error', n: ring.error, label: t('healthLegendError') },
    ...ring.ongoing ? [{ state: 'ongoing' as const, n: ring.ongoing, label: t('healthLegendRunning') }] : [],
    { state: 'idle', n: ring.idle, label: t('healthLegendNone') },
  ]
  const jump = (group: Group) => document.getElementById(`layerfs-health-${group}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <div className={css.health}>
      {/* ---------- hero ---------- */}
      <section className={css.hero} data-tone={tone} aria-label={t('healthTitle')}>
        <Ring parts={ring} total={total} label={t('healthRingLabel')} />
        <div className={css.heroText}>
          <span className={css.eyebrow}><IconShieldOutlineRegular size={13} />{t('healthEyebrow')}</span>
          <h1 className={css.heroTitle} role="status">{heroTitle}</h1>
          <p className={css.heroLine}>{heroLine}</p>
          {details.length ? <p className={css.heroDetails}>{details.join(' · ')}</p> : null}
          <div className={css.heroActions}>
            <Button variant="primary" icon={<IconInspectOutlineRegular size={14} />} disabled={launching} aria-busy={launching}
              onClick={() => { onSweep(); void launch(all) }}>{t('healthCheckAll')}</Button>
            {last ? <span className={css.heroMeta}>{t('healthLastChecked', { ago: ago(last, now, ts as Translate) })}</span> : null}
          </div>
          <ul className={css.legend} aria-label={t('healthRingLabel')}>
            {legend.map((l) => (
              <li key={l.state} data-state={l.state}><i aria-hidden="true" /><strong>{l.n}</strong>{l.label}</li>
            ))}
          </ul>
        </div>
      </section>
      {error ? <p className={css.error} role="alert">{error}</p> : null}

      {/* ---------- groups ---------- */}
      <div className={css.groups}>
        {groups.map(({ group, label, icon }) => {
          const members = rows.filter((r) => r.group === group)
          if (!members.length) return null
          const cells = members.map((r) => ({ row: r, cell: rowCell(r) }))
          const states = cells.map((c) => c.cell?.state ?? 'idle')
          const ok = states.filter((x) => x === 'done').length
          const bad = states.filter((x) => x === 'error').length
          const warn = states.filter((x) => x === 'warning').length
          const none = states.filter((x) => x === 'idle').length
          const worstState = states.reduce((a, b) => (rank[b] > rank[a] ? b : a), 'idle' as StateDotState)
          const note = bad ? t('healthGroupBad', { n: bad }) : warn ? t('healthGroupWarn', { n: warn }) : none ? t('healthGroupNone', { n: none }) : t('healthGroupOk')
          return (
            <button key={group} type="button" className={css.groupCard} data-tone={worstState} onClick={() => jump(group)}
              aria-label={`${label}: ${ok}/${members.length} · ${note}`}>
              <span className={css.groupTop}>
                <span className={css.groupIcon} aria-hidden="true">{icon}</span>
                <span className={css.groupLabel}>{label}</span>
              </span>
              <span className={css.groupCount}>{ok}<span>/{members.length}</span></span>
              <span className={css.strip} aria-hidden="true">
                {cells.map(({ row, cell: c }) => <i key={row.key} data-state={c?.state ?? 'idle'} title={`${row.label} · ${c?.words ?? '—'}`} />)}
              </span>
              <span className={css.groupNote}>{note}</span>
            </button>
          )
        })}
      </div>

      {/* ---------- needs attention ---------- */}
      {findings.length ? (
        <section className={css.block} aria-label={t('healthFindings')}>
          <div className={css.blockHead}>
            <h2 className={css.blockTitle}>{t('healthFindings')}</h2>
            <span className={css.blockCount}>{findings.length}</span>
          </div>
          <ul className={css.findings}>
            {findings.map((f, i) => (
              <li key={i} className={css.finding} data-severity={f.severity}>
                <span className={css.findingIcon} aria-hidden="true">
                  {f.severity === 'error' ? <IconWarningOutlineRegular size={16} /> : <IconWarningTriangleOutlineRegular size={16} />}
                </span>
                <div className={css.findingBody}>
                  <span className={css.findingTop}>
                    <Tag tone={f.severity === 'error' ? 'danger' : 'warning'}>{f.severity === 'error' ? t('healthSeverityError') : t('healthSeverityWarning')}</Tag>
                    {f.entity ? <span className={css.entity}>{f.entity}</span> : null}
                    {f.source ? <span className={css.source}>{f.source}</span> : null}
                  </span>
                  <span className={css.message}>{f.message}</span>
                  {f.fix ? (/^layerfs\s/.test(f.fix)
                    ? <CopyLine text={f.fix} copyLabel={t('healthCopy')} copiedLabel={t('healthCopied')} />
                    : <span className={css.fix}>{f.fix}</span>) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---------- every resource ---------- */}
      <section className={css.block} aria-label={t('healthAllTitle')}>
        <div className={css.blockHead}>
          <h2 className={css.blockTitle}>{t('healthAllTitle')}</h2>
        </div>
        <div className={css.lists}>
          {groups.map(({ group, label, icon }) => {
            const members = rows.filter((r) => r.group === group)
            if (!members.length) return null
            return (
              <div key={group} id={`layerfs-health-${group}`} className={css.list}>
                <div className={css.listHead}>
                  <span className={css.listIcon} aria-hidden="true">{icon}</span>
                  <span>{label}</span>
                  <span className={css.listCount}>{members.length}</span>
                </div>
                <ul className={css.resources}>
                  {members.map((row) => {
                    const verdict = rowCell(row)
                    return (
                      <li key={row.key} className={css.resource}>
                        <span className={css.resourceDot}><StateDot state={verdict?.state ?? 'idle'} size={verdict?.state === 'ongoing' ? 12 : 8} /></span>
                        <div className={css.resourceName}>
                          <span className={css.resourceLabel} title={row.label}>{row.label}</span>
                          <span className={css.resourceSub}>{row.sub}</span>
                        </div>
                        <div className={css.pills}>
                          {row.items.map((item) => {
                            const c = cellFor(item)
                            const when = c.at && c.state !== 'ongoing' ? ago(c.at, now, ts as Translate) : null
                            const body = (
                              <>
                                <StateDot state={c.state} size={c.state === 'ongoing' ? 11 : 7} />
                                <span className={css.pillLabel}>{item.label}</span>
                                <span className={css.pillWords}>{c.words}</span>
                                {when ? <span className={css.pillWhen}>{when}</span> : null}
                              </>
                            )
                            return 'probe' in item ? (
                              <button key={item.key} type="button" className={css.pill} data-state={c.state}
                                title={c.title ?? t('healthOpenReport', { column: item.label, name: row.label })}
                                onClick={() => setPanel({ probe: item.probe, job: c.job })}>{body}</button>
                            ) : (
                              <span key={item.key} className={css.pill} data-state={c.state} data-static title={c.title}>{body}</span>
                            )
                          })}
                        </div>
                        <Button variant="ghost" size="sm" className={css.resourceCheck} disabled={launching} aria-label={t('healthCheckRow', { name: row.label })}
                          onClick={() => void launch(row.checks)}>{t('healthCheck')}</Button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </div>
      </section>

      {panel ? <DoctorPanel api={api} t={t} target={panel.probe.target} name={panel.probe.name} initial={panel.job ?? undefined}
        onClose={() => { setPanel(null); setTick((n) => n + 1) }} /> : null}
    </div>
  )
}

/**
 * The hero's ring: every check as an arc of its verdict (errors, then
 * warnings, running and passing; not yet checked is the bare track), with the
 * passing count in the middle.
 */
function Ring({ parts, total, label }: { parts: Record<StateDotState, number>, total: number, label: string }): ReactNode {
  const r = 52
  const c = 2 * Math.PI * r
  const gap = total > 1 ? 3 : 0
  let at = 0
  const arcs = (['error', 'warning', 'ongoing', 'done'] as const).filter((k) => parts[k] > 0).map((k) => {
    const len = (parts[k] / Math.max(1, total)) * c
    const arc = { k, dash: `${Math.max(0, len - gap)} ${c}`, offset: -at }
    at += len
    return arc
  })
  return (
    <div className={css.ring} role="img" aria-label={`${label}: ${parts.done}/${total}`}>
      <svg viewBox="0 0 128 128" width="136" height="136" aria-hidden="true">
        <circle className={css.ringTrack} cx="64" cy="64" r={r} />
        {arcs.map((a) => (
          <circle key={a.k} className={css.ringArc} data-state={a.k} cx="64" cy="64" r={r}
            strokeDasharray={a.dash} strokeDashoffset={a.offset} transform="rotate(-90 64 64)" />
        ))}
      </svg>
      <span className={css.ringCenter}>
        <span className={css.ringValue}>{parts.done}<span>/{total}</span></span>
        <span className={css.ringLabel}>{label}</span>
      </span>
    </div>
  )
}
