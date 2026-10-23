// The Host's /layerfs route, from the page that dsh web or Desktop serves
// (same origin, its session cookie).
import { createHistoryCache } from './historyCache.ts'

/** `empty`: started with nothing in it; `source` was a temporary empty folder. */
export interface Project { name: string, source: string, volume: string, created: number, empty?: boolean }
/**
 * inspect.snapshot through the Host's mirror (labelled state, labels by real
 * id), with what the session journals add: who made each node, when each
 * Layer was published (by real id) and when each Branch was forked (by name).
 */
export interface ProjectState { s: any, labels: Record<string, string>, authors: Record<string, string>, times: Record<string, number>, forks: Record<string, number>, /** History alone (readProject): the full state with its Workspaces follows */ historyOnly?: boolean, /** a History read's version (?since=) */ version?: string }
export interface SessionView {
  session: string
  root: string
  folder: string | null
  choice: { project: string | null, locked: boolean } | null
  project: Project | null
  choices: { projects: Project[], lastUsed: string | null }
  lines: any[]
  running: any[]
  agents: Record<string, string>
}
/** `empty`: this Host makes new empty projects (an older one would import the folder instead). */
export interface Status { configured: boolean, missing: string[], empty?: boolean }
/** A project's Store as LayerFS reports it, with what Init recorded and each recent Commit's cost (Host storage.js). */
export interface Storage {
  store: { logical: number, canonical: number, stored: number, metadata: number, file: number, free: number, dedupe: number | null, compression: number | null }
  init: { entries: number, files: number, bytes: number, canonical: number, stored: number, metadata: number, millis: number } | null
  commits: { id: string, time: number, message: string | null, via: string, logical: number, newCanonical: number, newStored: number, newMetadata: number }[]
  branches: number
  partial: boolean
}
/** ok, degraded (worth a look) or down; a part's level is its worst part's (Host runtime.js). */
export type Level = 'ok' | 'degraded' | 'down'
/** One mounted Workspace of a project Sandbox: who mounted it and what it holds now. */
export interface RuntimeWorkspace {
  path: string, branch: string | null, activity: string | null, uncommitted: number, stale: boolean, pendingMerge: boolean
  agent: string | null, mountedAt: number | null, idleMs: number | null, busy: boolean
  processes: { id: string, command: string, status: string }[], level: Level
}
/** A project's Sandboxes for its Sandboxes tab (GET /project/<name>/runtime). */
export interface ProjectRuntime {
  project: string, level: Level
  sandboxes: ({ id: string, name: string | null, capacity: number, workspaces: RuntimeWorkspace[], level: Level } & SandboxImage)[]
  gone: ({ id: string, name: string | null } & SandboxImage)[]
  /** the daemons have not answered yet: Sandboxes from Docker and a ping, Workspaces from the agents' traces */
  pending?: boolean
}
/** The image a Sandbox runs: its exact digest (runtime.sandbox.list); one project's Sandboxes may differ. */
export interface SandboxImage { image: string | null }
/** A Sandbox's image as shown: the digest's first 12 hex digits. */
export const imageLabel = (s: SandboxImage) => (s.image ? s.image.replace(/^sha256:/, '').slice(0, 12) : null)
/** Every project's Sandboxes and the shared parts (GET /runtime). */
export interface Overview {
  level: Level
  engine: { level: Level, version?: string, error?: string }
  /** the home's worker (macOS, Windows), which makes every Store call; null on Linux (runtime.status().worker) */
  store: { level: Level, state: 'running' | 'stopped' | 'missing' | 'unknown', name: string, build?: string, expected?: string, startedAt?: string, answering?: boolean } | null
  /** macOS: the older dsh Store container while it exists (runtime.status().oldStore); while it runs the worker does not start */
  oldStore: { name: string, id: string, state: string, message: string } | null
  /** agents' LayerFS calls running now, in any project: a worker restart cuts them off */
  calls: number
  /** free bytes on the host (the LayerFS home's disk) and in Docker's volumes (runtime.status().disk); null: not read */
  disk: { host: number | null, docker: number | null, dockerLevel: Level | null }
  /** the runtime's sweep of stopped Sandboxes when it opened (runtime.status().sweep); null when off */
  sweep: { state: 'running' } | { state: 'done', at: string, reclaimed: Record<string, string[]>, failed: { project: string, code: string, message: string }[] } | { state: 'failed', at: string, code: string, message: string } | null
  /** every warning, worst first; none when all is well */
  reasons: { level: Level, text: string }[]
  /** projects with a running Sandbox or a problem; removable: nothing of it is left but its entry (no record, no Store volume) */
  projects: { name: string, sandboxes: ({ id: string, name: string | null, used: number, capacity: number, level: Level, scratch: number | null, starting?: boolean } & SandboxImage)[], workspaces: number, level: Level, note: string | null, removable: boolean }[]
  /** the other projects, with their Store volume's size (null: not known) */
  idle: { name: string, volume: number | null }[]
  /** stopped Sandbox containers, or ones of no project of this home */
  leftovers: { name: string, project: string, running: boolean, status: string }[]
  /** this home's Store volumes no project uses, and volumes no LayerFS home claims; null when Docker's volumes were not read */
  volumes: { orphans: { name: string, size: number | null, project: string | null, containers: number, removable: boolean }[], unknown: { count: number, size: number } } | null
  totals: { projects: number, sandboxes: number, workspaces: number }
}
export interface Counts { entries: number, files: number, bytes: number }
/** A running or ended Init on the Host (jobs.js). */
export interface InitJob {
  id: string
  name: string
  source: string
  started: number
  /** when it ended (done or failed), null while it runs */
  ended: number | null
  /** its own time limit in ms, null for LayerFS's default */
  timeout: number | null
  step: 'scan' | 'volume' | 'import' | 'done' | 'failed'
  scanned: Counts | null
  totals: Counts | null
  /** LayerFS's own counts while it imports (the runtime's Init job). */
  imported: { step: 'scan' | 'files' | 'tree' | 'publish' | 'seal', entries: number, files: number, bytes: number } | null
  project: Project | null
  error: { code: string, message: string } | null
}
const POLL_MS = 300
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Starts an Init and reads its job until it ends; `onProgress` sees each read.
 * `empty`: a new empty project with a random name. `timeout`: its time limit
 * in ms, sent only when set (LayerFS's default otherwise). A failed Init
 * throws its error with the ended job as `job`.
 */
async function init(folder: string | null, name?: string, source?: string, onProgress: (job: InitJob) => void = () => {}, empty = false, timeout?: number): Promise<{ project: Project }> {
  let { job } = await call<{ job: InitJob }>('POST', '/init', { folder: folder ?? undefined, name, source, ...(empty ? { empty } : {}), ...(timeout !== undefined ? { timeout } : {}) })
  for (;;) {
    onProgress(job)
    if (job.step === 'done') return { project: job.project! }
    if (job.step === 'failed') throw Object.assign(new Error(job.error!.message), { code: job.error!.code, job })
    await pause(POLL_MS)
    job = (await call<{ job: InitJob }>('GET', `/init/${encodeURIComponent(job.id)}`)).job
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/layerfs${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(data?.message ?? `LayerFS answered ${res.status}`), { code: data?.code, status: res.status })
  return data as T
}

const sid = (id: string) => encodeURIComponent(id)

/**
 * Reads a project progressively: its History from the Store first (quick; no
 * Sandbox asked), then the whole state with its Workspaces, which replaces it.
 * `fail` runs only when neither read answers. Returns a stop function.
 */
export function readProject(name: string, show: (state: ProjectState) => void, fail: (message: string) => void): () => void {
  let stopped = false, full = false
  const history = api.projectHistory(name).then((s) => { if (!stopped && !full) show({ ...s, historyOnly: true }) })
  api.projectState(name).then(
    (s) => { full = true; if (!stopped) show(s) },
    (e: Error) => { history.catch(() => { if (!stopped) fail(e.message) }) },
  )
  history.catch(() => {})
  return () => { stopped = true }
}
/** Projects' History, kept while the page is open and checked with ?since= (historyCache.ts). */
const histories = createHistoryCache<ProjectState>((name, since) =>
  call('GET', `/project/${encodeURIComponent(name)}/history${since ? `?since=${encodeURIComponent(since)}` : ''}`))

const filesQuery = (query: Record<string, string | number>) => new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()

export const api = {
  status: () => call<Status>('GET', '/status'),
  workspace: (folder: string) => call<{ projects: Project[], lastUsed: string | null }>('GET', `/workspace?folder=${encodeURIComponent(folder)}`),
  session: (id: string) => call<SessionView>('GET', `/session/${sid(id)}`),
  /** The session's project and folder, without its calls: what the header names. */
  binding: (id: string) => call<Pick<SessionView, 'session' | 'root' | 'folder' | 'choice' | 'project'>>('GET', `/session/${sid(id)}/binding`),
  choose: (id: string, project: string | null) => call<SessionView>('POST', `/session/${sid(id)}/project`, { project }),
  init,
  projects: () => call<{ projects: Project[], defaults: Record<string, string> }>('GET', '/projects'),
  setDefault: (folder: string, project: string) => call<{ projects: Project[], lastUsed: string | null }>('POST', '/workspace', { folder, project }),
  projectState: (name: string) => call<ProjectState>('GET', `/project/${encodeURIComponent(name)}/state`),
  /** The project's History alone, from its Store, without waiting on its Sandboxes; the kept one while unchanged. */
  projectHistory: (name: string) => histories.read(name),
  /** The project's History as last read on this page, if any: drawn at once, then checked with projectHistory. */
  keptHistory: (name: string) => histories.kept(name),
  projectStorage: (name: string) => call<Storage>('GET', `/project/${encodeURIComponent(name)}/storage`),
  /** One Files read of saved ids (the Host's reads.js): list, read, changes or diff. */
  projectFiles: (name: string, kind: string, query: Record<string, string | number>) => call<any>('GET', `/project/${encodeURIComponent(name)}/${kind}?${filesQuery(query)}`),
  /** stopSandboxes: stop the project's running Sandboxes instead of refusing (a demo's own project) */
  remove: (name: string, stopSandboxes = false) => {
    histories.forget(name)
    return call<{ removed: string, volume: string | null }>('POST', `/project/${encodeURIComponent(name)}/remove`, { confirm: name, stopSandboxes })
  },
  files: (id: string, kind: string, query: Record<string, string | number>) => call<any>('GET', `/session/${sid(id)}/${kind}?${filesQuery(query)}`),
  overview: () => call<Overview>('GET', '/runtime'),
  /** Starts the home's worker when it is stopped or missing. */
  startStore: () => call<Overview['store']>('POST', '/runtime/store'),
  /** runtime.worker.restart({ confirm: 'restart' }): restarts the worker; with the older Store container running, stops and removes it, then starts the worker. */
  restartStore: () => call<Overview['store']>('POST', '/runtime/store/restart', { confirm: 'restart' }),
  cleanLeftovers: (names: string[]) => call<{ results: { name: string, ok: boolean, message?: string }[] }>('POST', '/runtime/leftovers', { names }),
  removeVolumes: (names: string[]) => call<{ results: { name: string, ok: boolean, message?: string }[] }>('POST', '/runtime/volumes', { names }),
  projectRuntime: (name: string) => call<ProjectRuntime>('GET', `/project/${encodeURIComponent(name)}/runtime`),
  /** unmount (nothing uncommitted), discard (confirm: the path) or stop a process */
  runtimeAction: (name: string, body: { action: 'unmount' | 'discard' | 'stop', sandbox?: string, path?: string, process?: string, confirm?: string }) =>
    call<unknown>('POST', `/project/${encodeURIComponent(name)}/runtime`, body),
}
