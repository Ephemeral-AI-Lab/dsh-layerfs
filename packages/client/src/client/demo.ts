// The demo workspace: one Session per scenario of the dsh-layerfs-demo
// bundle, read from the Host's /layerfs-demo route (absent without the
// bundle). Play gives a demo a fresh run in a new Session that takes the old
// one's place: the old Session is archived (its work stopped), the demo's
// project is Inited again from the workspace folder (on LayerFS, or on the
// simulator for Sim), and the new Session gets the preset, the scenario's
// mock model, the project and the first message. A replayed run's demo
// (`live`) plays on LayerFS only, Inits from its own seed folder and gives its
// Sandboxes its own image.
import { api, type InitJob } from './api.ts'

export type DemoMode = 'live' | 'sim'
/** A run's progress, from the mock model's replies (mock/src/progress.js). */
export interface DemoRun { root: string, state: 'running' | 'done' | 'stopped', done: number, of: number, phase: string | null, error: string | null, started: number, ended: number | null, journal?: boolean }
/**
 * A checkpoint of the demo's scenario (#352): reachedAt is when the latest run
 * reached it, restored whether that run started after it; resumable whether a
 * run can start after it.
 */
export interface DemoCheckpoint { label: string, verdict: 'pass' | 'watch' | 'optimize' | 'stop', note: string | null, resumable: boolean, reachedAt: number | null, restored: boolean }
export interface Demo { id: string, title: string, blurb: string | null, agents: string[], speed: number, live: boolean, image: string | null, seed: string | null, seedError?: string, sessionId: string | null, run: DemoRun | null, checkpoints?: DemoCheckpoint[] }
export interface DemoInfo { workspace: string, preset: string, provider: string, prompt: string, intro: string, demos: Demo[] }

/** What Play and the Session check use of dsh's Client services (read with ctx.get). */
export interface DemoServices {
  remote?: {
    session: {
      create(request: { workspaceId?: string, agentPreset?: string }): Promise<Result<{ sessionId: string }>>
      rename(request: { sessionId: string, title: string }): Promise<Result<unknown>>
      selectModel(request: { sessionId: string, provider: string, model: string }): Promise<Result<unknown>>
      prompt(request: { requestId: string, sessionId: string, mode: 'queue', content: { type: 'text', text: string }[] }): Promise<Result<unknown>>
    }
    workspace: {
      create(request: { path: string }): Promise<Result<{ workspace: Workspace }>>
      archiveSession(request: { sessionId: string, stopActivity?: boolean }): Promise<Result<unknown>>
      unarchiveSession(request: { sessionId: string }): Promise<Result<unknown>>
      insertSessionBefore(request: { workspaceId: string, sessionId: string, beforeSessionId?: string }): Promise<Result<unknown>>
    }
  }
  uiWorkspace?: { openSession(sessionId: string): void }
  /** dsh's Workspace list, for its archived Sessions */
  workspaces?: { list: { getSnapshot(): WorkspaceList, subscribe(listener: () => void): () => void } }
  /** dsh's Session status, for whether a run's root Session still runs */
  uiSession?: { sessionStatus: { getSnapshot(): ReadonlyMap<string, { running?: boolean }>, subscribe(listener: () => void): () => void } }
}
interface WorkspaceList { phase?: 'pending' | 'ready', archivedSessionIds?: readonly string[] }

/** The archived Sessions, once dsh's Workspace list has arrived (none after 5 s without it). */
function archived(services: DemoServices): Promise<Set<string>> {
  const list = services.workspaces?.list
  if (!list) return Promise.resolve(new Set())
  return new Promise((resolve) => {
    let stop = () => {}
    const done = () => { stop(); clearTimeout(timer); resolve(new Set(list.getSnapshot().archivedSessionIds ?? [])) }
    const timer = setTimeout(done, 5000)
    if (list.getSnapshot().phase !== 'pending') return done()
    stop = list.subscribe(() => { if (list.getSnapshot().phase !== 'pending') done() })
  })
}
interface Workspace { workspaceId: string, path: string, sessionIds?: readonly string[] }
type Result<T> = { ok: true, value: T } | { ok: false, error: { code?: string, message?: string } }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/layerfs-demo${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(data?.message ?? `the demo route answered ${res.status}`), { code: data?.code, status: res.status })
  return data as T
}

