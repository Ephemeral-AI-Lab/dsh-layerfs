/**
 * Storage area of dsh-layerfs: the sidebar's Storage entry and the page it
 * opens in the main column (Stores, their projects, backups and moves).
 */
import type { ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { locales, NS, type StorageT } from './locale.ts'
import { StoragePage } from './StoragePage.tsx'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'layerfs-storage'

/** The sidebar entry's glyph: a database cylinder, drawn in currentColor. */
export function StoragePanelIcon({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
      <ellipse cx="8" cy="3.5" rx="5.25" ry="1.75" />
      <path d="M2.75 3.5v9c0 .97 2.35 1.75 5.25 1.75s5.25-.78 5.25-1.75v-9" />
      <path d="M2.75 8c0 .97 2.35 1.75 5.25 1.75S13.25 8.97 13.25 8" />
    </svg>
  )
}

function StorageMain(props: { api: LayerfsApi, t: StorageT }): ReactNode {
  return <StoragePage api={props.api} t={props.t} />
}

/**
 * Register the Storage page and its sidebar entry.
 * @param ctx - the plugin's client context (slots, locale).
 * @param api - the host API the page reads through.
 */
export function registerStorage(ctx: any, api: LayerfsApi): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: storage locale')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ api }),
  }, StorageMain)), 'dsh-layerfs: storage page')
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 9,
    label: () => t('panel'),
    locale: NS,
  }, StoragePanelIcon)), 'dsh-layerfs: storage entry')
}
