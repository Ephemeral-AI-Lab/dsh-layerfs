/**
 * The session line's branch chip in words: the host says which branch kind the
 * binding is (`branchKind`, plus `restore`; `branchFields` in
 * src/shared/session-branch.ts).
 */
import type { BranchKind } from '../../shared/session-branch.ts'
import type { Translate } from './locale.ts'

/** What the chip reads off `session.state`'s binding. */
export interface BranchChipBinding {
  readonly branch?: string
  readonly branchKind: BranchKind
  readonly restore?: number
}

/** The chip's words for `binding`, or `''` when the session has no branch. */
export function branchLabel(binding: BranchChipBinding | null | undefined, t: Translate): string {
  const branch = binding?.branch
  if (!binding || !branch) return ''
  if (binding.branchKind === 'own') return t('liveBranchOwn')
  if (binding.branchKind === 'restore') return t('liveBranchRestore', { n: binding.restore ?? 0 })
  if (binding.branchKind === 'resume') return t('liveBranchResume')
  return t('liveBranch', { branch })
}
