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
  sourceBranch?: string | null
  sourceTime?: number | null
  savedKind?: 'commit' | 'layer' | string
  changes?: { path: string, kind: string }[]
  /** Saved-tree measurements (storage reads only): exact wire integers. */
  logical?: unknown
  newCanonical?: unknown
  newStored?: unknown
  newMetadata?: unknown
  timeStatus?: 'recorded' | 'unavailable'
}

/** GET /api/projects/<key>/history: the Branches. */
export interface HistoryBranch { name: string, head: string | null, base: string, forkedFrom: string | null }
/** GET /api/projects/<key>/history?branch=: one page of Commits, newest first. */
export interface HistoryPage { items: CommitInfo[], next: string | null, head: string | null }
/** GET /api/projects/<key>/history?branch=&commit=: one Commit and the paths it changed. */
export interface CommitDetail { item: CommitInfo, changes: { path: string, kind: string }[] | null, nextChanges: string | null }

/** A saved Commit or Layer as the file queries name it; `branch` is where it was saved (unknown stays null). */
export interface SavedRef { id: string, kind?: 'Commit' | 'Layer' | string, branch?: string | null }
/** The saved version that last wrote a line (`file.blame`, `file.diff` with attribution). */
export interface LineOwner { ref: SavedRef, message?: string | null }
/** How much of a query LayerFS could answer exactly. */
export interface QueryCoverage { status?: 'complete' | 'partial' | 'unavailable' | string, comparison?: string, reasons?: string[] }

/** One row of `file.diff` (GET /api/projects/<key>/file-query?kind=compare|attribution). */
export interface DiffRow {
  op: ' ' | '+' | '-'
  text: string
  left_line?: number
  right_line?: number
  before_owner?: LineOwner | null
  after_owner?: LineOwner | null
  owner_changed?: boolean | null
}
/** The `file.diff` answer the views read. */
export interface FileDiffResult {
  rows?: DiffRow[]
  has_more?: boolean
  change_kind?: string
  omission_reason?: string | null
  content_coverage?: { status?: string, reasons?: string[] }
  attribution_coverage?: QueryCoverage
  changes?: { content?: boolean, metadata?: boolean, identity?: boolean, attribution?: boolean | null }
  before?: { size?: number } | null
  after?: { size?: number } | null
}

/** `file.blame` (file-query kind=blame): one window of lines from `from_line`. */
export interface BlameResult {
  at?: SavedRef
  lines: { n: number, text: string, owner: LineOwner | null, clipped?: boolean, line_truncated?: boolean }[]
  coverage?: QueryCoverage
  comparison_coarse?: boolean
  next_line?: number | null
}

/** One saved change to a path (`file.revision`). */
export interface FileRevision {
  ref: SavedRef
  /** The version it changed from; null for the version that added the path. */
  compared_to: SavedRef | null
  kind: 'Added' | 'Modified' | 'Removed' | string
  message?: string | null
  recorded_at?: number | null
  before?: { size?: number } | null
  after?: { size?: number } | null
  changes?: { content?: boolean, metadata?: boolean, identity?: boolean, attribution?: boolean | null }
}
/** `file.revision` (file-query kind=revisions): one page, newest first. */
export interface RevisionPage {
  items: FileRevision[]
  has_more?: boolean
  continuation?: string | null
  end_of_query?: boolean
  scan?: { complete?: boolean, candidates_examined?: number, reasons?: string[] }
}

/** One path that differs between two saved versions (`branch.diff`). */
export interface BranchDiffItem {
  path: string
  kind: 'Added' | 'Modified' | 'Removed' | string
  type: 'file' | 'dir' | 'symlink' | string
  content?: boolean
  metadata?: boolean
  /** Some unchanged text has a different owner. */
  attribution?: boolean | null
  changed_owner_lines?: number | null
}
/** `branch.diff` (file-query kind=branch-diff): one page of changed paths. */
export interface BranchDiffPage {
  from?: SavedRef
  to?: SavedRef
  items: BranchDiffItem[]
  has_more?: boolean
  continuation?: string | null
  coverage?: { complete?: boolean, reason?: string | null }
}
