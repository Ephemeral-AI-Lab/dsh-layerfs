/**
 * docker's socket setting (docs/specs/layerfs-setup.md §4.3): the one place
 * that chooses which Docker Engine the docker machine uses. Automatic leaves
 * it to LayerFS (DOCKER_HOST, the current Docker context, else
 * /var/run/docker.sock; the first start records it) and names the socket in
 * use; otherwise one of the sockets LayerFS found (`machine.platforms`
 * `candidates`). Pure, plus a one-shot request other views use to open the
 * setting on docker's page ("Docker isn't answering" → choose another
 * socket).
 */
import type { MachinesKey } from './locale.ts'
import type { MachinePlatformInfo, Words } from './model.ts'

/** One choice of the setting. `value` is what machine.update takes: a path, or '' for Automatic. */
export interface SocketChoice {
  value: string
  path: string | null
  source: string | null
  /** A non-unix endpoint, shown in place of a path. */
  host?: string | undefined
  /** A `unix://` socket LayerFS can use; another endpoint is listed, not chosen. */
  usable: boolean
}

export interface SocketSetting {
  /** The socket LayerFS uses now and where it came from (null: the CLI did not say). */
  inUse: { path: string | null, source: string | null, state: string | null } | null
  /** Whether the machine has a socket recorded (its first start records the one it used). */
  recorded: boolean
  /** The chosen value now: the recorded path, or '' (Automatic). */
  current: string
  /** Every socket LayerFS found; a recorded one it did not list comes first. */
  choices: SocketChoice[]
}

/**
 * The setting for docker's platform row `p` and its machine's recorded
 * socket (`machine.list` `docker`). Null when the CLI sends no `candidates`:
 * the dialog then keeps its plain path field.
 */
export function socketSetting(p: Pick<MachinePlatformInfo, 'socket' | 'candidates'> | undefined, recordedSocket: string | null | undefined): SocketSetting | null {
  if (!p?.candidates) return null
  const recorded = recordedSocket || (p.socket?.source === 'recorded' ? p.socket.path : null) || null
  const choices: SocketChoice[] = p.candidates.map((c) => ({ value: c.path ?? '', path: c.path, source: c.source, host: c.host, usable: c.usable !== false && !!c.path }))
  if (recorded && !choices.some((c) => c.path === recorded)) choices.unshift({ value: recorded, path: recorded, source: 'recorded', usable: true })
  return {
    inUse: p.socket ? { path: p.socket.path, source: p.socket.source, state: p.socket.state } : null,
    recorded: !!recorded,
    current: recorded ?? '',
    choices,
  }
}

const SOURCE: Record<string, MachinesKey> = {
  'env:DOCKER_HOST': 'socketFromEnv',
  desktop: 'socketFromDesktop',
  colima: 'socketFromColima',
  orbstack: 'socketFromOrbstack',
  default: 'socketFromDefault',
  recorded: 'socketFromRecorded',
}

/** Where a socket was found, in words: Docker context desktop-linux, Docker Desktop, DOCKER_HOST… */
export function socketSourceWords(source: string | null | undefined): Words | null {
  if (!source) return null
  if (SOURCE[source]) return { key: SOURCE[source] }
  if (source.startsWith('context:')) return { key: 'socketFromContext', values: { name: source.slice(8) } }
  return { key: 'raw', values: { text: source } }
}

// ---------------------------------------------------------------- open the setting from elsewhere

let requested = false
const listeners = new Set<() => void>()

/**
 * Ask docker's page to open its socket setting. The caller then opens the
 * page (`go({ kind: 'machine', name: 'docker' })`, or `openStorage(api,
 * 'machine:docker')` outside the Machines pages); a page already open opens
 * it at once.
 */
export function requestSocketSetting(): void {
  requested = true
  for (const l of listeners) l()
}

/** Takes a pending request (docker's page calls it on mount and on each request). */
export function takeSocketRequest(): boolean {
  const was = requested
  requested = false
  return was
}

export function onSocketRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
