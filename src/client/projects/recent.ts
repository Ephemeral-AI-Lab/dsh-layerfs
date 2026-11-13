/**
 * The sidebar's projects (docs/specs/layerfs-workspaces.md §2, §4): projects
 * with sessions on this DSH (`projects.recent`), newest activity first, joined
 * to the catalog, without projects hidden in this browser since their last
 * session. Any local session counts, unused drafts too: a project just made
 * keeps its row (its session list still hides the drafts).
 */
import type { ProjectRow } from '../picker/NewProjectForm.tsx'

/** One `projects.recent` row. */
export interface RecentProject { project: string, projectId?: string, lastActivity: number, sessionIds: string[]
  /** When its newest session was made: a project hidden before that shows again. */
  newestSession?: number }

/** One sidebar project. `hideKey` names it in the hidden map. */
export interface SidebarProject { row: ProjectRow, lastActivity: number, showStore: boolean, hideKey: string }

const nameOf = (row: ProjectRow) => row.name ?? row.key.split('/')[1] ?? row.key

/**
 * The sidebar's rows.
 * @param recent - `projects.recent` rows, newest first.
 * @param catalog - the catalog rows, or null while unread (then nothing is marked removed).
 * @param hidden - hide key → time hidden; a newer session shows the project again.
 * @param liveStores - Stores that exist now: a project missing from the catalog whose Store
 *   exists is not called removed (the catalog may not have caught up with a new project yet).
 */
export function sidebarProjects(recent: readonly RecentProject[], catalog: readonly ProjectRow[] | null, hidden: Record<string, number>, liveStores?: ReadonlySet<string>): SidebarProject[] {
  const out = new Map<string, SidebarProject>()
  for (const r of recent) {
    if (!r.sessionIds.length) continue
    const hideKey = r.projectId ?? r.project
    if ((hidden[hideKey] ?? -1) >= (r.newestSession ?? r.lastActivity)) continue
    const row = (r.projectId ? catalog?.find((p) => p.projectId === r.projectId) : undefined)
      ?? catalog?.find((p) => p.key === r.project)
      ?? { key: r.project, name: r.project.split('/')[1], store: r.project.split('/')[0], ...(r.projectId ? { projectId: r.projectId } : {}),
        ...(catalog && !liveStores?.has(r.project.split('/')[0] ?? '') ? { catalogState: 'removed' as const } : {}) }
    const id = row.projectId ?? row.key
    const had = out.get(id)
    if (!had || had.lastActivity < r.lastActivity) out.set(id, { row, lastActivity: Math.max(r.lastActivity, had?.lastActivity ?? 0), showStore: false, hideKey })
  }
  const rows = [...out.values()].sort((a, b) => b.lastActivity - a.lastActivity)
  const count = new Map<string, number>()
  for (const r of rows) count.set(nameOf(r.row), (count.get(nameOf(r.row)) ?? 0) + 1)
  for (const r of rows) r.showStore = (count.get(nameOf(r.row)) ?? 0) > 1
  return rows
}

const KEY = 'dsh-layerfs:sidebar-hidden'
const listeners = new Set<() => void>()
function read(): Record<string, number> {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} }
}
let hidden: Record<string, number> = typeof window === 'undefined' ? {} : read()

/** Projects hidden from the sidebar in this browser. */
export const sidebarHidden = {
  get: (): Record<string, number> => hidden,
  hide(key: string): void {
    hidden = { ...hidden, [key]: Date.now() }
    try { localStorage.setItem(KEY, JSON.stringify(hidden)) } catch {}
    for (const listener of [...listeners]) listener()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}
