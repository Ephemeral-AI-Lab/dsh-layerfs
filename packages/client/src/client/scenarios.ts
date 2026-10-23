// The LayerFS scripted model's scenarios, read from the Host's /layerfs-mock
// route (absent while the plugin is off: every read answers null), and one
// run of a scenario on LayerFS. Each run gets a new Session in the Scenarios
// workspace and a fresh project, mock-<scenario>-<uuid>, Inited from
// the scenario's fixture. A run's progress is the Host's
// (mock/src/progress.js): this file starts runs and reads them.
import { api, type InitJob } from './api.ts'

/** Runs at once: each starts Sandboxes. */
export const MAX_RUNS = 2
/** The queued scenarios to start now, with `going` runs already going. */
export function nextStarts(queue: readonly string[], going: number): string[] {
  return queue.slice(0, Math.max(0, MAX_RUNS - going))
}

/** A run's progress, from the scripted model's replies. */
export interface ScenarioRun { sessionId: string, project?: string | null, state: 'running' | 'passed' | 'failed', done: number, of: number, phase: string | null, error: string | null, timedOut?: boolean, started: number, ended: number | null }
/** What the loader counts: agents, steps, and the LayerFS calls the steps' expect covers. */
export interface ScenarioCounts { agents: number, steps: number, calls: string[] }
export interface Scenario { id: string, title: string, blurb: string | null, tags: string[], counts: ScenarioCounts, agents: string[], fixture: string | null, run: ScenarioRun | null }

/** The scenarios that carry every tag in `wanted` (all of them when it is empty). */
export const withTags = (scenarios: readonly Scenario[], wanted: readonly string[]) => scenarios.filter((s) => wanted.every((t) => s.tags.includes(t)))
/** Every tag the scenarios use, forms first, then workloads and topics, each once. */
export function allTags(scenarios: readonly Scenario[]): string[] {
  const order = ['cli', 'sdk', 'node', 'rust']
  const tags = [...new Set(scenarios.flatMap((s) => s.tags))]
  return tags.sort((a, b) => (order.includes(a) ? order.indexOf(a) : 9) - (order.includes(b) ? order.indexOf(b) : 9) || a.localeCompare(b))
}
export interface MockInfo { workspace: string, preset: string, provider: string, prompt: string, scenarios: Scenario[] }
export interface SessionRun { scenario: string, run: ScenarioRun | null }

type Result<T> = { ok: true, value: T } | { ok: false, error: { code?: string, message?: string } }
interface Workspace { workspaceId: string, path: string }

/** What a run uses of dsh's Client services (read with ctx.get and the Remote scope). */
export interface RunServices {
  remote?: {
    session: {
      create(request: { workspaceId?: string, agentPreset?: string }): Promise<Result<{ sessionId: string }>>
      rename(request: { sessionId: string, title: string }): Promise<Result<unknown>>
      selectModel(request: { sessionId: string, provider: string, model: string }): Promise<Result<unknown>>
      prompt(request: { requestId: string, sessionId: string, mode: 'queue', content: { type: 'text', text: string }[] }): Promise<Result<unknown>>
      cancel(request: { sessionId: string }): Promise<Result<unknown>>
    }
    workspace: { create(request: { path: string }): Promise<Result<{ workspace: Workspace }>> }
  }
  uiWorkspace?: { openSession(sessionId: string): void }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/layerfs-mock${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(data?.message ?? `the scenarios route answered ${res.status}`), { code: data?.code, status: res.status })
  return data as T
}
const orNull = (error: any) => { if (error.status === 404) return null; throw error }

export const mockApi = {
  /** null while the scripted model's plugin is off */
  info: () => call<MockInfo>('GET', '').catch(orNull),
  /** what `sessionId` plays, or null when it plays no scenario (or the plugin is off) */
  session: (sessionId: string) => call<SessionRun>('GET', `/session/${encodeURIComponent(sessionId)}`).catch(orNull),
  setSession: (id: string, sessionId: string, project: string) => call<Scenario>('POST', `/${encodeURIComponent(id)}/session`, { sessionId, project }),
  /** marks the run stopped: its agents get no further step */
  stop: (sessionId: string) => call<{ state: string, error: string | null }>('POST', `/session/${encodeURIComponent(sessionId)}/stop`, {}),
}

