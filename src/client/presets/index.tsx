/**
 * Presets area of dsh-layerfs: LayerFS Connect's Presets (the Studio project
 * library built into this LayerFS home, its CLI script, Build and Reset). It
 * has no page or sidebar row of its own: `PresetsSection` renders on the
 * LayerFS Settings page, and this registers its copy.
 */
import { locales, NS } from './locale.ts'

export { PresetsSection } from './PresetsSection.tsx'
export { NS as PRESETS_NS } from './locale.ts'
export type { PresetsT } from './locale.ts'

/** A sidebar fold the entry can live under (keeps a registration alive while expanded). */
export interface SidebarFold {
  whileExpanded(register: () => () => void): () => void
}

/**
 * Register the Presets copy the Settings page's Presets section reads.
 * @param ctx - the plugin's client context (locale).
 */
export function registerPresets(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: presets locale')
}
