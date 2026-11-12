import { useSyncExternalStore } from 'react'
import type { LayerfsApi } from '../api.ts'

/** Selection belongs to this connection and survives panel unmounts. */
const selections = new WeakMap<LayerfsApi, { project: string | null, storageTab: string | null, listeners: Set<() => void> }>()
function selection(api: LayerfsApi) {
  let value = selections.get(api)
  if (!value) { value = { project: null, storageTab: null, listeners: new Set() }; selections.set(api, value) }
  return value
}
/** The Projects page (opened from the sidebar section's header) and one project's page. */
export const LIST_PANEL_ID = 'layerfs-projects'
export const PROJECT_PANEL_ID = 'layerfs-project'

/** Open one project's page, or the project list when `project` is null. */
export function openProjectHome(api: LayerfsApi, project: string | null): void {
  const value = selection(api)
  value.project = project
  for (const listener of value.listeners) listener()
  api.openPanel(project ? PROJECT_PANEL_ID : LIST_PANEL_ID)
}
export function useProjectSelection(api: LayerfsApi): string | null {
  const value = selection(api)
  return useSyncExternalStore((listener) => {
    value.listeners.add(listener)
    return () => { value.listeners.delete(listener) }
  }, () => value.project)
}

/** The Storage page: Stores, machines, Sandboxes and backups in one explorer. */
export const STORAGE_PANEL_ID = 'layerfs-storage'

/**
 * Open the Storage page, and in it the editor tab `tab` when given
 * (`machines`, `machine:<name>`, `sandbox:<machine>/<name>`, `store:<name>`,
 * `project:<store>/<name>`, `bucket:<name>`). The page takes the request once.
 */
export function openStorage(api: LayerfsApi, tab?: string | null): void {
  const value = selection(api)
  value.storageTab = tab ?? null
  for (const listener of value.listeners) listener()
  api.openPanel(STORAGE_PANEL_ID)
}
/** The tab a link asked Storage to open, until the page takes it. */
export function useStorageRequest(api: LayerfsApi): string | null {
  const value = selection(api)
  return useSyncExternalStore((listener) => {
    value.listeners.add(listener)
    return () => { value.listeners.delete(listener) }
  }, () => value.storageTab)
}
/** The page opened the requested tab: forget it, so the next visit starts where the user left. */
export function takeStorageRequest(api: LayerfsApi): void {
  const value = selection(api)
  if (value.storageTab === null) return
  value.storageTab = null
  for (const listener of value.listeners) listener()
}

/** One machine's page in Storage, or the machines board when `machine` is null. */
export function openMachineHome(api: LayerfsApi, machine: string | null): void {
  openStorage(api, machine ? `machine:${machine}` : 'machines')
}
