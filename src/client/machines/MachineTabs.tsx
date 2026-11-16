/**
 * The machine page's tabs past the head (MachineDetail.tsx picks the tab;
 * machine-tabs.ts holds the pure parts):
 *
 * - Overview: what needs you on this machine (the disk getting full, gone
 *   Sandboxes still on disk, Sandboxes that need you), each with a link to the
 *   tab that fixes it (the rest of the Overview is Overview.tsx).
 * - Sandboxes: one card per Sandbox (SandboxCards.tsx).
 * - Stores: every Store its Sandboxes can use, with Add Store.
 *
 * A column whose call the pinned CLI lacks is not drawn; a value LayerFS did
 * not read is a dash with why, never 0.
 */
import { type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, LinkButton, Notice } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { StoreSection, sandboxNeedsYou } from './Inventory.tsx'
import { sandboxAttention, type MachineTab } from './machine-tabs.ts'
import { sandboxesOn, type AvailableView, type MachineInfo } from './model.ts'
import { spaceSize } from './space.ts'
import { DiskNotice, useMachineSpace } from './SpaceViews.tsx'

// ---------------------------------------------------------------- Overview

/**
 * The Overview's notices past the machine's own: the disk getting full
 * (machine.stats), gone Sandboxes still on disk with what they hold
 * (machine.space, when offered), and Sandboxes that need you, each linking to
 * the tab that shows them; the disk notice opens where the disk goes
 * (`onDisk`). Nothing when nothing needs you.
 */
export function OverviewAttention({ m, view, onTab, onDisk }: { m: MachineInfo, view: AvailableView, onTab: (tab: MachineTab) => void, onDisk?: (() => void) | null | undefined }): ReactNode {
  const { t } = useMachinesContext()
  const records = sandboxesOn(view, m)
  const { read } = useMachineSpace(m)
  const a = sandboxAttention(records, read.data?.space?.sandboxes ?? null, sandboxNeedsYou)
  return (
    <>
      <DiskNotice m={m} action={onDisk ? <LinkButton onClick={onDisk}>{t('ovWhereItGoes')}</LinkButton> : undefined} />
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

// ---------------------------------------------------------------- Sandboxes

// SandboxesTab: SandboxCards.tsx

// ---------------------------------------------------------------- Stores

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
