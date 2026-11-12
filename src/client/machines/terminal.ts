/**
 * The Sandbox page's terminals, without React: Workspace order, the 2×2 page
 * layout, shell-style history, the transcript rows a pane draws, and a small
 * store that keeps each pane's draft line, history cursor and cleared mark
 * across paging and maximize (docs/specs/sandbox-terminals.md).
 */
import type { SandboxCommand, WorkspaceInfo } from './model.ts'

/** Terminals on one page, tiled 2×2. */
export const PER_PAGE = 4

const collator = new Intl.Collator(undefined, { numeric: true })

/**
 * Workspaces in creation order: by mount path, numerically, since LayerFS
 * mounts each at `…/workspaces/<namespace>` and never reuses a namespace
 * (`workspaces/2` before `workspaces/10`). The same on every reload and client.
 */
export function orderWorkspaces(workspaces: readonly WorkspaceInfo[]): WorkspaceInfo[] {
  return [...workspaces].sort((a, b) => collator.compare(a.path, b.path) || collator.compare(a.ws, b.ws))
}

/** The short form of a mount path a pane shows: its last two parts (`workspaces/3`). */
export function mountLabel(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || path
}

export type Slot = string | 'new' | 'blank'
export interface PageLayout {
  pages: number
  page: number
  /** one: a single tile fills the area; two: side by side; quad: 2×2. */
  grid: 'one' | 'two' | 'quad'
  slots: Slot[]
}

/**
 * Which tiles a page shows. One Workspace fills the area and two sit side by
 * side; three or more use the 2×2 grid, whose first free tile offers a new
 * Workspace (`new`, while one can be added) and whose others stay empty.
 * More than four page by four. `max` (a maximized Workspace) shows alone.
 */
export function pageLayout(ids: readonly string[], page: number, max: string | null, canAdd: boolean): PageLayout {
  const pages = Math.max(1, Math.ceil(ids.length / PER_PAGE))
  const at = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1)
  if (max && ids.includes(max)) return { pages, page: at, grid: 'one', slots: [max] }
  if (!ids.length) return { pages, page: at, grid: 'one', slots: [canAdd ? 'new' : 'blank'] }
  const shown = ids.slice(at * PER_PAGE, at * PER_PAGE + PER_PAGE)
  if (pages === 1 && shown.length === 1) return { pages, page: at, grid: 'one', slots: shown }
  if (pages === 1 && shown.length === 2) return { pages, page: at, grid: 'two', slots: shown }
  const slots: Slot[] = [...shown]
  if (slots.length < PER_PAGE && canAdd) slots.push('new')
  while (slots.length < PER_PAGE) slots.push('blank')
  return { pages, page: at, grid: 'quad', slots }
}

/** The page that shows Workspace `id` (0 when it is not there). */
export function pageOf(ids: readonly string[], id: string): number {
  const i = ids.indexOf(id)
  return i < 0 ? 0 : Math.floor(i / PER_PAGE)
}

/**
 * Shell-style history: ↑ (`dir` -1) steps to older lines, ↓ (+1) back toward
 * the line being typed. `commands` are newest first; repeats in a row count
 * once. `cursor` -1 is the draft, which comes back on the way down.
 */
export function historyStep(commands: readonly string[], cursor: number, dir: -1 | 1, draft: string): { cursor: number, text: string } {
  const list: string[] = []
  for (const c of commands) if (c !== list.at(-1)) list.push(c)
  const next = Math.min(Math.max(cursor + (dir === -1 ? 1 : -1), -1), list.length - 1)
  return { cursor: next, text: next < 0 ? draft : list[next]! }
}

/** One command as a pane draws it. */
export interface Row {
  id: string
  command: string
  state: SandboxCommand['state']
  stdout: string
  stderr: string
  /** Bytes of a stream beyond the kept tail (0 when all of it is here). */
  stdoutOmitted: number
  stderrOmitted: number
  stdoutBinary: boolean
  stderrBinary: boolean
  stdoutBytes: number
  stderrBytes: number
  exitCode: number | null
  /** Run time in ms; from the start to now while it runs. */
  ms: number | null
  error: string | null
}

const omitted = (text: string, total: number): number => Math.max(0, total - new TextEncoder().encode(text).length)

/** The rows of a pane, oldest first, without those from before a clear (Ctrl+L). */
export function transcript(entries: readonly SandboxCommand[], clearedAt: number, now: number = Date.now()): Row[] {
  return entries
    .filter((e) => e.startedAt > clearedAt)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((e) => ({
      id: e.id,
      command: e.command,
      state: e.state,
      stdout: e.stdoutBinary ? '' : e.stdout,
      stderr: e.stderrBinary ? '' : e.stderr,
      stdoutOmitted: e.stdoutBinary ? 0 : omitted(e.stdout, e.stdoutBytes),
      stderrOmitted: e.stderrBinary ? 0 : omitted(e.stderr, e.stderrBytes),
      stdoutBinary: !!e.stdoutBinary,
      stderrBinary: !!e.stderrBinary,
      stdoutBytes: e.stdoutBytes,
      stderrBytes: e.stderrBytes,
      exitCode: e.exitCode,
      ms: e.finishedAt ? e.finishedAt - e.startedAt : e.state === 'running' ? now - e.startedAt : null,
      error: e.error?.message ?? null,
    }))
}

/** A run time as a terminal shows it: `40ms`, `18s`, `1m 12s`. */
export function duration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

// ---------- pane state that outlives a pane ----------

export interface PaneState { draft: string, cursor: number, clearedAt: number }
const EMPTY: PaneState = { draft: '', cursor: -1, clearedAt: 0 }
const panes = new Map<string, PaneState>()
const listeners = new Set<() => void>()

/** Each Workspace's draft line, history cursor and cleared mark, kept while the page lives. */
export const paneStore = {
  get: (ws: string): PaneState => panes.get(ws) ?? EMPTY,
  patch(ws: string, change: Partial<PaneState>): void {
    panes.set(ws, { ...(panes.get(ws) ?? EMPTY), ...change })
    for (const l of listeners) l()
  },
  forget(ws: string): void {
    if (panes.delete(ws)) for (const l of listeners) l()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}
