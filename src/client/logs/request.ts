/**
 * Opening the Logs page pre-filtered from elsewhere (a checkpoint's "Calls").
 * The caller leaves a request here and opens Center's Logs page; the page
 * takes the request when it mounts, or when a new one arrives while it is
 * open. Kept free of the page so callers do not pull it in.
 */
import type { LayerfsApi } from '../api.ts'
import { openStorage } from '../projects/navigation.ts'

/** What the page should show when it opens. */
export interface LogsRequest {
  /** Exact `dsh:<session>:<receipt>` tag, or a prefix ending in `:`. */
  readonly tag?: string
}

let pending: LogsRequest | undefined
const listeners = new Set<() => void>()

/**
 * Open the Logs page with a filter.
 * @param api - the host API (opens Center on its Logs page).
 * @param request - the filter to apply.
 */
export function openLogs(api: LayerfsApi, request: LogsRequest): void {
  pending = { ...request }
  for (const listener of [...listeners]) listener()
  openStorage(api, 'logs')
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
