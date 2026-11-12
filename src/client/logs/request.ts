/**
 * Opening the Logs page pre-filtered from elsewhere (a checkpoint's "Calls").
 * The caller leaves a request here and selects the panel; the page takes the
 * request when it mounts, or when a new one arrives while it is open.
 * Kept free of the page so callers do not pull it in.
 */

/** The id shared by the Logs sidebar entry and the main panel it opens. */
export const PANEL_ID = 'layerfs-logs'

/** What the page should show when it opens. */
export interface LogsRequest {
  /** Exact `dsh:<session>:<receipt>` tag, or a prefix ending in `:`. */
  readonly tag?: string
}

let pending: LogsRequest | undefined
const listeners = new Set<() => void>()

/**
 * Open the Logs page with a filter.
 * @param api - anything that can select a main panel.
 * @param request - the filter to apply.
 */
export function openLogs(api: { openPanel(id: string): void }, request: LogsRequest): void {
  pending = { ...request }
  for (const listener of [...listeners]) listener()
  api.openPanel(PANEL_ID)
}

/** The request left for the page, if any, without clearing it (safe in a render). */
export function peekLogsRequest(): LogsRequest | undefined {
  return pending
}

/** The request left for the page, if any; taking it clears it. */
export function takeLogsRequest(): LogsRequest | undefined {
  const request = pending
  pending = undefined
  return request
}

/** Called when a request arrives while the page is open. */
export function onLogsRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
