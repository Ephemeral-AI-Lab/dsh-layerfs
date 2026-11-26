/**
 * The browser's one seam to the dsh-layerfs host: `call(method, path, body)`
 * keeps LayerFS Connect's host API shape (served by the `http` operation),
 * `op(name, args)` runs a named operation, and `onEvent` observes host events
 * from the `layerfs/events` stream. Pages receive one `LayerfsApi` through
 * their slot `inject`; nothing here is a module-level singleton.
 */

/** A refused call: LayerFS's code, its message, detail and `fix` line, and the HTTP-like status. */
export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly detail: any = null,
    readonly conversion = false,
    readonly transport?: string,
    /** LayerFS's one runnable line that clears the refusal, when it gave one. */
    readonly fix?: string,
  ) {
    super(message)
    this.name = 'HostError'
  }
}

/** One host event. */
export interface HostEvent {
  readonly type: string
  readonly data?: any
}

/**
 * A `sessions.open` the client is waiting on: DSH resolves the conversation
 * (log, preset, agent) before it can select it, so the conversation area has
 * nothing to show meanwhile. The views derive one honest opening state from
 * this, never a made-up progress value.
 */
export interface OpeningSession {
  readonly sessionId: string
  readonly project?: string
  readonly startedAt: number
}

/** What every page receives. */
export interface LayerfsApi {
  /**
   * Connect's host API: resolves the 2xx body, throws {@link HostError} otherwise.
   * `options.share` coalesces an identical GET already in flight; `options.priority`
   * queues it as decoration after the first screen's reads.
   */
  call<T = any>(method: string, path: string, body?: unknown, options?: HostCallOptions): Promise<T>
  /** A named host operation (e.g. `runtime.status`, `session.state`). */
  op<T = any>(name: string, args?: unknown, options?: HostCallOptions): Promise<T>
  /** Observe host events; `type` `*` receives all. Returns an unsubscribe. */
  onEvent(type: string, listener: (event: HostEvent) => void): () => void
  /** Whether the host event stream is connected. */
  connected(): boolean
  /** Select a DSH panel (sidebar main page) by id. */
  openPanel(id: string): void
  /** Open (or start) a session in a DSH workspace. */
  openWorkspace(workspaceId: string): Promise<void>
  /** Show a DSH session. */
  openSession(sessionId: string): void
  /** The workspace the client would open a new session in (current, then recent). */
  selectedWorkspaceId(): string | undefined
  /** Currently displayed conversation, including project-owned sessions. */
  selectedSessionId(): string | undefined
  /** Public DSH directory dialog; null when cancelled. */
  pickDirectory(): Promise<string | null>
  /** Open a project-owned session using the selected local workspace as scratch. */
  /** `machine`: where a PostgreSQL project's Sandbox runs (the person's pick; else the host's default, placement.ts). */
  openProjectSession(project: string, workspaceId?: string, projectId?: string, machine?: string): Promise<{ sessionId: string, workspaceId: string }>
  /** The conversation a `sessions.open` is resolving now, if any. */
  openingSession(): OpeningSession | undefined
  /** Observe pending opens (start and settle). Returns an unsubscribe. */
  onOpening(listener: (opening: OpeningSession | undefined) => void): () => void
}

/** Navigation the host may ask for in an operation result (`navigate`). */
export interface Navigator {
  createSession(workspaceId: string): Promise<string>
  currentSessionId?(): string | undefined
  openPanel(id: string): void
  openWorkspace(workspaceId: string): Promise<void>
  openSession(sessionId: string): void
  /**
   * Whether DSH's client catalog already lists this session. `openSession` on an
   * id the catalog does not have throws `sessions.retain: unknown session <id>`:
   * the host can open a session that its own list has not announced yet (a closed
   * project session, a just-imported one), so navigation waits for the catalog.
   */
  knowsSession?(sessionId: string): boolean
  /**
   * Seed DSH's client catalog with the host's own summary of the opened session.
   * The host emits `api-session/added`, but an event can be lost (a list read that
   * timed out, a dropped stream); the same summary travels in the open's answer so
   * the row can open even then.
   */
  admitSession?(summary: unknown): void
  /** Read DSH's session catalog again (used once when the opened id is missing). */
  refreshSessions?(): Promise<void> | void
}

/** Encode one path segment. */
export const enc = encodeURIComponent

/** A query string from defined params. */
export function q(params: Record<string, string | number | boolean | undefined | null>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
  const s = new URLSearchParams(entries).toString()
  return s ? `?${s}` : ''
}

