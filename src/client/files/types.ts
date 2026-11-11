/**
 * The host API shapes the shared file views read (LayerFS Connect's
 * `host-api.ts`; the dsh-layerfs host serves the same bodies).
 */

/** Translate a key of the caller's locale namespace (DSH's `t`). */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** GET /api/projects/<key>/branches: one Branch. */
export interface BranchInfo {
  name: string
  /** The saved Commit or Layer id the Branch shows. */
  head: string | null
  parent: string | null
  forkedFrom: string | null
  state: 'open' | 'merged' | 'published' | string
  commits: number | null
}

/** GET /api/projects/<key>/fs: one entry of a folder. */
export interface FsEntry {
  name: string
  path: string
  kind: 'file' | 'dir' | 'symlink' | string
  size: number | null
  mode?: number | null
}

/** GET /api/projects/<key>/file: a window of a saved file. */
export interface FileWindow {
  path: string
  size: number
  binary: boolean
  text: string | null
  next_line?: number | null
  truncated?: boolean
  line_truncated?: boolean
  at?: { id: string, kind?: string }
}

/** One Commit (or main's Layer) as the history routes answer it. */
export interface CommitInfo {
  id: string
  branch: string
  message: string
  at: number | null
  parent: string | null
  merged?: string | null
  kind?: string | null
  base?: string | null
  sourceCommit?: string | null
  changes?: { path: string, kind: string }[]
}

/** GET /api/projects/<key>/history: the Branches. */
export interface HistoryBranch { name: string, head: string | null, base: string, forkedFrom: string | null }
/** GET /api/projects/<key>/history?branch=: one page of Commits, newest first. */
export interface HistoryPage { items: CommitInfo[], next: string | null, head: string | null }
/** GET /api/projects/<key>/history?branch=&commit=: one Commit and the paths it changed. */
export interface CommitDetail { item: CommitInfo, changes: { path: string, kind: string }[] | null, nextChanges: string | null }

/** One row of `file.diff` (GET /api/projects/<key>/file-query?kind=compare). */
export interface DiffRow { op: ' ' | '+' | '-', text: string, left_line?: number, right_line?: number }
/** The `file.diff` answer the views read. */
export interface FileDiffResult {
  rows?: DiffRow[]
  has_more?: boolean
  change_kind?: string
  omission_reason?: string | null
  content_coverage?: { status?: string, reasons?: string[] }
  before?: { size?: number } | null
  after?: { size?: number } | null
}
