/**
 * Storage area of dsh-layerfs: the sidebar's Storage entry and the page it
 * opens in the main column (Stores, their projects, backups and moves).
 */
import { useEffect, type ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { NS as DOCTOR_NS, type DoctorT } from '../doctor/locale.ts'
import { ChildGlyph } from '../overview/child.tsx'
import type { SidebarGroup } from '../overview/group.ts'
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

function StorageSidebarIcon({ size }: { size?: number }): ReactNode {
  return <ChildGlyph><StoragePanelIcon size={size ?? 16} /></ChildGlyph>
}

function StorageMain(props: { api: LayerfsApi, doctorT: DoctorT, t: StorageT }): ReactNode {
  return <StoragePage api={props.api} doctorT={props.doctorT} t={props.t} />
}

/**
 * Register the Storage page and its sidebar entry.
 * @param ctx - the plugin's client context (slots, locale).
 * @param api - the host API the page reads through.
 * @param group - the LayerFS sidebar group the entry shows under.
 */
export function registerStorage(ctx: any, api: LayerfsApi, group: SidebarGroup): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: storage locale')
  const doctorT = ctx.locale.bind(DOCTOR_NS)
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ api, doctorT }),
  }, StorageMain)), 'dsh-layerfs: storage page')
  // Storage opens from places outside the folded sidebar (the LayerFS card,
  // Machines links, a session's panel): unfold the group so its row shows and,
  // when the sidebar itself sits collapsed as the icon rail, expand it like
  // the shell's own expandSidebar (`if (collapsed) toggleSidebar()`). The
  // shell's `wide` owner share arrives through a sidebar.footer.action probe.
  let wide = true
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'layerfs-sidebar-wide',
  }, function RailProbe({ wide: w }: { wide?: boolean | undefined }): ReactNode {
    useEffect(() => { wide = w !== false }, [w])
    return null
  })), 'dsh-layerfs: sidebar rail probe')
  ctx.effect(() => {
    // Fires on every layout change, including the toggle below: act only on
    // the transition into Storage so the expand cannot re-enter itself.
    let was = false
    const sync = (): void => {
      const now = ctx.layout?.panelInfo?.getSnapshot?.().activePanelId === PANEL_ID
      if (was || !now) { was = now; return }
      was = true
      group.unfold()
      if (!wide) ctx.layout?.toggleSidebar?.()
    }
    sync()
    return ctx.layout?.panelInfo?.subscribe?.(sync) ?? (() => {})
  }, 'dsh-layerfs: storage unfold')
  ctx.effect(() => group.whileExpanded(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 9,
    label: () => t('panel'),
    locale: NS,
  }, StorageSidebarIcon))), 'dsh-layerfs: storage entry')
}
