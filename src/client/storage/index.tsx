/**
 * Center area of dsh-layerfs: the sidebar's one LayerFS row and the Center
 * page it opens in the main column. The Overview is home; a machine, Sandbox,
 * Store, project, bucket, or the Health and Logs pages open in its
 * place under the page's navigation bar (Back/Forward, breadcrumb with
 * switchers, Jump to, transfers, Health/Logs/Settings, Refresh, Add).
 */
import { useEffect, useRef, type ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { NS as DOCTOR_NS } from '../doctor/locale.ts'
import { LOGS_NS } from '../logs/index.tsx'
import type { MachinesShare } from '../machines/index.tsx'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { NS as LIST_NS } from '../projects/list-locale.ts'
import { createSidebarRail } from '../overview/rail.tsx'
import { SETUP_MODAL_NS } from '../setup/index.tsx'
import { NS as VIEWS_NS } from '../views/locale.ts'
import { sessionsSource } from '../views/index.tsx'
import { locales, NS } from './locale.ts'
import { PREFETCH_IDLE_MS, prefetchHome } from './prefetch.ts'
import { StoragePage, type StorageMainProps } from './StoragePage.tsx'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'layerfs-storage'

/** `requestIdleCallback` is not on every browser (and not in SSR); the timer alone still runs the prefetch. */
type IdleWindow = { requestIdleCallback?: (cb: () => void, options?: { timeout?: number }) => number, cancelIdleCallback?: (id: number) => void }

/**
 * The sidebar's one LayerFS row. The row itself is DSH's button; this glyph
 * sits inside it, which is enough to hear pointer intent. It also warms Home
 * after the sidebar has sat idle for a moment, so a keyboard, programmatic or
 * touch click finds the reads already in flight (DSH owns the row's focus, so
 * there is no document listener here). Nothing is warmed while Center itself
 * shows, and nothing runs before the host connection is up.
 */
function sidebarIcon(api: LayerfsApi): (props: { size?: number, active?: boolean }) => ReactNode {
  return function CenterSidebarIcon({ size, active }: { size?: number, active?: boolean }): ReactNode {
    const entry = useRef<HTMLSpanElement>(null)
    useEffect(() => {
      if (active) return
      const span = entry.current
      /** Warm once the row is actually on screen and the host is connected. */
      const visibly = (): boolean => document.visibilityState === 'visible' && !!span && span.getClientRects().length > 0
      const warm = (): void => { if (visibly()) void prefetchHome(api) }
      // The room is up when the host event stream is; until then a send would
      // wait in an admission slot. The connection event also covers the boot.
      const off = api.onEvent('connection', (event) => {
        if ((event.data as { connected?: boolean } | undefined)?.connected) schedule()
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      let idle: number | undefined
      const idleWindow = globalThis as unknown as IdleWindow
      const runIdle = (): void => { idle = undefined; warm() }
      function schedule(): void {
        if (timer !== undefined || idle !== undefined) return
        timer = setTimeout(() => {
          timer = undefined
          if (!visibly()) return
          if (typeof idleWindow.requestIdleCallback === 'function') idle = idleWindow.requestIdleCallback(runIdle, { timeout: 1000 })
          else runIdle()
        }, PREFETCH_IDLE_MS)
      }
      schedule()
      return () => {
        clearTimeout(timer)
        if (idle !== undefined) idleWindow.cancelIdleCallback?.(idle)
        off()
      }
    }, [api, active])
    return (
      <span ref={entry} data-layerfs-entry="" onPointerEnter={() => { if (!active) void prefetchHome(api) }}>
        <LayerfsGlyph size={size ?? 16} />
      </span>
    )
  }
}

function StorageMain(props: StorageMainProps): ReactNode {
  return <StoragePage {...props} />
}

/**
 * Register the Center page and the sidebar's LayerFS row that opens it.
 * @param ctx - the plugin's client context (slots, locale).
 * @param api - the host API the page reads through.
 * @param machines - the Machines controller's face and `t` (the machines and Sandboxes its pages show).
 */
export function registerStorage(ctx: any, api: LayerfsApi, machines: MachinesShare): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: storage locale')
  const doctorT = ctx.locale.bind(DOCTOR_NS)
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({
      ...machines.face, tm: machines.t, api, doctorT, map: { t: ctx.locale.bind(VIEWS_NS), sessions: sessionsSource(ctx) },
      more: { logs: ctx.locale.bind(LOGS_NS), setup: ctx.locale.bind(SETUP_MODAL_NS) },
    }),
  }, StorageMain)), 'dsh-layerfs: storage page')
  // Opening Center folds the sidebar to its icon rail so the page keeps the
  // column, like the shell's own toggle. The shell's `wide` owner share arrives
  // through a sidebar.footer.action probe; panelInfo fires on every layout
  // change including the collapse itself, so act only on the transition in.
  const rail = createSidebarRail(ctx.layout, PANEL_ID)
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'layerfs-sidebar-wide', locale: LIST_NS,
  }, rail.Footer)), 'dsh-layerfs: Center sidebar fold action')
  ctx.effect(() => {
    let was = false
    const sync = (): void => {
      const now = ctx.layout?.panelInfo?.getSnapshot?.().activePanelId === PANEL_ID
      if (was || !now) { was = now; return }
      was = true
      rail.collapse()
    }
    sync()
    return ctx.layout?.panelInfo?.subscribe?.(sync) ?? (() => {})
  }, 'dsh-layerfs: storage sidebar fold')
  // The sidebar's one LayerFS row: it opens Center (Health and Logs are Center pages; Settings opens the setup modal).
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 7.5,
    label: () => t('panel'),
    locale: NS,
  }, sidebarIcon(api))), 'dsh-layerfs: LayerFS sidebar row')
}
