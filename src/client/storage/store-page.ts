/**
 * The Store page's tabs and the numbers its views draw, kept free of React so
 * they are unit tested (test/store-page.test.mjs).
 *
 * - Tabs: Overview, Projects, and Backups (SQLite) or Connections (PostgreSQL).
 * - The database file's parts (`store.stats`: stored content, metadata, free pages).
 * - The Store's growth from the host's observation journal of `store.stats` reads.
 * - Each project's share of the Store's packed bytes, from the project ledgers.
 * - The project cards: order, search and the Sandboxes running per project.
 */
export type StoreTab = 'overview' | 'projects' | 'backups' | 'connections'

/** The third tab follows the Store's family: a SQLite Store has backups, a PostgreSQL Store has its connection. */
export function storeTabs(kind: string): StoreTab[] {
  return ['overview', 'projects', kind === 'postgresql' ? 'connections' : 'backups']
}

/** `GET /api/stores/<name>/stats`: `store.stats`, plus the file's own measurement on SQLite. */
export interface StoreStats {
  kind?: string
  history_logical?: number | null
  canonical?: number | null
  stored?: number | null
  metadata?: number | null
  file?: number | null
  free?: number | null
  fileMeasurements?: { observedAt: number, bytes: number | null, walBytes: number | null } | null
}

export interface FilePart { key: 'stored' | 'metadata' | 'free', bytes: number, share: number }

/**
 * What fills the database file: stored content, metadata (with page overhead)
 * and free pages. Shares are of their sum, which is the file's pages; parts
 * LayerFS did not report are left out, never guessed. Null when none is known.
 */
export function fileParts(stats: StoreStats | null | undefined): FilePart[] | null {
  if (!stats) return null
  const parts = (['stored', 'metadata', 'free'] as const)
    .map((key) => ({ key, bytes: num(stats[key]) }))
    .filter((p): p is { key: FilePart['key'], bytes: number } => p.bytes !== null)
  const sum = parts.reduce((a, p) => a + p.bytes, 0)
  if (!parts.length || sum <= 0) return null
  return parts.map((p) => ({ ...p, share: p.bytes / sum }))
}

/** Unique content over its packed bytes (`canonical / stored`), when both are known and nonzero. */
export function compressionOf(stats: StoreStats | null | undefined): number | null {
  const canonical = num(stats?.canonical), stored = num(stats?.stored)
  return canonical && stored && canonical > 0 && stored > 0 ? canonical / stored : null
}

/** `GET /api/stores/<name>/observations`: the host's journal of successful `store.stats` reads. */
export interface ObservationJournal {
  gapAfterMs: number
  series: { identity: string, startedAt: number, points: { observedAt: number, stats: StoreStats }[] }[]
}

export interface GrowthPoint { at: number, file: number | null, stored: number | null, metadata: number | null }

/**
 * The newest series of the journal (a Store recreated under the same name
 * starts a new one) as runs: a gap longer than the journal's `gapAfterMs`
 * between two reads starts a new run, drawn as a break, never filled in.
 */
export function growthRuns(journal: ObservationJournal | null | undefined): GrowthPoint[][] {
  const series = journal?.series?.length ? journal.series[journal.series.length - 1] : null
  if (!series) return []
  const gap = journal!.gapAfterMs > 0 ? journal!.gapAfterMs : 30 * 60_000
  const runs: GrowthPoint[][] = []
  let last: number | null = null
  for (const p of [...series.points].sort((a, b) => a.observedAt - b.observedAt)) {
    const point = { at: p.observedAt, file: num(p.stats?.file), stored: num(p.stats?.stored), metadata: num(p.stats?.metadata) }
    if (last === null || p.observedAt - last > gap) runs.push([point])
    else runs[runs.length - 1]!.push(point)
    last = p.observedAt
  }
  return runs
}

/** `GET /api/stores/<name>/projects`: one project's ledger totals, newest Commit and main's file count. */
export interface StoreProject {
  name: string
  created: number | null
  totals: { saves: number, merges: number, branches: number, stored: number, metadata: number, commitLogical: number, canonical: number } | null
  last: { id: string, time: number | null, branch: string, message: string } | null
  files: { files: number | null, complete: boolean } | null
  partial: boolean
  building: { branches: number, branchesTotal: number, saves: number } | null
  error: { code: string, message: string } | null
}

export interface StoreProjectsView { store: string, projects: StoreProject[] }

export interface ProjectShare { name: string, bytes: number, share: number, hue: number }

/**
 * Each project's packed bytes (its Commits' `new_stored`, metadata included)
 * as a share of all projects' sum; a project with nothing counted yet is left
 * out. Hues follow the name order so a project keeps its color between views.
 */