export const demoApi = {
  /** null when the dsh-layerfs-demo bundle is not installed */
  info: () => call<DemoInfo>('GET', '').catch((error) => { if (error.status === 404) return null; throw error }),
  demo: (id: string) => call<Demo>('GET', `/${encodeURIComponent(id)}`),
  setSession: (id: string, sessionId: string) => call<Demo>('POST', `/${encodeURIComponent(id)}/session`, { sessionId }),
  /** how fast the mock plays the demo from now on (mock/src/pace.js) */
  setSpeed: (id: string, speed: Speed) => call<Demo>('POST', `/${encodeURIComponent(id)}/speed`, { speed }),
}

/** A demo's run speeds: a multiple of the scenario's pauses and typing, or 0 for none (Max). */
export const SPEEDS = [1, 2, 4, 0] as const
export type Speed = typeof SPEEDS[number]
export const speedLabel = (speed: number) => (speed ? `${speed}×` : 'Max')

/** Inits `name` from `source` for `folder` (Live, with `image` when given) or into the simulator (Sim) and reads its job until it ends, as api.init. */
async function initProject(folder: string, source: string, name: string, mode: DemoMode, image: string | null, onJob: (job: InitJob) => void): Promise<void> {
  const request = async (method: string, path: string, body?: unknown): Promise<{ job: InitJob }> => {
    const res = await fetch(`/layerfs${path}`, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw Object.assign(new Error(data?.message ?? `the LayerFS route answered ${res.status}`), { code: data?.code, status: res.status })
    return data
  }
  let { job } = await request('POST', '/init', { folder, name, source, ...(mode === 'sim' ? { backend: 'sim' } : image ? { image } : {}) })
  for (;;) {
    onJob(job)
    if (job.step === 'done') return
    if (job.step === 'failed') throw Object.assign(new Error(job.error!.message), { code: job.error!.code })
    await new Promise((resolve) => setTimeout(resolve, 300))
    job = (await request('GET', `/init/${encodeURIComponent(job.id)}`)).job
  }
}

/** The demo's project for a mode: one per demo and mode, Inited again on each Play. */
export const projectOf = (id: string, mode: DemoMode) => (mode === 'sim' ? `demo-${id}-sim` : `demo-${id}`)

const value = <T,>(what: string, result: Result<T>): T => {
  if (result.ok) return result.value
  throw Object.assign(new Error(`${what}: ${result.error.message ?? result.error.code ?? 'refused'}`), { code: result.error.code })
}

/** The demo workspace's dsh Workspace with its current Sessions; registering answers the existing one. */
async function workspaceOf(services: DemoServices, info: DemoInfo): Promise<Workspace> {
  return value('register the demo workspace', await services.remote!.workspace.create({ path: info.workspace })).workspace
}

/** A new Session in the demo workspace for `demo`, named after it, at `before`'s place. */
async function newSession(services: DemoServices, info: DemoInfo, workspace: Workspace, demo: Demo, before?: string): Promise<string> {
  const { session, workspace: workspaces } = services.remote!
  const { sessionId } = value('create the Session', await session.create({ workspaceId: workspace.workspaceId, agentPreset: info.preset }))
  value('name the Session', await session.rename({ sessionId, title: demo.title }))
  value('choose the mock model', await session.selectModel({ sessionId, provider: info.provider, model: demo.id }))
  if (before) value('place the Session', await workspaces.insertSessionBefore({ workspaceId: workspace.workspaceId, sessionId, beforeSessionId: before }))
  return sessionId
}

const send = async (services: DemoServices, sessionId: string, text: string) =>
  value('send the first message', await services.remote!.session.prompt({ requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] }))

