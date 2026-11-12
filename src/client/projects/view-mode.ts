/**
 * Which list the sidebar's Workspaces section shows: DSH's workspaces (the
 * stock browser) or LayerFS projects. Remembered per browser.
 */
export type WorkspacesView = 'dsh' | 'layerfs'

const KEY = 'dsh-layerfs:workspaces-view'
const listeners = new Set<() => void>()

function read(): WorkspacesView {
  try { return localStorage.getItem(KEY) === 'layerfs' ? 'layerfs' : 'dsh' } catch { return 'dsh' }
}

let value: WorkspacesView = typeof window === 'undefined' ? 'dsh' : read()

export const workspacesView = {
  get: (): WorkspacesView => value,
  set(next: WorkspacesView): void {
    if (next === value) return
    value = next
    try { localStorage.setItem(KEY, next) } catch {}
    for (const listener of [...listeners]) listener()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}
