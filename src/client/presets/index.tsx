/**
 * Presets area of dsh-layerfs: LayerFS Connect's Presets (sample project
 * libraries built into this LayerFS home, their CLI script, Build and Reset).
 * It has no page or sidebar row of its own: `PresetsDialog` opens from the
 * LayerFS home, and this registers its copy.
 */
import { locales, NS } from './locale.ts'

export { PresetsDialog } from './PresetsDialog.tsx'
export { NS as PRESETS_NS } from './locale.ts'
export type { PresetsT } from './locale.ts'

/**
 * Register the Presets copy the Presets dialog reads.
 * @param ctx - the plugin's client context (locale).
 */
export function registerPresets(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: presets locale')
}