/**
 * Gives every demo a Session in the demo workspace: one is made for each demo
 * whose recorded Session is not in the workspace (never made, archived or
 * removed). Made in reverse so the list reads in scenario order. Each opens
 * with the intro question, which the mock model answers with what the demo
 * shows: the sidebar lists no Session before its first turn.
 * @returns the demo workspace's dsh Workspace id, or null without the Remote services
 */
export async function ensureDemoSessions(services: DemoServices, info: DemoInfo): Promise<string | null> {
  if (!services.remote) return null
  const workspace = await workspaceOf(services, info), gone = await archived(services)
  const present = new Set((workspace.sessionIds ?? []).filter((id) => !gone.has(id)))
  for (const demo of [...info.demos].reverse()) {
    if (demo.sessionId && present.has(demo.sessionId)) continue
    const sessionId = await newSession(services, info, workspace, demo)
    await demoApi.setSession(demo.id, sessionId)
    await send(services, sessionId, info.intro)
  }
  return workspace.workspaceId
}

/** The step Play is on, for the strip. */
export type PlayStep = { step: 'session' } | { step: 'stop' } | { step: 'init', job: InitJob | null } | { step: 'start' }

/**
 * Plays `demo` from scratch in a new Session (dsh cannot empty one), which
 * becomes the demo's only once the run starts. In order: the new Session is
 * made at the current one's place (the sidebar lists it only from its first
 * message); the current one is archived with its work stopped; the demo's
 * projects are removed (their leftover Sandboxes stopped) and its project for
 * the mode Inited again; then the new Session is recorded, sent the first
 * message and opened. Each step is attempted once. On a failure before the
 * run starts, the current Session is unarchived and stays the demo's, the new
 * one is archived, and Play ends with the failure's message. With
 * `startAfter`, a checkpoint's label (#352), the run starts after it.
 * @returns the new Session's id
 */
export async function playDemo(services: DemoServices, info: DemoInfo, demo: Demo, mode: DemoMode, onStep: (step: PlayStep) => void, startAfter: string | null = null): Promise<string> {
  if (!services.remote) throw new Error('this client has no Remote session services')
  if (demo.live) mode = 'live'
  if (demo.seedError) throw new Error(`the demo's seed: ${demo.seedError}`)
  const { workspace: workspaces } = services.remote
  const workspace = await workspaceOf(services, info)
  onStep({ step: 'session' })
  const previous = demo.sessionId ?? undefined
  const sessionId = await newSession(services, info, workspace, demo, previous)
  let archived = false
  try {
    onStep({ step: 'stop' })
    if (previous) { value('stop the previous run', await workspaces.archiveSession({ sessionId: previous, stopActivity: true })); archived = true }
    // a stopped run leaves the Sandboxes it kept open: the demo's own projects go with theirs
    for (const name of [projectOf(demo.id, 'live'), projectOf(demo.id, 'sim')]) {
      await api.remove(name, true).catch((error) => { if (error.status !== 404) throw error })
    }
    onStep({ step: 'init', job: null })
    const project = projectOf(demo.id, mode)
    await initProject(info.workspace, demo.seed ?? info.workspace, project, mode, demo.image, (job) => onStep({ step: 'init', job }))
    await api.choose(sessionId, project)
    await demoApi.setSession(demo.id, sessionId)
  } catch (error) {
    // the demo stays on its current Session; the unused new one goes
    if (archived) await workspaces.unarchiveSession({ sessionId: previous! }).catch(() => {})
    await workspaces.archiveSession({ sessionId }).catch(() => {})
    throw error
  }
  onStep({ step: 'start' })
  // a run that starts after a checkpoint says so in its first message (mock/src/plan.js)
  await send(services, sessionId, startAfter ? `${info.prompt.replace(/\.$/, '')} from after ${startAfter}.` : info.prompt)
  services.uiWorkspace?.openSession(sessionId)
  return sessionId
}