type RemoteResult = { ok: true, value: any } | { ok: false, error: { code: string, message: string, details?: any } }

/**
 * How long a GET waits for its answer before it fails (and its page can offer
 * Retry). Longer than the host's own read budget (2 minutes) plus a queue, so it
 * only fires when an answer is lost, never on a slow but live read.
 */
export const GET_TIMEOUT_MS = 180_000
/** How long a GET whose connection dropped waits for the host to come back before it is sent again. */
export const RECONNECT_WAIT_MS = 30_000

/** Which queued host operation goes first: what the first screen reads, or what only decorates it. */
export type HostPriority = 'interactive' | 'background'

/** Per-call admission choices. */
export interface HostCallOptions {
  /**
   * `interactive` (the default) is what the person is waiting for: the open
   * view's reads and every write. `background` is prefetch and decoration
   * (the doctor count, metrics, exports, sandbox-create history, per-row
   * sizes): it runs only while no interactive op waits, and a waiting
   * background op takes a turn after {@link BACKGROUND_TURN_EVERY} admitted
   * interactive ops, so it cannot starve. A doctor run is a write even when
   * the count starts one by itself after the first frame; only the count read
   * is decoration.
   */
  priority?: HostPriority
  /**
   * Read-only calls only. An identical call already in flight answers this one
   * too; so does one that settled within {@link SHARE_MAX_AGE_MS} (a mount's
   * surfaces are staggered, so an in-flight-only join misses the second one).
   * The recent answer is dropped by the events that change what it describes,
   * and a fresh call bypasses both. Nothing is kept longer than that age.
   */
  share?: boolean | ShareOptions
  /**
   * A forced refresh (the Refresh button, a recheck): never join an in-flight
   * read or reuse a recent answer. The same `?fresh=1` path also has its own
   * share key, so the host reads again either way.
   */
  fresh?: boolean
}

/** How a share may reuse an answer. */
export interface ShareOptions {
  /** How long a settled answer may answer another call; defaults to {@link SHARE_MAX_AGE_MS}. */
  maxAgeMs?: number
}

/**
 * How long one shared read's answer may serve a later identical call. A mount's
 * duplicates are staggered, not overlapping: the Machines board read the view
 * at 425 ms and again at 258 ms, and the entry surfaces read the catalog at
 * 208/87/94 ms. One second also covers the one-frame + one-idle first-paint
 * gate (B3), and is short enough that a 15 s poll, a person's Refresh, or any
 * read after the event stream has moved on reaches the host. This is a client
 * answer age, never a host TTL: nothing outlives the visit's own duplicate
 * burst, and the data-changing events clear it.
 */
export const SHARE_MAX_AGE_MS = 1_000

/**
 * At most this many host operations in flight from one page. The host nearly
 * serialises (32 concurrent calls made per-op p50 88–110 ms and bought only
 * 1.38–1.60x throughput), so more in flight only lengthens the queue. On a
 * page-side 21-request mixed Home set (3194 rig, 7 batches):
 * unbounded per-op p50 89 ms / p95 301 ms and wall p50 127 / p95 355; cap4
 * 23 / 46 and wall 120 / 248; cap6 30 / 50 and wall 112 / 135. Cap 6 keeps the
 * per-op p95 about 3x under the 150 ms budget and takes the mount's wall tail
 * from 248 to 135 ms; cap 4's 7 ms p50 edge is not worth that wall tail. One
 * constant, so the live A/B can change one number.
 */
export const HOST_IN_FLIGHT_LIMIT = 6

/** A waiting background op goes first after this many consecutive interactive admissions. */
export const BACKGROUND_TURN_EVERY = 4

interface Waiting {
  readonly task: () => Promise<unknown>
  readonly priority: HostPriority
  readonly resolve: (value: any) => void
  readonly reject: (error: unknown) => void
}

/**
 * A small FIFO admission scheduler with two priorities. `active` never exceeds
 * `limit`; a task releases its slot when it settles, rejected or not. There is
 * no re-entrancy: an admitted task is one host send (see `send`), and a send
 * never waits on another send, so a queued op cannot hold a slot for an op
 * behind it.
 */
export class HostAdmission {
  private active = 0
  /** Consecutive interactive admissions, for the background turn. */
  private streak = 0
  private readonly queues: Record<HostPriority, Waiting[]> = { interactive: [], background: [] }
  constructor(readonly limit = HOST_IN_FLIGHT_LIMIT) {}

