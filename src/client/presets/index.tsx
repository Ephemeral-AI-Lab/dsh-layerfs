/**
 * Presets area of dsh-layerfs: the sidebar's Presets entry and the page it
 * opens in the main column (LayerFS Connect's Presets: the Studio project
 * library built into this LayerFS home, its CLI script, Build and Reset).
 */
import type { ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { ChildGlyph } from '../overview/child.tsx'
import { locales, NS, type PresetsT } from './locale.ts'
import { PresetsPage } from './PresetsPage.tsx'

/** A sidebar fold the entry can live under (keeps a registration alive while expanded). */
export interface SidebarFold {
  whileExpanded(register: () => () => void): () => void
}

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'layerfs-presets'

/** The sidebar entry's glyph: three stacked layers, drawn in currentColor. */
export function PresetsPanelIcon({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.25 14 5.5 8 8.75 2 5.5Z" />
      <path d="M2 8.25 8 11.5l6-3.25" />
      <path d="M2 11 8 14.25 14 11" />
    </svg>
  )
}

function PresetsMain(props: { api: LayerfsApi, t: PresetsT }): ReactNode {
  return <PresetsPage api={props.api} t={props.t} />
}

/**
 * Register the Presets page and its sidebar entry.
 * @param ctx - the plugin's client context (slots, locale).
 * @param api - the host API the page reads through.
 * @param group - the LayerFS sidebar group the entry folds under, if any.
 */
export function registerPresets(ctx: any, api: LayerfsApi, group?: SidebarFold): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: presets locale')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ api }),
  }, PresetsMain)), 'dsh-layerfs: presets page')
  const entry = () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 9.5,
    label: () => t('panel'),
    locale: NS,
  }, group ? PresetsChildIcon : PresetsPanelIcon))
  ctx.effect(() => group ? group.whileExpanded(entry) : entry(), 'dsh-layerfs: presets entry')
}

function PresetsChildIcon({ size }: { size?: number }): ReactNode {
  return <ChildGlyph><PresetsPanelIcon size={size ?? 16} /></ChildGlyph>
}
