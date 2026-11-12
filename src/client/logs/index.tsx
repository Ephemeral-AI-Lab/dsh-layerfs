/**
 * Logs area of dsh-layerfs: the sidebar's Logs entry under LayerFS and the
 * page it opens in the main column (the LayerFS call log, docs/specs/layerfs-logs.md §7).
 */
import type { ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { ChildGlyph } from '../overview/child.tsx'
import type { SidebarFold } from '../presets/index.tsx'
import { locales, NS, type LogsT } from './locale.ts'
import { LogsPage } from './LogsPage.tsx'
import { PANEL_ID } from './request.ts'

export { PANEL_ID, openLogs } from './request.ts'

/** The sidebar entry's glyph: a list of call lines, drawn in currentColor. */
export function LogsPanelIcon({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 4h1M2.5 8h1M2.5 12h1" />
      <path d="M6 4h7.5M6 8h7.5M6 12h5" />
    </svg>
  )
}

function LogsMain(props: { api: LayerfsApi, t: LogsT }): ReactNode {
  return <LogsPage api={props.api} t={props.t} />
}

function LogsChildIcon({ size }: { size?: number }): ReactNode {
  return <ChildGlyph><LogsPanelIcon size={size ?? 16} /></ChildGlyph>
}

/**
 * Register the Logs page and its sidebar entry.
 * @param ctx - the plugin's client context (slots, locale).
 * @param api - the host API the page reads through.
 * @param group - the LayerFS sidebar group the entry folds under, if any.
 */
export function registerLogs(ctx: any, api: LayerfsApi, group?: SidebarFold & { unfold?: () => void }): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: logs locale')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ api }),
  }, LogsMain)), 'dsh-layerfs: logs page')
  const entry = () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 9.75,
    label: () => t('panel'),
    locale: NS,
  }, group ? LogsChildIcon : LogsPanelIcon))
  ctx.effect(() => group ? group.whileExpanded(entry) : entry(), 'dsh-layerfs: logs entry')
  // Opened from elsewhere (a checkpoint's Calls) while LayerFS is folded: unfold it so the row shows.
  ctx.effect(() => {
    let was = false
    const sync = (): void => {
      const now = ctx.layout?.panelInfo?.getSnapshot?.().activePanelId === PANEL_ID
      if (now && !was) group?.unfold?.()
      was = now
    }
    sync()
    return ctx.layout?.panelInfo?.subscribe?.(sync) ?? (() => {})
  }, 'dsh-layerfs: logs sidebar fold')
}
