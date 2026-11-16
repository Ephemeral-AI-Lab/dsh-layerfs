/**
 * The machine page's tabs past the head (MachineDetail.tsx picks the tab;
 * machine-tabs.ts holds the pure parts):
 *
 * - Overview: what needs you on this machine (the disk getting full, gone
 *   Sandboxes still on disk, Sandboxes that need you), each with a link to the
 *   tab that fixes it, and its Sandboxes and Stores in a line.
 * - Sandboxes: one card per Sandbox (SandboxCards.tsx).
 * - Stores: every Store its Sandboxes can use, with Add Store.
 * - Usage: processor, memory and disk over the hour (machine.stats).
 * - Disk: where the data disk goes (machine.space).
 *
 * A column whose call the pinned CLI lacks is not drawn; a value LayerFS did
 * not read is a dash with why, never 0.
 */
import { type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, LinkButton, Notice } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { StoreSection, sandboxNeedsYou, storeLines } from './Inventory.tsx'
import { useMetrics } from './MachineStats.tsx'
import { sandboxAttention, type MachineTab } from './machine-tabs.ts'
import { MachineCharts } from './MetricsViews.tsx'
import { sandboxesOn, type AvailableView, type MachineInfo } from './model.ts'
import { spaceSize } from './space.ts'
import { DiskNotice, WhereSpaceGoes, useMachineSpace } from './SpaceViews.tsx'
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

// SandboxesTab: SandboxCards.tsx

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
