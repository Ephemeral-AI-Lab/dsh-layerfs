/**
 * The sessions area's durable state: `<root>/sessions.json`.
 *
 *   projects[key]     a LayerFS project this DSH knows (its anchor dir; a DSH
 *                     workspace id only when a legacy project workspace held it)
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
  /** `project`: its own LayerFS Workspace + scratch folder (in its project or the Scratch project); `shared`: a subagent using its parent's. */
  readonly kind: 'project' | 'shared'
  project?: string
  branch?: string
  sandbox?: string
  ws?: string
  mount?: string
  machine?: string
  scratch: string
  /** Only plugin-created scratch directories may ever be removed by cleanup. */
  scratchManaged?: boolean
  /** The anchor (session `header.cwd`). */
  readonly anchor: string
  /** The parent session a `shared` binding follows. */
  parent?: string
  /** The commit (or Layer) the branch started from. */
  base?: string | null
  /** Where the files came from when the session was forked. */
  from?: { session?: string, commit?: string | null, turn?: number }
  projectId?: string
  executionState?: 'inactive' | 'activating' | 'active' | 'interrupted'
  state: 'bound' | 'closed' | 'failed'
  error?: string
  /** Branch generations made by restores. */
  restores?: number
  readonly createdAt: number
  updatedAt: number
  /** Script execution is project-owned without an automatic code workspace. */
  simulation?: SimulationBinding
  /** Local-only: fork an imported simulation pin before mounting it. */
  resumeFromArchive?: boolean
}

export interface SimulationTarget { kind: 'Commit' | 'Layer'; id: string; branch: string }
export interface SimulationBinding {
  runId: string
  agentKey: string
  scriptId: string
  name: string
  hash: string
  ordinaryModel?: { provider: string; model: string; reasoningEffort?: string }
  rootSessionId?: string
  state: 'running' | 'completed' | 'stopped' | 'interrupted' | 'failed'
  continuation?: SimulationTarget
  handoffReady?: boolean
  error?: string
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
  /** Last confirmed archive checksum; a changed checksum requires reconciliation. */
  digest?: string
  /** Events stored so far. */
  count: number
  segments: { readonly file: string, readonly from: number, readonly to: number }[]
  updatedAt: number
  error?: string
}

export interface SessionsState {
  version: 1
  /** The "LayerFS Projects" group workspace at `<root>/projects`, once ensured. */
  group?: { workspaceId: string }
  projects: Record<string, ProjectWorkspace>
  sessions: Record<string, Binding>
  checkpoints: Record<string, Checkpoint[]>
  mirror: Record<string, Mirror>
  /** Placed sessions (`sessions.choose`) carry only `project`; forked sessions
   * also record where their files start. */
  pending: Record<string, { project: string, commit?: string | null, branch?: string | null, session?: string, turn?: number, simulation?: SimulationBinding }>
}

export const initialState = (): SessionsState => ({ version: 1, projects: {}, sessions: {}, checkpoints: {}, mirror: {}, pending: {} })
