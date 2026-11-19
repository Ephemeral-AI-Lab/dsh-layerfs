/**
 * Words for what a machine or Sandbox page says when something is in the way
 * (UI pass 1 on 3080): a status word with LayerFS's own message as its tip and
 * one action. Pure helpers; the components translate the keys.
 */
import type { MachinesKey } from './locale.ts'
import { busyWordOf, opWords, sandboxGone, sandboxesOn, unreadableRecord, type AvailableView, type MachineInfo, type SandboxInfo, type SdkOperation, type StateLook } from './model.ts'

/** A name from a refusal's list entry: a string, or `{ name }` / `{ sandbox }`. */
const nameOf = (x: unknown): string | null => {
  if (typeof x === 'string') return x.trim() || null
  if (x && typeof x === 'object') {
    const o = x as { name?: unknown, sandbox?: unknown }
    const v = typeof o.name === 'string' ? o.name : typeof o.sandbox === 'string' ? o.sandbox : null
    return v?.trim() || null
  }
  return null
}

/**
 * The Sandboxes an `InUse` refusal says are in the way (a machine stop or
 * remove while Sandboxes run): its `sandboxes` next field when present, else
 * the Sandboxes it relates, else the bracketed list in its message. Null for
 * any other refusal, or one that names no Sandbox.
 */
export function inUseSandboxes(error: unknown): string[] | null {
  if (!error || typeof error !== 'object') return null
  const e = error as { code?: unknown, message?: unknown, detail?: unknown, sandboxes?: unknown }
  if (e.code !== 'InUse') return null
  const d = e.detail && typeof e.detail === 'object' ? e.detail as { sandboxes?: unknown, related?: unknown } : null
  const listed = Array.isArray(d?.sandboxes) ? d.sandboxes : Array.isArray(e.sandboxes) ? e.sandboxes : null
  let names = listed ? listed.map(nameOf).filter((x): x is string => !!x) : []
  if (!names.length && Array.isArray(d?.related)) {
    names = d.related.filter((r: unknown) => (r as { kind?: unknown })?.kind === 'sandbox').map(nameOf).filter((x): x is string => !!x)
  }
  if (!names.length && typeof e.message === 'string' && /sandbox/i.test(e.message)) {
    const list = /\[([^\]]*)\]/.exec(e.message)?.[1]
    if (list) names = list.split(',').map((x) => x.trim().replace(/^["'`]|["'`]$/g, '')).filter(Boolean)
  }
  return names.length ? [...new Set(names)] : null
}

/** "Close its N Sandboxes first", by count. */
export const closeFirstKey = (n: number): MachinesKey => (n === 1 ? 'inUseCloseOne' : 'inUseClose')

/**
 * The operation a state chip adds after its word: nothing when the word is
 * already the op's (`Stopping` for a busy `stop`) and its phase only repeats
 * it; its phase alone when the word names the op; else name · phase.
 */
export function chipOpWords(look: Pick<StateLook, 'label'> & { op?: SdkOperation | null, state?: string }): string | null {
  const op = look.op
  if (!op) return null
  const short = op.name.replace(/^[a-z_]+\./, '')
  const phase = op.phase && op.phase !== short && op.phase !== op.name ? op.phase : null
  if (look.state === 'busy' && look.label && busyWordOf(short) === look.label) return phase
  return opWords(op)
}

/**
 * What a machine's empty Sandboxes list says: unread, none, or how to see them
 * (start it, or its worker). A machine whose record LayerFS cannot read says
 * so: starting it is not offered.
 */
export function sandboxesEmptyKey(m: MachineInfo, view: Pick<AvailableView, 'readErrors'>, running: boolean): { key: MachinesKey, home: boolean } {
  const home = m.platform === 'native'
  if (view.readErrors?.sandboxes) return { key: 'sandboxesUnread', home }
  if (unreadableRecord(m)) return { key: 'sandboxesRecordUnreadable', home }
  if (running) return { key: 'noSandboxesHere', home }
  return { key: m.platform === 'docker' ? 'sandboxesAfterWorker' : 'sandboxesAfterStart', home }
}

/**
 * The PostgreSQL Stores connected from this machine (spec v23), and those
 * with a Sandbox on it now (the Stores tab lists the same).
 */
export function pgStoresHere(view: Pick<AvailableView, 'postgresql' | 'sandboxes'> & Partial<Pick<AvailableView, 'machines'>>, m: MachineInfo): string[] {
  const boxes = sandboxesOn({ sandboxes: view.sandboxes } as AvailableView, m)
  const busy = new Set(boxes.map((b) => b.project?.split('/')[0]).filter((x): x is string => !!x))
  return (view.postgresql ?? []).filter((s) => (s.connectedFrom ?? []).some((c) => c.machine === m.name) || busy.has(s.name)).map((s) => s.name).sort()
}

/** The Details line of a machine's PostgreSQL Sandboxes, counted as its Stores tab counts them. */
export function pgSupportKey(n: number): MachinesKey {
  return n === 0 ? 'pgSupportedNone' : n === 1 ? 'pgSupportedOne' : 'pgSupported'
}

/**
 * Whether a Sandbox's Workspaces tab offers New workspace: never on a Sandbox
 * whose daemon is gone (it cannot take one); off with its reason while it
 * cannot be reached or is full.
 */
export function workspaceOffer(info: Pick<SandboxInfo, 'state' | 'reason' | 'refusal' | 'unread'>, count: number, capacity: number): { show: boolean, why: MachinesKey | null } {
  if (sandboxGone(info)) return { show: false, why: null }
  const reachable = info.state === 'ready' && !info.refusal && !info.unread
  if (!reachable) return { show: true, why: 'termAddOffline' }
  if (count >= capacity) return { show: true, why: 'termFull' }
  return { show: true, why: null }
}

/** A message with each long digest cut to its first 12 hex digits (the full message stays its tip). */
export const shortDigests = (text: string): string => text.replace(/\b(sha256:)?([0-9a-f]{12})[0-9a-f]{20,}\b/g, (_all, scheme: string | undefined, head: string) => `${scheme ?? ''}${head}…`)
