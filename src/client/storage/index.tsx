/**
 * Storage area of dsh-layerfs: the sidebar's Storage entry and the page it
 * opens in the main column. One explorer holds the machines (by type, each
 * with its Stores and Sandboxes), the PostgreSQL Stores and the backups; a
 * machine, Sandbox, Store, project or bucket opens as an editor tab.
 */
import type { ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { NS as DOCTOR_NS } from '../doctor/locale.ts'
import { ChildGlyph } from '../overview/child.tsx'
import type { SidebarGroup } from '../overview/group.ts'
import type { MachinesShare } from '../machines/index.tsx'
import { createSidebarRail } from '../overview/rail.tsx'
import { locales, NS } from './locale.ts'
import { StoragePage, type StorageMainProps } from './StoragePage.tsx'

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

function StorageMain(props: StorageMainProps): ReactNode {
  return <StoragePage {...props} />
}

/**
 * Register the Storage page and its sidebar entry.
 * @param ctx - the plugin's client context (slots, locale).
 * @param api - the host API the page reads through.
 * @param group - the LayerFS sidebar group the entry shows under.
 * @param machines - the Machines controller's face and `t` (the explorer's machines and Sandboxes).
 */
export function registerStorage(ctx: any, api: LayerfsApi, group: SidebarGroup, machines: MachinesShare): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: storage locale')
  const doctorT = ctx.locale.bind(DOCTOR_NS)
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ ...machines.face, tm: machines.t, api, doctorT }),
  }, StorageMain)), 'dsh-layerfs: storage page')
  // Opening Storage folds the sidebar to its icon rail so the page keeps the
  // column: unfold the group so the row's icon shows in the rail, and collapse
  // like the shell's own toggle. The shell's `wide` owner share arrives
  // through a sidebar.footer.action probe; panelInfo fires on every layout
  // change including the collapse itself, so act only on the transition in.
  const rail = createSidebarRail(ctx.layout)
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'layerfs-sidebar-wide',
  }, rail.Probe)), 'dsh-layerfs: sidebar rail probe')
  ctx.effect(() => {
    let was = false
    const sync = (): void => {
      const now = ctx.layout?.panelInfo?.getSnapshot?.().activePanelId === PANEL_ID
      if (was || !now) { was = now; return }
      was = true
      group.unfold()
      rail.collapse()
    }
    sync()
    return ctx.layout?.panelInfo?.subscribe?.(sync) ?? (() => {})
  }, 'dsh-layerfs: storage sidebar fold')
  // The row's button is the shell's — a re-click on the active panel changes
  // nothing panelInfo can see. The only per-row fact we own is the label the
  // registration resolves onto the button, so a document listener watches for
  // clicks on the nav button carrying it.
  ctx.effect(() => {
    const onClick = (event: MouseEvent): void => {
      const button = (event.target as Element | null)?.closest?.('button[aria-label]')
      if (button == null) return
      if (button.getAttribute('aria-label') !== t('panel')) return
      if (button.closest('nav') === null) return
      rail.collapse()
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, 'dsh-layerfs: storage row fold')
  ctx.effect(() => group.whileExpanded(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 9,
    label: () => t('panel'),
    locale: NS,
  }, StorageSidebarIcon))), 'dsh-layerfs: storage entry')
}
