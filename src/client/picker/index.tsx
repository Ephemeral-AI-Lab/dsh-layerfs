/**
 * Picker area of dsh-layerfs: occupies ui-workspace's two directory-flow holes
 * (sidebar "Add workspace" and the new-conversation workspace menu) with the
 * LayerFS project picker. The bundle patch disables DSH's host folder picker,
 * so a workspace is always a LayerFS project (or Scratch).
 */
import type { LayerfsApi } from '../api.ts'
import { NS, locales } from './locale.ts'
import { ProjectPicker } from './ProjectPicker.tsx'

const HOLES = ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow'] as const

export function registerPicker(ctx: any, api: LayerfsApi): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: picker locale')
  const t = ctx.locale.bind(NS)
  const inject = () => ({ api, t })
  for (const hole of HOLES) {
    ctx.effect(() => ctx.slots.inject(hole, () => ctx.slots.register({ name: hole, locale: NS, inject }, ProjectPicker)), `dsh-layerfs: ${hole}`)
  }
}
