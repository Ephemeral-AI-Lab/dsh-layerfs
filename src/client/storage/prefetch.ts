/**
 * Home's reads before the click. The Overview cannot paint until
 * `GET /api/storage` answers; on a cold mount that read starts only after the
 * shell has mounted the panel (~120 ms), so the first card lands near 340 ms
 * even though the route itself takes ~70 ms. When the pointer or focus reaches
 * the sidebar's LayerFS row (or the sidebar sits idle for a moment), this warms
 * the same reads the panel is about to make, through the shared host seam:
 *
 * - the Store view, Home's catalog and the picker's `projects.catalog`;
 * - each visible project's local `sessions.list` (the table's session counts);
 * - the first projects' portable archive, the read an unfolded row makes.
 *
 * The answers are handed to the panel through `keepPrefetched` / the session
 * list map: the first render after the click draws what is known, while the
 * normal read on mount still starts (and joins a prefetch still in flight).
 * Nothing here is a host TTL or a long-lived cache — the paint hint is bounded
 * by `PREFETCH_PAINT_MAX_AGE_MS` and used once.
 */
import type { HostCallOptions, LayerfsApi } from '../api.ts'
import type { ProjectRow } from '../picker/NewProjectForm.ts'
import type { ProjectSession } from '../projects/hooks.ts'
import { keepPrefetched } from '../ui/use-query.ts'
import { keepSessionList } from './session-cache.ts'
import type { ProjectSummary, StorageView } from './types.ts'

/** How long after the sidebar mounts its idle turn reads Home (the row is visible; the shell is settling). */
export const PREFETCH_IDLE_MS = 300
/** A second intent within this window reuses the reads already in flight or just settled. */
export const PREFETCH_REPEAT_MS = 10_000
/** Projects whose local session list is warmed (the table's visible rows; `GET /api/storage` lists at most 20 per Store). */
export const PREFETCH_PROJECT_LIMIT = 8
/** Projects whose portable archive is warmed (a Store walk each: only the rows most likely to be unfolded). */
export const PREFETCH_ARCHIVE_LIMIT = 2

/** Every prefetch send is decoration: it yields a slot to an interactive read and may share an answer. */
const BACKGROUND: HostCallOptions = { priority: 'background', share: true }

let inFlight: Promise<void> | null = null
let lastAt = 0

/**
 * Warm Home's critical reads if the host is connected and nothing has been
 * warmed in the last {@link PREFETCH_REPEAT_MS}. Concurrent calls share one run.
 * @param api - the page's host seam.
 * @returns the run in flight, or a resolved promise when it is too soon.
 */
export function prefetchHome(api: LayerfsApi): Promise<void> {
  if (inFlight) return inFlight
  if (Date.now() - lastAt < PREFETCH_REPEAT_MS) return Promise.resolve()
  // The remote namespace may not be mounted yet; a send would hold an admission
  // slot while it waits (the shell is booting), so let the connection event ask again.
  if (typeof api.connected === 'function' && !api.connected()) return Promise.resolve()
  lastAt = Date.now()
  inFlight = run(api).finally(() => { inFlight = null })
  return inFlight
}

/** Forget the run's dedupe state (tests only; a page never needs it). */
export function resetHomePrefetch(): void {
  inFlight = null
  lastAt = 0
}

async function run(api: LayerfsApi): Promise<void> {
  // The paint hint's age is the age of its read, not of its answer: a slow
  // prefetch must not override a fresher answer the panel's own mount landed.
  const started = Date.now()
  const storage = api.call<StorageView>('GET', '/api/storage', undefined, BACKGROUND).then((view) => {
    keepPrefetched('GET /api/storage', view, started)
    return view
  }, () => null)
  // Home reads `GET /api/projects`; the sidebar and the project picker read `projects.catalog`.
  const catalog = api.call<ProjectSummary[]>('GET', '/api/projects', undefined, BACKGROUND).then((rows) => {
    keepPrefetched('GET /api/projects', rows, started)
  }, () => {})
  const picker = api.op<{ rows: ProjectRow[], scratchKey: string | null }>('projects.catalog', undefined, BACKGROUND).then((answer) => {
    keepPrefetched('projects.catalog', answer, started)
  }, () => {})
  const view = await storage
  const keys = view ? visibleProjectKeys(view) : []
  const local = keys.slice(0, PREFETCH_PROJECT_LIMIT).map((key) => readLocal(api, key))
  const archive = keys.slice(0, PREFETCH_ARCHIVE_LIMIT).map((key) => readArchive(api, key))
  await Promise.allSettled([catalog, picker, ...local, ...archive])
}

/** `store/project` for each project the Store view lists, in the table's Store order. */
function visibleProjectKeys(view: StorageView): string[] {
  const keys: string[] = []
  for (const store of view.stores) for (const project of store.projects) keys.push(`${store.name}/${project}`)
  return [...new Set(keys)]
}

/** The table's local row data; its own read joins this send when the panel mounts first. */
function readLocal(api: LayerfsApi, key: string): Promise<void> {
  return api.op<{ sessions?: ProjectSession[] }>('sessions.list', { project: key, localOnly: true }, BACKGROUND).then((answer) => {
    if (Array.isArray(answer?.sessions)) keepSessionList(key, answer.sessions)
  }, () => {})
}

/**
 * The read an unfolded row makes. Its arguments match `useProjectSessions`
 * (`projectId: undefined` included) so an unfold in the share window joins it.
 */
function readArchive(api: LayerfsApi, key: string): Promise<void> {
  return api.op('sessions.list', { project: key, projectId: undefined, localOnly: false }, BACKGROUND).then(() => {}, () => {})
}
