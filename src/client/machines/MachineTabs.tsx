/**
 * The machine page's tabs past the head (MachineDetail.tsx picks the tab;
 * machine-tabs.ts holds the pure parts):
 *
 * - Overview: what needs you on this machine (the disk getting full, gone
 *   Sandboxes still on disk, Sandboxes that need you), each with a link to the
 *   tab that fixes it, and its Sandboxes and Stores in a line.
 * - Sandboxes: one row per Sandbox with its state, processor, memory, disk and
 *   up time; gone ones offer Close; those closed within the sampler's hour only
 *   on request. New Sandbox and the machine's Sandbox images sit here.
 * - Stores: every Store its Sandboxes can use, with Add Store.
 * - Usage: processor, memory and disk over the hour (machine.stats).
 * - Disk: where the data disk goes (machine.space).
 *
 * A column whose call the pinned CLI lacks is not drawn; a value LayerFS did
 * not read is a dash with why, never 0.
 */
import { useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconPlusOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, LinkButton, Notice, StateChip, refusalOf } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { SandboxGlyph } from './icons.tsx'
import { creatingOn } from './images.ts'
import { CreatingRow, StoreSection, lookOf, sandboxNeedsYou, storeLines } from './Inventory.tsx'
import { ImagesSection } from './MachineImages.tsx'
import { useMetrics } from './MachineStats.tsx'
import { sandboxAttention, sandboxTabRows, type MachineTab } from './machine-tabs.ts'
import { processors, sandboxTable, upTime } from './metrics.ts'
import { Dash, MachineCharts, useWords } from './MetricsViews.tsx'
import { gib, machineState, opWords, projectRef, sandboxesOn, shortSandbox, type AvailableView, type MachineInfo } from './model.ts'
import { useClose } from './Sandboxes.tsx'
import { sandboxSpaceReason, spaceSize } from './space.ts'
import { DiskNotice, WhereSpaceGoes, useMachineSpace } from './SpaceViews.tsx'
import { liveNote } from './stats.ts'
import css from './machines.module.css'

// ---------------------------------------------------------------- Overview

/**
 * The Overview's notices past the machine's own: the disk getting full
 * (machine.stats), gone Sandboxes still on disk with what they hold
 * (machine.space, when offered), and Sandboxes that need you, each linking to
 * the tab that shows them. Nothing when nothing needs you.
 */
export function OverviewAttention({ m, view, onTab }: { m: MachineInfo, view: AvailableView, onTab: (tab: MachineTab) => void }): ReactNode {
  const { t } = useMachinesContext()
  const records = sandboxesOn(view, m)
  const { read } = useMachineSpace(m)
  const a = sandboxAttention(records, read.data?.space?.sandboxes ?? null, sandboxNeedsYou)
  return (
    <>
      <DiskNotice m={m} />
      {a.gone > 0 && (
        <Notice tone="warning" role="status">
          <p data-attention="gone">
            {a.goneBytes != null
              ? t(a.gone === 1 ? 'goneOnDiskOne' : 'goneOnDisk', { n: String(a.gone), size: spaceSize(a.goneBytes) })
              : t(a.gone === 1 ? 'goneRecordedOne' : 'goneRecorded', { n: String(a.gone) })}
            {' '}<LinkButton onClick={() => onTab('sandboxes')}>{t('showSandboxes')}</LinkButton>
          </p>
        </Notice>
      )}
      {a.needsYou > 0 && (
        <Notice tone="warning" role="status">
          <p data-attention="sandboxes">
            {t(a.needsYou === 1 ? 'sandboxNeedsYouOne' : 'sandboxesNeedYou', { n: String(a.needsYou) })}
            {' '}<LinkButton onClick={() => onTab('sandboxes')}>{t('showSandboxes')}</LinkButton>
          </p>
        </Notice>
      )}
    </>
  )
}

/** The Overview's line of Sandboxes (running, gone) and Stores, each opening its tab. */
export function OverviewCounts({ m, view, onTab }: { m: MachineInfo, view: AvailableView, onTab: (tab: MachineTab) => void }): ReactNode {
  const { t } = useMachinesContext()
  const records = sandboxesOn(view, m)
  const running = records.filter((b) => b.state === 'running').length
  const gone = records.filter((b) => b.state === 'gone').length
  const stores = storeLines(view, m).length
  return (
    <dl className={css.factRow} aria-label={t('machineContents')} data-overview-counts>
      <div>
        <dt>{t('sandboxes')}</dt>
        <dd><LinkButton onClick={() => onTab('sandboxes')}>
          {[t(records.length === 1 ? 'countSandboxOne' : 'countSandboxes', { n: String(records.length) }),
            records.length ? t('countRunning', { n: String(running) }) : null,
            gone ? t('countGone', { n: String(gone) }) : null].filter(Boolean).join(' · ')}
        </LinkButton></dd>
      </div>
      <div>
        <dt>{t('stores')}</dt>
        <dd><LinkButton onClick={() => onTab('stores')}>{t(stores === 1 ? 'countStoreOne' : 'countStores', { n: String(stores) })}</LinkButton></dd>
      </div>
    </dl>
  )
}

