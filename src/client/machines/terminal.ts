/**
 * The Sandbox page's terminals, without React: Workspace order, the 2×2 page
 * layout, shell-style history, the transcript rows a pane draws, and a small
 * store that keeps each pane's draft line, history cursor and cleared mark
 * across paging and maximize (docs/specs/sandbox-terminals.md).
 */
import type { SandboxCommand, WorkspaceInfo } from './model.ts'

/** The smallest a terminal pane gets before fewer fit on a page, in CSS px. */
export const PANE_MIN_WIDTH = 380
export const PANE_MIN_HEIGHT = 220
/** The gap between panes, in CSS px. */
export const PANE_GAP = 8
/** At most this many columns and rows of panes, however large the page. */
export const MAX_COLUMNS = 4
export const MAX_ROWS = 3

/** A page of panes: how many columns and rows fit. */
export interface Fit { columns: number, rows: number }

/** The panes of the 2×2 page, for a caller that has not measured its area yet. */
export const DEFAULT_FIT: Fit = { columns: 2, rows: 2 }

const clamp = (n: number, low: number, high: number): number => Math.min(high, Math.max(low, n))

/**
 * How many panes fit in an area `width` × `height` px: as many columns and
 * rows as keep each pane at least PANE_MIN_WIDTH × PANE_MIN_HEIGHT, at least
 * one of each and at most MAX_COLUMNS × MAX_ROWS. There is no layout choice:
 * the page's size decides.
 */
export function paneFit(width: number, height: number): Fit {
  const per = (size: number, min: number) => (Number.isFinite(size) ? Math.floor((size + PANE_GAP) / (min + PANE_GAP)) : 1)
  return { columns: clamp(per(width, PANE_MIN_WIDTH), 1, MAX_COLUMNS), rows: clamp(per(height, PANE_MIN_HEIGHT), 1, MAX_ROWS) }
}

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
  /** The grid the page draws: columns × rows of tiles, filling the area. */
  columns: number
  rows: number
  slots: Slot[]
}

const perPage = (fit: Fit): number => Math.max(1, fit.columns) * Math.max(1, fit.rows)

/**
 * Which tiles a page shows, in a grid of at most `fit` (what the area holds,
 * paneFit). A page that holds them all draws only the columns and rows its
 * Workspaces need, so one Workspace fills the area and two sit side by side;
 * a free tile left in those rows offers a new Workspace (`new`, while one can
 * be added) and the rest stay empty. More than one page keeps the full grid
 * on every page, so panes do not change size while paging. `max` (a
 * maximized Workspace) shows alone.
 */
export function pageLayout(ids: readonly string[], page: number, max: string | null, canAdd: boolean, fit: Fit = DEFAULT_FIT): PageLayout {
  const size = perPage(fit)
  const pages = Math.max(1, Math.ceil(ids.length / size))
  const at = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1)
  const one = (slot: Slot): PageLayout => ({ pages, page: at, columns: 1, rows: 1, slots: [slot] })
  if (max && ids.includes(max)) return one(max)
  if (!ids.length) return one(canAdd ? 'new' : 'blank')
  const shown = ids.slice(at * size, at * size + size)
  const columns = pages === 1 ? Math.min(Math.max(1, fit.columns), shown.length) : Math.max(1, fit.columns)
  const rows = pages === 1 ? Math.ceil(shown.length / columns) : Math.max(1, fit.rows)
  const slots: Slot[] = [...shown]
  if (slots.length < columns * rows && canAdd) slots.push('new')
  while (slots.length < columns * rows) slots.push('blank')
  return { pages, page: at, columns, rows, slots }
}

/** The page that shows Workspace `id` (0 when it is not there), `fit` panes a page. */
export function pageOf(ids: readonly string[], id: string, fit: Fit = DEFAULT_FIT): number {
  const i = ids.indexOf(id)
  return i < 0 ? 0 : Math.floor(i / perPage(fit))
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

/** `saved` is the line being typed while ↑/↓ shows history, restored on the way back down. */
export interface PaneState { draft: string, cursor: number, clearedAt: number, saved: string }
const EMPTY: PaneState = { draft: '', cursor: -1, clearedAt: 0, saved: '' }
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
