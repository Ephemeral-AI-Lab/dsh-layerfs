/**
 * Machines area of dsh-layerfs: the Machines controller (the machines view,
 * startups and the pinned runtime) shared by the pages that read it. Machines
 * have no page of their own: the Storage explorer lists them (by type, each
 * with its Stores and Sandboxes) and opens a machine or a Sandbox as an editor
 * tab, and the LayerFS page shows the runtime and the facts.
 */
import type { LayerfsApi } from '../api.ts'
import type { Translate } from './context.tsx'
import { MachinesController, type MachinesFace } from './controller.ts'
import { NS, locales } from './locale.ts'

/** What the reading pages take: the controller's face and this namespace's `t`. */
export interface MachinesShare {
  face: MachinesFace
  t: Translate
}

/**
 * Register the Machines controller.
 * @param ctx - the plugin's client context (locale, layout).
 * @param api - the host API the controller reads through.
 * @param readers - the panel ids whose page reads the controller (LayerFS, Storage).
 * @returns the controller's face and `t`, for those pages.
 */
export function registerMachines(ctx: any, api: LayerfsApi, readers: readonly string[]): MachinesShare {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: machines locale')
  const t = ctx.locale.bind(NS)
  // Polls only while a page that reads it is the main column's page.
  const shown = (): boolean => readers.includes(ctx.layout?.panelInfo?.getSnapshot?.().activePanelId)
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
  return { face: controller.face(), t }
}
