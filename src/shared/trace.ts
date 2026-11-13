/**
 * LayerFS call types shared by the trajectory (`src/shared/trajectory.ts`,
 * docs/specs/layerfs-trajectory.md): one receipt as a `TraceOp` with the
 * versions it named, and a checkpoint.
 */

/** What a call did to a saved version (the receipt's `VersionLink.effect`). */
export type TraceEffect = 'created' | 'unchanged' | 'referenced'

/** One saved version a LayerFS call named, with the Branch to open it on. */
export interface TraceVersion {
  kind: 'Commit' | 'Layer'
  id: string
  effect: TraceEffect
  /** The Branch holding it (`main` for a Layer); absent when it cannot be told. */
  branch?: string
}

/** One LayerFS call (a receipt). */
export interface TraceOp {
  /** Receipt id. */
  id: string
  origin: 'tool' | 'host'
  /** `family.call`. */
  operation: string
  /** Redacted CLI words, when the receipt has them. */
  argv?: string[]
  outcome: 'success' | 'refusal' | 'unknown'
  /** Refusal code or `Failed`/`Unknown`. */
  code?: string
  /** Result kind (`Committed`, `UpToDate`, `Merged`, `exit:0` …). */
  kind?: string
  at?: number
  ms?: number
  /** `workspace exec`: the command's exit code. */
  exit?: number | null
  versions: TraceVersion[]
}

/** A save of the session's files that closes or marks a turn. */
export interface TraceCheckpoint {
  kind: 'base' | 'turn' | 'manual' | 'restore' | 'idle'
  commit: string | null
  branch: string | null
  /** Overlay entries saved (0: unchanged). */
  changed: number
  message: string
  at: number
  error?: { code: string, message: string }
  /** The host call that saved or referenced it, when traced. */
  op?: TraceOp
}
