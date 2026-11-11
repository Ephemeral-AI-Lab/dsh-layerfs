/**
 * The browser's one seam to the dsh-layerfs host: `call(method, path, body)`
 * keeps LayerFS Connect's host API shape (served by the `http` operation),
 * `op(name, args)` runs a named operation, and `onEvent` observes host events
 * from the `layerfs/events` stream. Pages receive one `LayerfsApi` through
 * their slot `inject`; nothing here is a module-level singleton.
 */

/** A refused call: LayerFS's code, its message and detail, and the HTTP-like status. */
export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly detail: any = null,
    readonly conversion = false,
    readonly transport?: string,
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

/** What every page receives. */
export interface LayerfsApi {
  /** Connect's host API: resolves the 2xx body, throws {@link HostError} otherwise. */
  call<T = any>(method: string, path: string, body?: unknown): Promise<T>
  /** A named host operation (e.g. `runtime.status`, `session.state`). */
  op<T = any>(name: string, args?: unknown): Promise<T>
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
}

/** Navigation the host may ask for in an operation result (`navigate`). */
export interface Navigator {
  openPanel(id: string): void
  openWorkspace(workspaceId: string): Promise<void>
  openSession(sessionId: string): void
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
 * Build the API over the `remote.layerfs` namespace. The namespace is resolved
 * per call (it remounts when the connection resets), so the API and the pages
 * holding it outlive remounts.
 * @param remote - the mounted namespace, or undefined while it is (re)mounting.
 * @param nav - DSH navigation (panels, workspaces, sessions).
 */
export function createApi(remote: () => any, nav: Navigator): LayerfsApi & { dispose(): void } {
  const listeners = new Map<string, Set<(e: HostEvent) => void>>()
  let live = false
  let disposed = false
  let handle: any

  const dispatch = (event: HostEvent) => {
    for (const key of [event.type, '*']) for (const l of listeners.get(key) ?? []) {
      try { l(event) } catch (error) { console.error('[dsh-layerfs] event listener failed', error) }
    }
  }

  const fail = (r: Extract<RemoteResult, { ok: false }>): never => {
    const d = r.error.details ?? {}
    throw new HostError(d.code ?? r.error.code, r.error.message, 500, d.detail ?? null)
  }

  const namespace = async (): Promise<any> => {
    for (let waited = 0; ; waited += 100) {
      const ns = remote()
      if (ns) return ns
      if (disposed || waited > 15000) throw new HostError('no-host', 'The dsh-layerfs host is not connected', 0)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  async function op<T>(name: string, args?: unknown): Promise<T> {
    const r: RemoteResult = await (await namespace()).call({ op: name, args: args ?? {} })
    if (!r.ok) fail(r)
    const value = (r as { value: any }).value
    // A host answer may ask the client to navigate (e.g. open the new session).
    const go = value && typeof value === 'object' ? value.navigate : undefined
    if (go?.sessionId) nav.openSession(String(go.sessionId))
    else if (go?.workspaceId) await nav.openWorkspace(String(go.workspaceId))
    return value as T
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let reply: { status: number, body: any }
    try {
      reply = await op('http', { method, path, ...(body === undefined ? {} : { body }) })
    } catch (error) {
      if (error instanceof HostError) throw error
      throw new HostError('no-host', error instanceof Error ? error.message : String(error), 0)
    }
    const value = reply?.body ?? {}
    if (!reply || reply.status < 200 || reply.status >= 300) {
      throw new HostError(value.code ?? 'failed', value.message ?? `${method} ${path}: ${reply?.status}`, reply?.status ?? 0, value.detail ?? null, value.conversion === true, value.transport)
    }
    return value as T
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
      if (disposed) break
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 8000)
    }
  }
  void connect()

  return {
    call, op,
    openPanel: (id) => nav.openPanel(id),
    openWorkspace: (id) => nav.openWorkspace(id),
    openSession: (id) => nav.openSession(id),
    connected: () => live,
    onEvent(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
      return () => { listeners.get(type)?.delete(listener) }
    },
    dispose() {
      disposed = true
      try { handle?.dispose?.() } catch { /* already closed */ }
    },
  }
}
