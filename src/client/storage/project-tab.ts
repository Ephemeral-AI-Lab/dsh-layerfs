/**
 * A tab another page asks a project page to show (Home's export dialog opens
 * History): the request waits until that project's page takes it, mounted
 * now or later.
 */
export type ProjectTab = 'files' | 'history' | 'sandboxes' | 'sessions' | 'stats'

const wanted = new Map<string, ProjectTab>()
const listeners = new Set<() => void>()

/** Ask `project`'s page to show `tab` (it opens on it when mounted next). */
export function showProjectTab(project: string, tab: ProjectTab): void {
  wanted.set(project, tab)
  for (const listener of listeners) listener()
}

/** The tab asked for `project`, once (the request is taken). */
export function takeProjectTab(project: string): ProjectTab | undefined {
  const tab = wanted.get(project)
  wanted.delete(project)
  return tab
}

/** Called after each request; answers the unsubscribe. */
export function onProjectTab(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