/** A run's project, falling back to the older per-scenario name. */
export const projectOf = (id: string, run?: ScenarioRun | null) => run?.project ?? `mock-${id}`
export const isScenarioProject = (name: string) => /^mock-.+$/.test(name)

const value = <T,>(what: string, result: Result<T>): T => {
  if (result.ok) return result.value
  throw Object.assign(new Error(`${what}: ${result.error.message ?? result.error.code ?? 'refused'}`), { code: result.error.code })
}

/** Inits `name` from `source` for `folder` and reads its job until it ends. */
async function initProject(folder: string, source: string, name: string, onJob: (job: InitJob) => void): Promise<void> {
  const request = async (method: string, path: string, body?: unknown): Promise<{ job: InitJob }> => {
    const res = await fetch(`/layerfs${path}`, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw Object.assign(new Error(data?.message ?? `the LayerFS route answered ${res.status}`), { code: data?.code, status: res.status })
    return data
  }
  let { job } = await request('POST', '/init', { folder, name, source })
  for (;;) {
    onJob(job)
    if (job.step === 'done') return
    if (job.step === 'failed') throw Object.assign(new Error(job.error!.message), { code: job.error!.code })
    await new Promise((resolve) => setTimeout(resolve, 300))
    job = (await request('GET', `/init/${encodeURIComponent(job.id)}`)).job
  }
}

/** The step a run is starting on, for the Run bar and the Tests tab. */
export type StartStep = { step: 'session' } | { step: 'project' } | { step: 'init', job: InitJob | null } | { step: 'start' }

/**
 * Starts a run of `scenario`, attempting each step once: a new Session in the
 * Scenarios workspace on the scenario's model; a fresh project Inited from
 * its fixture, preserving previous runs' projects; the Session bound
 * to it and recorded as the run's root; then the first message. A run is
 * refused before any of it while the Host's deployment settings are missing. A failure before the first message ends the start
 * with its message; the unused Session stays, empty.
 * @returns the run's root Session id
 */
export async function startRun(services: RunServices, info: MockInfo, scenario: Scenario, onStep: (step: StartStep) => void, open = true): Promise<string> {
  if (!services.remote) throw new Error('this client has no Remote session services')
  if (!scenario.fixture) throw new Error(`${scenario.title} has no fixture to Init its project from`)
  const { session, workspace } = services.remote
  onStep({ step: 'session' })
  // a run needs the Host's deployment settings: say so before making a Session
  const status = await api.status()
  if (!status.configured) throw new Error(`LayerFS isn't set up: layerfs-host is missing ${status.missing.join(', ')}`)
  const ws = value('register the Scenarios workspace', await workspace.create({ path: info.workspace })).workspace
  const { sessionId } = value('create the Session', await session.create({ workspaceId: ws.workspaceId, agentPreset: info.preset }))
  value('name the Session', await session.rename({ sessionId, title: scenario.title }))
  value('choose the scripted model', await session.selectModel({ sessionId, provider: info.provider, model: scenario.id }))
  onStep({ step: 'project' })
  const project = `${projectOf(scenario.id)}-${crypto.randomUUID()}`
  onStep({ step: 'init', job: null })
  await initProject(info.workspace, scenario.fixture, project, (job) => onStep({ step: 'init', job }))
  await api.choose(sessionId, project)
  await mockApi.setSession(scenario.id, sessionId, project)
  onStep({ step: 'start' })
  value('send the first message', await session.prompt({ requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: info.prompt }] }))
  if (open) services.uiWorkspace?.openSession(sessionId)
  return sessionId
}

/** Stops a run: the Host marks it stopped, so none of its agents gets another step, then its root Session's turn is cancelled. */
export async function stopRun(services: RunServices, sessionId: string): Promise<void> {
  if (!services.remote) throw new Error('this client has no Remote session services')
  await mockApi.stop(sessionId)
  value('stop the run', await services.remote.session.cancel({ sessionId }))
}

/** "1:05" for a run's time in ms. */
export const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A run's one-line state: "Step 7 of 23 · Commit", "Passed · 0:41", "Failed at step 14 of 31". */
export function runText(run: ScenarioRun, now = Date.now()): string {
  const time = duration((run.ended ?? now) - run.started)
  if (run.state === 'running') return `Step ${run.done} of ${run.of}${run.phase ? ` · ${run.phase}` : ''}`
  if (run.state === 'passed') return `Passed · ${time}`
  return `Failed at step ${run.done} of ${run.of} · ${time}`
}
