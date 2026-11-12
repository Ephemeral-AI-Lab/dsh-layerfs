/**
 * Projects area of dsh-layerfs: the sidebar's Projects entry and the page it
 * opens in the main column — every LayerFS project with its sessions. It is
 * the sidebar's LayerFS half, next to the Workspaces list's plain folders.
 */
import type { ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { ChildGlyph } from '../overview/child.tsx'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import type { SidebarGroup } from '../overview/group.ts'
import { NS as PICKER_NS, type PickerKey } from '../picker/locale.ts'
import { locales, NS, type ProjectsT } from './locale.ts'
import { NS as STORAGE_NS, type StorageT } from '../storage/locale.ts'
import { ProjectsPage } from './ProjectsPage.tsx'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'layerfs-projects'

type Translate<K extends string> = (key: K, params?: Record<string, string | number>) => string

function ProjectsSidebarIcon({ size }: { size?: number }): ReactNode {
  return <ChildGlyph><LayerfsGlyph size={size ?? 16} /></ChildGlyph>
}

function ProjectsMain(props: { api: LayerfsApi, t: ProjectsT, tp: Translate<PickerKey>, tf: StorageT }): ReactNode {
  return <ProjectsPage api={props.api} t={props.t} tp={props.tp} tf={props.tf as import("../files/types.ts").Translate} />
}

/**
 * Register the Projects page and its sidebar entry.
 * @param ctx - the plugin's client context (slots, locale).
 * @param api - the host API the page reads through.
 * @param group - the LayerFS sidebar group the entry shows under.
 */
export function registerProjects(ctx: any, api: LayerfsApi, group: SidebarGroup): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: projects locale')
  const t = ctx.locale.bind(NS)
  const tp = ctx.locale.bind(PICKER_NS)
  const tf = ctx.locale.bind(STORAGE_NS)
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ api, t, tp, tf }),
  }, ProjectsMain)), 'dsh-layerfs: projects page')
  ctx.effect(() => group.whileExpanded(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 7.6,
    label: () => t('panel'),
    locale: NS,
  }, ProjectsSidebarIcon))), 'dsh-layerfs: projects entry')
}
