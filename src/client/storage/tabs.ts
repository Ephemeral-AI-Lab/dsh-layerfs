/**
 * The pages the Storage page can show, as ids: the overview, the machines
 * board, a machine, a Sandbox (`sandbox:<machine>/<name>`), a Store, a project
 * (`project:<store>/<name>`), a bucket and a backup file (`backup:<bucket>/<file>`).
 * Links from other pages (`openStorage`) name one of these.
 */
export type TabId = 'overview' | 'machines' | `machine:${string}` | `sandbox:${string}` | `store:${string}` | `project:${string}` | `bucket:${string}` | `backup:${string}`

/** Whether `id` names a page the Storage page can show. */
export function isTabId(id: string): id is TabId {
  return id === 'overview' || id === 'machines' || /^(machine|sandbox|store|project|bucket|backup):./.test(id)
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
