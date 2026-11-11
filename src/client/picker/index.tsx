/**
 * Picker area of dsh-layerfs: the locale namespace shared by the project
 * creation form (`NewProjectForm`), used by the New Session project control
 * and the Projects page. Add-workspace flows are stock DSH again: the
 * `directory-picker` row fills ui-workspace's directory-flow holes and picks
 * a host folder.
 */
import type { LayerfsApi } from '../api.ts'
import { NS, locales } from './locale.ts'

export function registerPicker(ctx: any, _api: LayerfsApi): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: picker locale')
}