// ---------------------------------------------------------------- Sandboxes

/** A gone Sandbox's Close: sandbox.close, which removes its record and run folder (a gone Sandbox has no daemon to stop). */
function CloseGone({ name }: { name: string }): ReactNode {
  const { t } = useMachinesContext()
  const { busy, error, close } = useClose(name)
  return (
    <span className={css.sbAction}>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void close(false)} data-close-gone={name}>{t('closeGone')}</Button>
      {error != null && <span className={css.creatingFailed} role="alert" title={refusalOf(error).message}>{refusalOf(error).code}</span>}
    </span>
  )
}

/**
 * The Sandboxes tab: one row per Sandbox (those that need you first), with
 * its project, state, processor and memory (machine.stats), disk (machine.space)
 * and up time; Sandboxes being created above; closed ones behind a switch.
 */
export function SandboxesTab({ m, view, canCreate, onCreate }: { m: MachineInfo, view: AvailableView, canCreate: boolean, onCreate: () => void }): ReactNode {
  const { t, tw, go, stateWord, useCreations } = useMachinesContext()
  const w = useWords()
  const [showClosed, setShowClosed] = useState(false)
  const records = sandboxesOn(view, m)
  const metrics = useMetrics(m.name)
  const space = useMachineSpace(m)
  const table = useMemo(() => (metrics.offered ? sandboxTable(metrics.snapshot, m.name) : []), [metrics.offered, metrics.snapshot, m.name])
  const spaceRows = space.offered ? space.read.data?.space?.sandboxes ?? null : null
  const { rows, closed } = sandboxTabRows(records, table, spaceRows, sandboxNeedsYou, showClosed)
  const creations = useCreations((all) => all)
  const creating = creatingOn(creations, m.name, records)
  const cpus = metrics.snapshot.machines[m.name]?.latest?.stats.resources.cpus ?? null
  const now = metrics.snapshot.now ?? Date.now()
  const running = machineState(m, view.status[m.name]).key === 'running'
  const empty = view.readErrors?.sandboxes ? t('sandboxesUnread') : running ? t('noSandboxesHere')
    : t(m.platform === 'docker' ? 'sandboxesAfterWorker' : 'sandboxesAfterStart', { name: m.platform === 'native' ? t('homeName') : m.name })
  return (
    <div className={css.tabStack} data-machine-sandboxes={m.name}>
      <div className={css.tabToolbar}>
        <span className={css.muted}>{t(records.length === 1 ? 'countSandboxOne' : 'countSandboxes', { n: String(records.length) })}</span>
        {closed > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setShowClosed(!showClosed)} aria-pressed={showClosed} data-show-closed={showClosed || undefined}>
            {t(showClosed ? 'hideClosed' : 'showClosed', { n: String(closed) })}
          </Button>
        )}
        <span className={css.columnSpacer} />
        <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} disabled={!canCreate}
          title={canCreate ? undefined : t('sandboxAfterPower')} onClick={onCreate}>
          {t('newSandbox')}
        </Button>
      </div>
      {creating.length > 0 && <ul className={css.lines} aria-label={t('creatingSandboxes')}>{creating.map((c) => <CreatingRow key={c.id} c={c} showProject />)}</ul>}
      {rows.length === 0 && creating.length === 0
        ? <p className={css.inventoryEmpty}>{empty}</p>
        : rows.length > 0 && (
          <Card className={css.tableCard}>
            <table className={clsx(css.rows, css.sbTable)} aria-label={t('sandboxesOnMachine', { name: m.name })}>
              <thead>
                <tr>
                  <th className={css.mxName}>{t('mxSandbox')}</th>
                  <th>{t('sbColProject')}</th>
                  <th>{t('sbColState')}</th>
                  {metrics.offered && <th>{t('mxProcessor')}</th>}
                  {metrics.offered && <th>{t('memory')}</th>}
                  {space.offered && <th>{t('spaceColTotal')}</th>}
                  {metrics.offered && <th>{t('mxUpTime')}</th>}
                  <th className={css.sbActionCol} aria-label={t('actions')} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const b = r.record
                  const look = b ? lookOf(b) : null
                  const note = b ? liveNote(b, tw) : null
                  const mx = r.metrics
                  const u = mx?.row?.usage
                  const why = mx?.gap ?? mx?.row?.usageReason ?? mx?.row?.liveReason
                  const gone = b?.state === 'gone'
                  const dot = !b ? 'idle' : sandboxNeedsYou(b) ? 'error' : b.state === 'running' ? 'done' : 'idle'
                  const spaceWhy = r.space && r.space.bytes == null ? sandboxSpaceReason(r.space.reason) : null
                  return (
                    <tr key={r.name} data-sb-row={r.name} data-sb-closed={!b || undefined} data-tone={b && sandboxNeedsYou(b) ? 'warning' : undefined}>
                      <td className={css.mxName}>
                        <button type="button" className={css.mxRowName} onClick={() => go({ kind: 'sandbox', machine: m.name, name: r.name })} title={r.name}>
                          <StateDot state={dot} size={6} />
                          <SandboxGlyph size={13} />
                          <span className={css.mono}>{shortSandbox(r.name)}</span>
                        </button>
                      </td>
                      <td className={css.muted}>{b?.project ? projectRef(b.project).name : '—'}</td>
                      <td data-sb-cell="state">
                        {look ? <StateChip tone={look.tone} live={look.live} dashed={look.dashed} label={stateWord(look)} op={opWords(b!.op)} title={note ?? undefined} />
                          : <span className={css.muted}>{t('mxClosed')}</span>}
                      </td>
                      {metrics.offered && (
                        <td data-sb-cell="cpu">{mx?.cpu?.v != null ? (cpus != null ? t('mxProcessorsOf', { n: processors(mx.cpu.v), of: String(cpus) }) : processors(mx.cpu.v)) : mx ? <Dash why={w.gap(mx.cpu?.reason ?? why ?? undefined)} /> : '—'}</td>
                      )}
                      {metrics.offered && <td data-sb-cell="memory">{mx && !mx.gap && u?.memoryCurrent != null ? gib(u.memoryCurrent) : mx ? <Dash why={w.reason(why)} /> : '—'}</td>}
                      {space.offered && (
                        <td data-sb-cell="disk">
                          {r.space?.bytes != null ? (r.space.reason === 'deadline' ? t('spaceAtLeast', { size: spaceSize(r.space.bytes) }) : spaceSize(r.space.bytes))
                            : spaceWhy ? <Dash why={tw(spaceWhy)} /> : '—'}
                        </td>
                      )}
                      {metrics.offered && <td data-sb-cell="up" className={css.muted}>{mx && !mx.gap && mx.row?.startedAt != null && b?.state === 'running' ? upTime(mx.row.startedAt, now) : '—'}</td>}
                      <td className={css.sbActionCol}>{gone && <CloseGone name={r.name} />}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>
        )}
      {/* Stage 1: the images copied to this machine (not macOS native, whose Sandboxes run on the Mac itself) */}
      {view.features?.imageStage === 1 && m.backend !== 'native' && <ImagesSection m={m} />}
    </div>
  )
}

// ---------------------------------------------------------------- Stores, Usage, Disk

/** The Stores tab: the machine's Stores, Add Store in the head when the page has it. */
export function StoresTab({ m, view, onAddStore }: { m: MachineInfo, view: AvailableView, onAddStore?: ((machine: string) => void) | undefined }): ReactNode {
  const { t } = useMachinesContext()
  return (
    <Card>
      <StoreSection m={m} view={view} action={onAddStore ? (
        <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} onClick={() => onAddStore(m.name)}>{t('addStore')}</Button>
      ) : undefined} />
    </Card>
  )
}

/** The Usage tab: processor, memory and disk over the hour. */
export function UsageTab({ m }: { m: MachineInfo }): ReactNode {
  const { t } = useMachinesContext()
  const { snapshot } = useMetrics(m.name)
  return snapshot.loaded ? <MachineCharts m={m} /> : <p className={css.muted}>{t('spaceReading')}</p>
}

/** The Disk tab: the notice while the disk is getting full, then where the disk goes. */
export function DiskTab({ m }: { m: MachineInfo }): ReactNode {
  return (
    <>
      <DiskNotice m={m} />
      <WhereSpaceGoes m={m} />
    </>
  )
}
