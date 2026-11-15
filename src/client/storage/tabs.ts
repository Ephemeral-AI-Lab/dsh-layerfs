/**
 * The pages the Storage page can show, as ids: the overview, the machines
 * board, a machine, a Sandbox (`sandbox:<machine>/<name>`), a Store, a project
 * (`project:<store>/<name>`), a bucket and a backup file (`backup:<bucket>/<file>`).
 * Links from other pages (`openStorage`) name one of these.
 */
export type TabId = 'overview' | 'machines' | 'health' | 'logs' | 'settings' | `machine:${string}` | `sandbox:${string}` | `store:${string}` | `project:${string}` | `bucket:${string}` | `backup:${string}`

/** Whether `id` names a page the Storage page can show. */
export function isTabId(id: string): id is TabId {
  return id === 'overview' || id === 'machines' || id === 'health' || id === 'logs' || id === 'settings' || /^(machine|sandbox|store|project|bucket|backup):./.test(id)
}

/** The Overview's sections, one per hero stat tile. */
export type OverviewTab = 'projects' | 'stores' | 'machines' | 'backups'

const TAB_KEY = 'dsh-layerfs:overview-tab'

export const isOverviewTab = (v: unknown): v is OverviewTab => v === 'projects' || v === 'stores' || v === 'machines' || v === 'backups'

/** The Overview section this viewer had open last (a per-browser convenience; storage may be blocked). */
export function readOverviewTab(): OverviewTab {
  try { const v = localStorage.getItem(TAB_KEY); return isOverviewTab(v) ? v : 'projects' } catch { return 'projects' }
}

/** Remember the Overview section for this viewer. */
export function writeOverviewTab(tab: OverviewTab): void {
  try { localStorage.setItem(TAB_KEY, tab) } catch { /* the section still switches */ }
}

// ---------------------------------------------------------------- a machine's or Sandbox's own tabs

/** The tabs inside a machine page (Overview, Files, Worker log) and a Sandbox page (Terminals, Files, Daemon log). */
export type DetailTab = 'overview' | 'terminals' | 'files' | 'log'
export type DetailKind = 'machine' | 'sandbox'

const DETAIL_KEY = 'dsh-layerfs:detail-tabs'
/** How many machines and Sandboxes keep their last tab. */
const DETAIL_KEEP = 100
const isDetailTab = (v: unknown): v is DetailTab => v === 'overview' || v === 'terminals' || v === 'files' || v === 'log'

/** dsh has no URLs: the tab a link asks for is kept here, in the app, and mirrored to localStorage as the last one per entity. */
const chosen = new Map<string, DetailTab>()
const watchers = new Set<(key: string, tab: DetailTab) => void>()
const detailKey = (kind: DetailKind, name: string): string => `${kind}:${name}`

function storedTabs(): Record<string, unknown> {
  try { const v = JSON.parse(localStorage.getItem(DETAIL_KEY) ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} }
}

/** The tab this viewer had open last on a machine or Sandbox, if any (storage may be blocked). */
export function readDetailTab(kind: DetailKind, name: string): DetailTab | null {
  const key = detailKey(kind, name)
  const own = chosen.get(key)
  if (own) return own
  const v = storedTabs()[key]
  return isDetailTab(v) ? v : null
}

/** Remember the tab, and tell a page already showing that machine or Sandbox to switch to it. */
export function writeDetailTab(kind: DetailKind, name: string, tab: DetailTab): void {
  const key = detailKey(kind, name)
  chosen.delete(key)
  chosen.set(key, tab)
  if (chosen.size > DETAIL_KEEP) chosen.delete(chosen.keys().next().value!)
  try {
    const all = storedTabs()
    delete all[key]
    all[key] = tab
    const keys = Object.keys(all)
    for (const old of keys.slice(0, Math.max(0, keys.length - DETAIL_KEEP))) delete all[old]
    localStorage.setItem(DETAIL_KEY, JSON.stringify(all))
  } catch { /* the tab still switches */ }
  for (const watch of [...watchers]) watch(key, tab)
}

/** Hear a tab chosen for `kind:name` (a link elsewhere on the page). Returns the release. */
export function watchDetailTab(kind: DetailKind, name: string, listener: (tab: DetailTab) => void): () => void {
  const key = detailKey(kind, name)
  const watch = (k: string, tab: DetailTab) => { if (k === key) listener(tab) }
  watchers.add(watch)
  return () => { watchers.delete(watch) }
}