  /** Operations admitted and not settled. */
  get inFlight(): number { return this.active }
  /** Operations waiting for a slot. */
  get waiting(): number { return this.queues.interactive.length + this.queues.background.length }

  run<T>(priority: HostPriority, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queues[priority].push({ task, priority, resolve, reject })
      this.pump()
    })
  }

  private next(): Waiting | undefined {
    const { interactive, background } = this.queues
    if (background.length && (interactive.length === 0 || this.streak >= BACKGROUND_TURN_EVERY)) return background.shift()
    return interactive.shift() ?? background.shift()
  }

  private pump(): void {
    while (this.active < this.limit) {
      const next = this.next()
      if (!next) return
      this.active++
      this.streak = next.priority === 'interactive' ? this.streak + 1 : 0
      // The admission is decided here; the send starts on the next microtask so a
      // synchronous burst queues in call order instead of re-entering this loop.
      void Promise.resolve().then(next.task).then(next.resolve, next.reject).finally(() => {
        this.active--
        this.pump()
      })
    }
  }
}

/** A stable JSON key: calls share only when their name and arguments agree. */
function callKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(callKey).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${callKey(v)}`).join(',')}}`
}

/** A call whose answer cannot arrive: its connection dropped, or it outlived its budget. */
class LostCall extends Error {
  constructor(readonly why: 'dropped' | 'timeout') {
    super(why === 'dropped' ? 'The connection to the dsh-layerfs host dropped before it answered' : 'The dsh-layerfs host did not answer in time')
  }
}

/** The share age a call asks for: the default, or its own bounded age. */
function shareMaxAge(share: true | ShareOptions): number {
  const asked = typeof share === 'object' ? share.maxAgeMs : undefined
  return typeof asked === 'number' && asked >= 0 ? asked : SHARE_MAX_AGE_MS
}

/**
 * Build the API over the `remote.layerfs` namespace. The namespace is resolved
 * per call (it remounts when the connection resets), so the API and the pages
 * holding it outlive remounts.
 * @param remote - the mounted namespace, or undefined while it is (re)mounting.
 * @param nav - DSH navigation (panels, workspaces, sessions).
 * @param workspace - the `uiWorkspace` service, or undefined while it mounts.
 */
