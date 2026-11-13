/**
 * The project dialog's state (docs/specs/layerfs-workspaces.md §2): one modal
 * for creating, importing, configuring and picking LayerFS projects, opened
 * from the sidebar, its `+` menu and the New Session project menu.
 *
 * Several places mount a host (the sidebar foot, the New Session row); only
 * the first mounted one renders, so the modal shows once wherever it opens.
 */
import { createElement, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'

/** A project the dialog configures: its address, and its identity when known. */
export interface ProjectRef { key: string, projectId?: string | null | undefined, name?: string | null | undefined, store?: string | null | undefined }

/** `back`: the request the head's Back link returns to (the picker, when opened from it). */
export type DialogRequest =
  | { mode: 'new', back?: DialogRequest | undefined }
  | { mode: 'import', back?: DialogRequest | undefined }
  | { mode: 'pick' }
  | { mode: 'configure', project: ProjectRef, back?: DialogRequest | undefined }

let current: DialogRequest | null = null
const listeners = new Set<() => void>()
const hosts: symbol[] = []
let render: ((request: DialogRequest) => ReactNode) | null = null
const notify = () => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export const projectDialog = {
  /** Open the dialog in a mode (replaces what it shows). */
  open(request: DialogRequest): void { current = request; notify() },
  close(): void { if (current) { current = null; notify() } },
  get: (): DialogRequest | null => current,
  subscribe,
}

/** Set by the projects area at registration: how the dialog renders a request. */
export function setProjectDialogRenderer(renderer: ((request: DialogRequest) => ReactNode) | null): () => void {
  render = renderer
  notify()
  return () => { if (render === renderer) { render = null; notify() } }
}

/** A place the dialog can render from. Renders the dialog when it is the first mounted host. */
export function ProjectDialogMount(): ReactNode {
  const [me] = useState(() => Symbol('project-dialog-host'))
  useEffect(() => {
    hosts.push(me); notify()
    return () => { hosts.splice(hosts.indexOf(me), 1); notify() }
  }, [me])
  const request = useSyncExternalStore(subscribe, () => (hosts[0] === me ? current : null))
  if (!request || !render) return null
  // The modal portals itself to the document body; the key restarts it per request.
  return createElement(DialogFrame, { key: request.mode === 'configure' ? `configure:${request.project.projectId ?? request.project.key}` : request.mode, request })
}

function DialogFrame({ request }: { request: DialogRequest }): ReactNode {
  return render ? render(request) : null
}
