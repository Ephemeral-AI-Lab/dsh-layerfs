/**
 * The sessions area's durable state: `<root>/sessions.json`.
 *
 *   projects[key]     a LayerFS project's scratch-folder workspace (anchor dir + DSH workspace id)
 *   sessions[id]      one DSH session's binding to its Branch, Sandbox, Workspace mount and scratch folder
 *   checkpoints[id]   the session's trajectory checkpoints, oldest first
 *   mirror[id]        how much of the session log the LayerFS session store holds
 *   pending[id]       where a not-yet-bound session's files start (a fork from a checkpoint)
 */

/** One project's scratch-folder workspace. */
export interface ProjectWorkspace {
  readonly project: string
  readonly anchor: string
  workspaceId?: string
  readonly createdAt: number
}

/** How one session is bound. */
export interface Binding {
  readonly sessionId: string
  /** `project`: a LayerFS Workspace + scratch folder; `scratch`: a scratch folder only; `shared`: a subagent using its parent's. */
  readonly kind: 'project' | 'scratch' | 'shared'
  project?: string
  branch?: string
  sandbox?: string
  ws?: string
  mount?: string
  machine?: string
  scratch: string
  /** The anchor (session `header.cwd`). */
  readonly anchor: string
  /** The parent session a `shared` binding follows. */
  parent?: string
  /** The commit (or Layer) the branch started from. */
  base?: string | null
  /** Where the files came from when the session was forked. */
  from?: { session?: string, commit?: string | null, turn?: number }
  state: 'bound' | 'closed' | 'failed'
  error?: string
  /** Branch generations made by restores. */
  restores?: number
  readonly createdAt: number
  updatedAt: number
}

/** One trajectory checkpoint. */
export interface Checkpoint {
  /** `base` the files a session started from; `turn` end of an agent turn; `manual`; `restore` files restored; `idle` saved before a Sandbox closed. */
  readonly kind: 'base' | 'turn' | 'manual' | 'restore' | 'idle'
  /** The turn the checkpoint closes (0 for base). */
  readonly turn: number
  /** Session log length when it was taken. */
  readonly seq: number
  /** The `turn/end` event's seq, once seen. */
  endSeq?: number
  /** Commit id (or base Layer id); null when nothing has been saved yet. */
  readonly commit: string | null
  /** The Branch the commit is on. */
  readonly branch: string | null
  /** Overlay entries saved (0 = unchanged turn). */
  readonly changed: number
  readonly message: string
  readonly at: number
  /** A save that did not complete (`Conflict`, `Unknown`...). */
  readonly error?: { readonly code: string, readonly message: string }
}

/** The LayerFS session store's progress for one session. */
export interface Mirror {
  readonly project: string
  readonly branch: string
  /** Events stored so far. */
  count: number
  segments: { readonly file: string, readonly from: number, readonly to: number }[]
  updatedAt: number
  error?: string
}

export interface SessionsState {
  version: 1
  projects: Record<string, ProjectWorkspace>
  sessions: Record<string, Binding>
  checkpoints: Record<string, Checkpoint[]>
  mirror: Record<string, Mirror>
  pending: Record<string, { project: string, commit: string | null, branch: string | null, session: string, turn: number }>
}

export const initialState = (): SessionsState => ({ version: 1, projects: {}, sessions: {}, checkpoints: {}, mirror: {}, pending: {} })
