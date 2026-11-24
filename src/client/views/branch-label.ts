/**
 * The session line's branch chip in words: the host says which branch kind the
 * binding is (`branchKind`, plus `restore`); an older host's answer, or a
 * restored archive, falls back to the shared derivation.
 */
import { describeBranch, type BranchKind } from '../../shared/session-branch.ts'
import type { Translate } from './locale.ts'

/** What the chip reads off `session.state`'s binding. */
export interface BranchChipBinding {
  readonly sessionId?: string
  readonly branch?: string
  readonly branchKind?: BranchKind
  readonly restore?: number
}

/** The chip's words for `binding`, or `''` when the session has no branch. */
export function branchLabel(sessionId: string, binding: BranchChipBinding | null | undefined, t: Translate): string {
  const branch = binding?.branch
  if (!branch) return ''
  // A subagent's state carries its root's binding: the branch belongs to that session.
  const derived = describeBranch(binding?.sessionId ?? sessionId, branch)
  const kind = binding?.branchKind ?? derived.kind
  if (kind === 'own') return t('liveBranchOwn')
  if (kind === 'restore') return t('liveBranchRestore', { n: binding?.restore ?? derived.restore ?? 0 })
  if (kind === 'resume') return t('liveBranchResume')
  return t('liveBranch', { branch })
}