export function createApi(remote: () => any, nav: Navigator, workspace: () => any): LayerfsApi & { dispose(): void } {
  const listeners = new Map<string, Set<(e: HostEvent) => void>>()
  /** Admission: at most {@link HOST_IN_FLIGHT_LIMIT} sends, interactive before background. */
  const admission = new HostAdmission()
  /** Identical reads already in flight; a joiner gets that answer and takes no slot of its own. */
  const sharedSends = new Map<string, Promise<any>>()
  /** Settled shared answers, by when they settled: one burst's staggered surfaces reuse them, no longer. */
  const recentSends = new Map<string, { value: any, at: number }>()
  const shared = <T>(key: string, start: () => Promise<T>, maxAgeMs: number): Promise<T> => {
    const held = sharedSends.get(key)
    if (held) return held as Promise<T>
    const kept = recentSends.get(key)
    if (kept && Date.now() - kept.at <= maxAgeMs) return Promise.resolve(kept.value as T)
    const promise = start()
    sharedSends.set(key, promise)
    const forget = () => { if (sharedSends.get(key) === promise) sharedSends.delete(key) }
    // An event that invalidated this key while it was in flight deleted the
    // flight: its answer still lands for the callers already waiting, but it is
    // not kept to answer a later one.
    promise.then((value) => { if (sharedSends.get(key) === promise) recentSends.set(key, { value, at: Date.now() }); forget() }, forget)
    return promise
  }
  /** Forget the shared answers a host event makes wrong: late joiners read again, in-flight answers still land. */
  const invalidateShared = (matches: (key: string) => boolean): void => {
    for (const key of recentSends.keys()) if (matches(key)) recentSends.delete(key)
    for (const key of sharedSends.keys()) if (matches(key)) sharedSends.delete(key)
  }
  /** Calls waiting on an answer: each fails when the event stream drops (its connection is gone). */
  const inFlight = new Set<(e: LostCall) => void>()
  /** Pending `sessions.open` calls, oldest first; listeners hear the newest one. */
  const openings: OpeningSession[] = []
  const openingListeners = new Set<(opening: OpeningSession | undefined) => void>()
  const announceOpening = () => {
    const top = openings.at(-1)
    for (const listener of openingListeners) {
      try { listener(top) } catch (error) { console.error('[dsh-layerfs] opening listener failed', error) }
    }
  }
  const beginOpening = (sessionId: string, project: string | undefined): (() => void) => {
    const entry: OpeningSession = { sessionId, ...(project ? { project } : {}), startedAt: Date.now() }
    openings.push(entry)
    announceOpening()
    let done = false
    return () => {
      if (done) return
      done = true
      const at = openings.indexOf(entry)
      if (at >= 0) openings.splice(at, 1)
      announceOpening()
    }
  }
  let live = false
  let disposed = false
  let handle: any

  /**
   * The events that make a shared answer wrong. They are the events the reading
   * surfaces already reread on: a machine or store moved, a project was saved or
   * removed, the setup check changed, or the connection came back (every answer
   * may have been produced on the lost one).
   */
  const SHARE_INVALIDATION: Readonly<Record<string, (key: string) => boolean>> = {
    connection: () => true,
    storage: (key) => key.startsWith('GET /api/storage') || key.startsWith('GET /api/machines') || key.startsWith('op projects.catalog'),
    'storage-changed': (key) => key.startsWith('GET /api/storage') || key.startsWith('GET /api/machines') || key.startsWith('op projects.catalog'),
    'machine-progress': (key) => key.startsWith('GET /api/machines') || key.startsWith('GET /api/storage'),
    'layerfs-availability': (key) => key.startsWith('GET /api/machines') || key.startsWith('GET /api/storage'),
    'runtime-changed': (key) => key.startsWith('GET /api/machines') || key.startsWith('op setup.status'),
    projects: (key) => key.startsWith('op projects.catalog') || key.startsWith('GET /api/projects'),
    'projects-changed': (key) => key.startsWith('op projects.catalog') || key.startsWith('GET /api/projects'),
    'layerfs-workspaces-changed': (key) => key.startsWith('op projects.catalog'),
    'setup-changed': (key) => key.startsWith('op setup.status'),
  }
  const dispatch = (event: HostEvent) => {
    const matches = SHARE_INVALIDATION[event.type]
    if (matches) invalidateShared(matches)
    for (const key of [event.type, '*']) for (const l of listeners.get(key) ?? []) {
      try { l(event) } catch (error) { console.error('[dsh-layerfs] event listener failed', error) }
    }
  }
  const subscribe = (type: string, listener: (event: HostEvent) => void): (() => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(listener)
    return () => { listeners.get(type)?.delete(listener) }
  }

  const fail = (r: Extract<RemoteResult, { ok: false }>): never => {
    const d = r.error.details ?? {}
    throw new HostError(d.code ?? r.error.code, r.error.message, 500, d.detail ?? null, false, undefined, typeof d.fix === 'string' && d.fix ? d.fix : undefined)
  }

  const namespace = async (): Promise<any> => {
    for (let waited = 0; ; waited += 100) {
      const ns = remote()
      if (ns) return ns
      if (disposed || waited > 15000) throw new HostError('no-host', 'The dsh-layerfs host is not connected', 0)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  /**
   * One remote call that fails with {@link LostCall} when the connection drops
   * under it or `timeout` passes. It takes an admission slot for the host round
   * trip only: the timeout starts when the send starts, never while it queues.
   */
  async function send(name: string, args: unknown, timeout?: number, options: HostCallOptions = {}): Promise<RemoteResult> {
    return admission.run(options.priority ?? 'interactive', async () => {
      const ns = await namespace()
      let drop: ((e: LostCall) => void) | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const lost = new Promise<never>((_resolve, reject) => {
        drop = reject
        inFlight.add(reject)
        if (timeout) timer = setTimeout(() => reject(new LostCall('timeout')), timeout)
      })
      try {
        return await Promise.race([ns.call({ op: name, args: args ?? {} }) as Promise<RemoteResult>, lost])
      } finally {
        inFlight.delete(drop!)
        if (timer) clearTimeout(timer)
      }
    })
  }

  /** Resolves once the event stream is connected again, or after `ms`. */
  const reconnected = (ms: number) => new Promise<void>((resolve) => {
    if (live || disposed) return resolve()
    const done = () => { clearTimeout(timer); off(); resolve() }
    const timer = setTimeout(done, ms)
    const off = subscribe('connection', (e) => { if (e.data?.connected) done() })
  })

  /**
   * Open a session once DSH's client catalog lists it. The host's ordinary
   * announcement (`api-session/added`) can be lost while its list read is slow
   * or failed; then the open used to be retried once with the refusal swallowed,
   * which left the pane on New Session. Instead wait, read the catalog again
   * once, and if the id still is not there answer with a refusal the row shows.
   */
  async function reveal(sessionId: string, summary?: unknown): Promise<void> {
    const known = () => nav.knowsSession ? nav.knowsSession(sessionId) : true
    // The host's own summary is authoritative: seed the catalog with it first.
    if (summary !== undefined) { try { nav.admitSession?.(summary) } catch { /* the event still may */ } }
    // A closed session's resume can announce it a moment after the op answers.
    for (let i = 0; i < 20 && !known(); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    if (!known() && nav.refreshSessions) {
      // The catalog read itself may have timed out at page load; ask once more.
      try { await Promise.race([nav.refreshSessions(), new Promise((resolve) => setTimeout(resolve, 1500))]) } catch { /* the wait below decides */ }
      for (let i = 0; i < 20 && !known(); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (known()) { nav.openSession(sessionId); return }
    throw new HostError('session/not-listed', 'This conversation is not in this window\'s session list yet — Retry', 0)
  }

  async function op<T>(name: string, args?: unknown, timeout?: number, options: HostCallOptions = {}): Promise<T> {
    const r: RemoteResult = await send(name, args, timeout, options)
    if (!r.ok) fail(r)
    const value = (r as { value: any }).value
    // A host answer may ask the client to navigate (e.g. open the new session).
    // Wait briefly for DSH's catalog to list it: opening an id the catalog has not
    // announced yet is refused by the client (`sessions.retain: unknown session`),
    // which surfaced at the row that asked for the open.
    const go = value && typeof value === 'object' ? value.navigate : undefined
    if (go?.sessionId) await reveal(String(go.sessionId), value?.session)
    else if (go?.workspaceId) await nav.openWorkspace(String(go.workspaceId))
    return value as T
  }

  async function call<T>(method: string, path: string, body?: unknown, options: HostCallOptions = {}): Promise<T> {
    const run = async (): Promise<T> => {
      let reply: { status: number, body: any }
      const get = method.toUpperCase() === 'GET'
      const args = { method, path, ...(body === undefined ? {} : { body }) }
      try {
        try {
          reply = await op('http', args, get ? GET_TIMEOUT_MS : undefined)
        } catch (error) {
          // A read whose connection dropped (the host restarted) is sent once more when it is back.
          // A write never is: it may already have happened.
          if (!(get && error instanceof LostCall && error.why === 'dropped')) throw error
          await reconnected(RECONNECT_WAIT_MS)
          reply = await op('http', args, get ? GET_TIMEOUT_MS : undefined)
        }
      } catch (error) {
        if (error instanceof HostError) throw error
        if (error instanceof LostCall && error.why === 'timeout') throw new HostError('timeout', error.message, 0, null, false, 'transport-unknown')
        // The request was sent and its reply lost: a write may or may not have happened.
        throw new HostError('no-host', error instanceof Error ? error.message : String(error), 0, null, false, 'transport-unknown')
      }
      const value = reply?.body ?? {}
      if (!reply || reply.status < 200 || reply.status >= 300) {
        throw new HostError(value.code ?? 'failed', value.message ?? `${method} ${path}: ${reply?.status}`, reply?.status ?? 0, value.detail ?? null, value.conversion === true, value.transport, typeof value.fix === 'string' && value.fix ? value.fix : undefined)
      }
      return value as T
    }
    // An identical GET already in flight (or just answered) answers both callers;
    // a forced refresh reads the host. A write drops every recent answer: the
    // event may not have reached the page yet.
    if (!options.share || method.toUpperCase() !== 'GET' || options.fresh) {
      const answer = run()
      // A write's outcome may be unknown (it failed after an effect): drop the
      // recent answers either way, and let the event stream confirm.
      if (method.toUpperCase() !== 'GET') answer.then(() => recentSends.clear(), () => recentSends.clear())
      return answer
    }
    return shared(`GET ${path} ${callKey(body)}`, run, shareMaxAge(options.share))
  }

  // One logical event stream, reopened after a drop until disposal.
  const connect = async () => {
    let delay = 500
    while (!disposed) {
      try {
        handle = (await namespace()).events()
        for await (const item of handle) {
          if (disposed) break
          const event = (item && typeof item === 'object' && 'value' in item && !('type' in item)) ? item.value : item
          if (event?.type === 'ready') { live = true; delay = 500; dispatch({ type: 'connection', data: { connected: true } }); continue }
          if (event?.type) dispatch(event)
        }
      } catch { /* reconnect below */ }
      if (live) { live = false; dispatch({ type: 'connection', data: { connected: false } }) }
      // Answers to calls sent on the dropped connection cannot arrive: fail them now rather than leave pages waiting.
      for (const fail of [...inFlight]) fail(new LostCall('dropped'))
      if (disposed) break
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 8000)
    }
  }
  void connect()

  // The workspace a new session opens in: the one holding the current session,
  // else the first listed (ui-workspace's "recent" order follows).
  const selectedWorkspaceId = (): string | undefined => {
    const ws = workspace()
    const snap = ws?.workspaces?.list?.getSnapshot?.()
    const items = snap?.items ?? []
    const current = nav.currentSessionId?.()
    return items.find((item: any) => item.sessionIds?.includes?.(current))?.workspaceId ?? items[0]?.workspaceId
  }

  return {
    call,
    // A named operation's lost answer reads like any lost send: no host, outcome unknown.
    // `sessions.open` is also tracked while it runs: its caller gets the promise,
    // and any view can say the conversation is opening (the smallest honest state).
    op: <T>(name: string, args?: unknown, options?: HostCallOptions) => {
      const request = name === 'sessions.open' ? (args as { sessionId?: unknown, project?: unknown } | undefined) : undefined
      const settle = typeof request?.sessionId === 'string' && request.sessionId
        ? beginOpening(request.sessionId, typeof request.project === 'string' && request.project ? request.project : undefined)
        : undefined
      const run = () => op<T>(name, args, undefined, options).catch((error: unknown) => {
        if (error instanceof LostCall) throw new HostError('no-host', error.message, 0, null, false, 'transport-unknown')
        throw error
      }).finally(() => { settle?.() })
      return options?.share && !options.fresh ? shared(`op ${name} ${callKey(args)}`, run, shareMaxAge(options.share)) : run()
    },
    openPanel: (id) => nav.openPanel(id),
    openWorkspace: (id) => nav.openWorkspace(id),
    openSession: (id) => nav.openSession(id),
    selectedWorkspaceId,
    pickDirectory: async () => {
      const picker = workspace()
      if (!picker?.pickDirectory) throw new HostError('no-picker', 'The local folder picker is unavailable', 0)
      return picker.pickDirectory()
    },
    selectedSessionId: () => nav.currentSessionId?.(),
    async openProjectSession(project: string, workspaceId?: string, projectId?: string, machine?: string) {
      // Refuse before anything is made: identity, project, machine and Store are
      // checked read-only, so a refusal leaves no blank session behind.
      await op('sessions.checkPlacement', { project, projectId, ...(machine ? { machine } : {}) })
      const target = workspaceId ?? selectedWorkspaceId()
        ?? (await op<{ workspaceId: string }>('sessions.prepareScratch', { navigate: false })).workspaceId
      if (!target) throw new HostError('no-workspace', 'Select a local folder to use as scratch for the project session', 0)
      // A workspace blank may already belong to another project. Request a fresh identity before binding it.
      const sessionId = await nav.createSession(target)
      try {
        await op('sessions.choose', { sessionId, project, projectId, ...(machine ? { machine } : {}) })
      } catch (error) {
        // A choice that refuses after the session exists (a race, or a check only
        // the write path makes) must not leave the blank session as an orphan:
        // hide it, drop any pending placement it recorded, and show the refusal.
        await op('sessions.archive', { sessionId }).catch((cleanup: unknown) => {
          console.warn('[dsh-layerfs] could not archive the unplaced session', cleanup)
        })
        await op('sessions.forget', { sessionId }).catch((cleanup: unknown) => {
          console.warn('[dsh-layerfs] could not forget the unplaced session', cleanup)
        })
        throw error
      }
      nav.openSession(sessionId)
      return { sessionId, workspaceId: target }
    },
    connected: () => live,
    onEvent: subscribe,
    openingSession: () => openings.at(-1),
    onOpening(listener) {
      openingListeners.add(listener)
      return () => { openingListeners.delete(listener) }
    },
    dispose() {
      disposed = true
      openingListeners.clear()
      openings.length = 0
      try { handle?.dispose?.() } catch { /* already closed */ }
    },
  }
}
