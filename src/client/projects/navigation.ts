import { useSyncExternalStore } from 'react'
import type { LayerfsApi } from '../api.ts'

/** Selection belongs to this connection and survives panel unmounts. */
const selections = new WeakMap<LayerfsApi, { project: string | null, machine: { name: string } | null, listeners: Set<() => void> }>()
function selection(api: LayerfsApi) {
  let value = selections.get(api)
  if (!value) { value = { project: null, machine: null, listeners: new Set() }; selections.set(api, value) }
  return value
}
export function openProjectHome(api: LayerfsApi, project: string | null): void {
  const value = selection(api)
  value.project = project
  for (const listener of value.listeners) listener()
  api.openPanel('layerfs-projects')
}
export function useProjectSelection(api: LayerfsApi): string | null {
  const value = selection(api)
  return useSyncExternalStore((listener) => {
    value.listeners.add(listener)
    return () => { value.listeners.delete(listener) }
  }, () => value.project)
}

export function openMachineHome(api: LayerfsApi, machine: string | null): void {
  const value = selection(api)
  value.machine = machine ? { name: machine } : null
  for (const listener of value.listeners) listener()
  api.openPanel('layerfs-machines')
}
export function useMachineSelection(api: LayerfsApi): { name: string } | null {
  const value = selection(api)
  return useSyncExternalStore((listener) => {
    value.listeners.add(listener)
    return () => { value.listeners.delete(listener) }
  }, () => value.machine)
}