export function projectShares(projects: readonly StoreProject[]): ProjectShare[] {
  const rows = projects.map((p) => ({ name: p.name, bytes: p.totals?.stored ?? 0 })).filter((p) => p.bytes > 0)
  const sum = rows.reduce((a, p) => a + p.bytes, 0)
  return rows.map((p) => ({ ...p, share: sum > 0 ? p.bytes / sum : 0, hue: hueOf(p.name, projects) })).sort((a, b) => b.bytes - a.bytes)
}

/** One of six hues by the project's place in name order. */
export function hueOf(name: string, projects: readonly { name: string }[]): number {
  const names = projects.map((p) => p.name).sort()
  const i = names.indexOf(name)
  return (i < 0 ? 0 : i) % 6
}

/** `session`: last session first, by an order frozen by the table (ProjectTable.tsx); `orderProjects` leaves it to the caller. */
export type ProjectOrder = 'session' | 'recent' | 'name' | 'commits' | 'branches' | 'size'

/** The rows in the chosen order (names A→Z, figures largest first), filtered by a case-blind name search. A project never saved sorts after saved ones by recency. */
export function orderProjects(projects: readonly StoreProject[], order: ProjectOrder, query: string): StoreProject[] {
  const q = query.trim().toLowerCase()
  const shown = projects.filter((p) => p.name.toLowerCase().includes(q))
  const byName = (a: StoreProject, b: StoreProject) => a.name.localeCompare(b.name)
  if (order === 'name') return shown.sort(byName)
  if (order === 'size') return shown.sort((a, b) => (b.totals?.stored ?? -1) - (a.totals?.stored ?? -1) || byName(a, b))
  if (order === 'commits') return shown.sort((a, b) => (b.totals?.saves ?? -1) - (a.totals?.saves ?? -1) || byName(a, b))
  if (order === 'branches') return shown.sort((a, b) => (b.totals?.branches ?? -1) - (a.totals?.branches ?? -1) || byName(a, b))
  const at = (p: StoreProject) => p.last?.time ?? p.created ?? -1
  return shown.sort((a, b) => at(b) - at(a) || byName(a, b))
}

/** Sandboxes of this Store's projects whose daemon runs now (`live` true, or running state when `live` is not reported), per project name. */
export function runningByProject(store: string, sandboxes: readonly { project: string | null, state?: string, live?: boolean | null }[] | null | undefined): Map<string, number> {
  const counts = new Map<string, number>()
  for (const b of sandboxes ?? []) {
    if (!b.project || !b.project.startsWith(`${store}/`)) continue
    const running = b.live === true || (b.live === undefined && b.state === 'running')
    if (!running) continue
    const name = b.project.slice(store.length + 1)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

/**
 * The sum of the projects' Commits, whether every ledger has finished its
 * first read, and the first refusal of a ledger that has nothing counted
 * (its Store cannot be read: no total is coming).
 */
export function commitTotal(projects: readonly StoreProject[]): { commits: number, complete: boolean, refused: string | null } {
  return {
    commits: projects.reduce((a, p) => a + (p.totals?.saves ?? 0), 0),
    complete: projects.every((p) => !p.partial && p.totals !== null),
    refused: projects.find((p) => p.error && p.totals === null)?.error?.message ?? null,
  }
}

/** Whether a ledger is still being read (and the answer worth asking again): partial or building, not refused. */
export const stillCounting = (p: StoreProject): boolean => (p.partial || p.building !== null) && !(p.error && !p.building)

/** The session store's Branch prefix (host `STORE_PREFIX`): one Branch per archived DSH conversation. */
const SESSION_BRANCH = 'dsh.session.'
const SESSION_SAVE = /^dsh session ([0-9a-f]+): events (\d+)\.\.(\d+)/

/**
 * A project's newest Commit as one readable line: a session-store save
 * (`dsh session <id>: events a..b (n bytes)`) becomes its session and event
 * range; any other Commit keeps its message. The Branch is named unless it is
 * a session archive Branch, which the session line already says.
 */
export function commitLine(last: NonNullable<StoreProject['last']>): { session: { id: string, range: string } | null, message: string, branch: string | null } {
  const m = SESSION_SAVE.exec(last.message)
  const branch = last.branch && !last.branch.startsWith(SESSION_BRANCH) ? last.branch : null
  if (m) return { session: { id: m[1]!, range: `${m[2]}–${m[3]}` }, message: last.message, branch }
  return { session: null, message: last.message.split('\n')[0]!.trim(), branch }
}

/** main's file count as a figure: "1,234", "10,000+" past the read budget, or null when unknown. */
export function filesNumber(files: StoreProject['files']): string | null {
  if (!files || files.files === null) return null
  return `${files.files.toLocaleString()}${files.complete ? '' : '+'}`
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
