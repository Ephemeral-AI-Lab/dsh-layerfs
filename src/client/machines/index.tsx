/**
 * Machines area of dsh-layerfs: the sidebar's Machines entry and the page it
 * opens in DSH's main column (LayerFS Connect's Machines, restyled for DSH).
 * Registered the way DSH's own Plugins page is: a `sidebar.panellist` entry
 * and a `main` keyed page under the same panel id, each through
 * `ctx.slots.inject` inside an effect, with the page's data and callbacks in
 * its registration `inject` (one controller per registration).
 */
import type { ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { NS as DOCTOR_NS } from '../doctor/locale.ts'
import { ChildGlyph } from '../overview/child.tsx'
import type { SidebarGroup } from '../overview/group.ts'
import type { Translate } from './context.tsx'
import { MachinesController, type MachinesFace } from './controller.ts'
import { MachinesGlyph } from './icons.tsx'
import { NS, locales } from './locale.ts'
import { MachinesPage } from './MachinesPage.tsx'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'layerfs-machines'

/** The sidebar entry's icon at the size the sidebar asks for. */
function MachinesPanelIcon({ size }: { size?: number }): ReactNode {
  return <ChildGlyph><MachinesGlyph size={size ?? 16} /></ChildGlyph>
}

/** What the LayerFS page reuses: the controller's face and this namespace's `t`. */
export interface MachinesShare {
  face: MachinesFace
  t: Translate
}

/**
 * Register the Machines page and its sidebar entry.
 * @param ctx - the plugin's client context (slots, locale, layout).
 * @param api - the host API the page reads through.
 * @param group - the LayerFS sidebar group the entry shows under.
 * @param readers - other panel ids whose page reads the controller (the LayerFS page).
 * @returns the controller's face and `t`, for the LayerFS page.
 */
export function registerMachines(ctx: any, api: LayerfsApi, group: SidebarGroup, readers: readonly string[]): MachinesShare {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: machines locale')
  const t = ctx.locale.bind(NS)
  const doctorT = ctx.locale.bind(DOCTOR_NS)
  // Polls only while a page that reads it is the main column's page.
  const shown = (): boolean => {
    const id = ctx.layout?.panelInfo?.getSnapshot?.().activePanelId
    return id === PANEL_ID || readers.includes(id)
  }
  const controller = new MachinesController(api, shown)
  ctx.effect(() => () => controller.dispose(), 'dsh-layerfs: machines controller')
  ctx.effect(() => {
    let was = shown()
    return ctx.layout?.panelInfo?.subscribe?.(() => {
      const now = shown()
      if (now && !was) controller.reload()
      was = now
    }) ?? (() => {})
  }, 'dsh-layerfs: machines panel focus')
  const face = controller.face()
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ ...face, api, doctorT }),
  }, MachinesPage)), 'dsh-layerfs: machines page')
  ctx.effect(() => group.whileExpanded(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 8,
    label: () => t('panel'),
    locale: NS,
  }, MachinesPanelIcon))), 'dsh-layerfs: machines sidebar entry')
  return { face, t }
}
