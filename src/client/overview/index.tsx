/**
 * LayerFS area of dsh-layerfs: the sidebar's LayerFS row and the page it
 * opens (the runtime, doctor, and a card each for Machines and Storage). The
 * page reuses the Machines controller's face for the runtime and machines.
 * Clicking the row folds or unfolds the rows under it; its Open page control
 * (and Enter on the row) opens the page.
 */
import type { MouseEvent, ReactNode } from 'react'
import { IconChevronRightOutlineRegular, IconRightUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { NS as DOCTOR_NS } from '../doctor/locale.ts'
import type { MachinesShare } from '../machines/index.tsx'
import { NS as STORAGE_NS } from '../storage/locale.ts'
import { LayerfsGlyph } from './glyph.tsx'
import type { SidebarGroup } from './group.ts'
import { NS, locales, type OverviewT } from './locale.ts'
import { OverviewPage } from './OverviewPage.tsx'
import css from './sidebar.module.css'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'layerfs'

/** The row's icon with its fold and Open page controls. */
function GroupIcon({ size, t, useUnfolded, toggle, open }: {
  size?: number
  t: OverviewT
  useUnfolded: <S>(selector: (unfolded: boolean) => S) => S
  toggle: () => void
  open: () => void
}): ReactNode {
  const unfolded = useUnfolded((v) => v)
  const fold = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); toggle() }
  const label = t(unfolded ? 'fold' : 'unfold')
  return (
    <span className={css.group}>
      <LayerfsGlyph size={size ?? 16} />
      <span className={css.hit} onClick={fold} title={label} />
      <span className={css.controls}>
        <span className={css.open} title={t('openPage')} onClick={(e) => { e.preventDefault(); e.stopPropagation(); open() }}>
          <IconRightUpOutlineRegular size={13} />
        </span>
        <span className={css.fold} data-unfolded={unfolded || undefined} title={label} onClick={fold}>
          <IconChevronRightOutlineRegular size={12} />
        </span>
      </span>
    </span>
  )
}

/**
 * Register the LayerFS page and its sidebar row.
 * @param ctx - the plugin's client context (slots, locale, layout).
 * @param api - the host API the page reads through.
 * @param machines - the Machines controller's face and `t`.
 * @param group - the fold the row toggles.
 */
export function registerOverview(ctx: any, api: LayerfsApi, machines: MachinesShare, group: SidebarGroup): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: overview locale')
  const doctorT = ctx.locale.bind(DOCTOR_NS)
  const t = ctx.locale.bind(NS)
  const ts = ctx.locale.bind(STORAGE_NS)
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ ...machines.face, tm: machines.t, ts, api, doctorT }),
  }, OverviewPage)), 'dsh-layerfs: overview page')
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 7.5,
    label: () => t('panel'),
    locale: NS,
    inject: () => ({ toggle: () => group.toggle(), open: () => api.openPanel(PANEL_ID), hooks: { unfolded: group.unfolded } }),
  }, GroupIcon)), 'dsh-layerfs: overview sidebar entry')
}
