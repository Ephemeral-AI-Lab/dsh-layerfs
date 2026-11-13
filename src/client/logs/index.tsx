/**
 * Logs area of dsh-layerfs: the Logs page, a Center page opened from the
 * Center bar (the LayerFS call log, docs/specs/layerfs-logs.md §7).
 */
import type { ReactNode } from 'react'
import { locales, NS } from './locale.ts'

export { openLogs } from './request.ts'
export { LogsPage } from './LogsPage.tsx'
export { NS as LOGS_NS, type LogsT } from './locale.ts'

/** The Logs glyph: a list of call lines, drawn in currentColor. */
export function LogsPanelIcon({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 4h1M2.5 8h1M2.5 12h1" />
      <path d="M6 4h7.5M6 8h7.5M6 12h5" />
    </svg>
  )
}

/**
 * Register the Logs copy (the page itself is a Center page, `logs`).
 * @param ctx - the plugin's client context (locale).
 */
export function registerLogs(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: logs locale')
}
