/**
 * What a session's LayerFS branch name says about the session.
 *
 * The host names a session's branch `dsh.<compact session id>`, `.r<N>` after a
 * restore and `.resume.<hex>` when a conversation imported from the saved
 * archive continues (`branchOf` and `resumeFromArchive` in
 * src/host/sessions/service.ts). Both faces derive the same words from here:
 * the host annotates `session.state` and `sessions.list` with these fields
 * (`branchFields`), and the client reads them as given.
 */

export type BranchKind = 'own' | 'restore' | 'resume' | 'other'

/** The kind of branch a session is on, and for a restore its generation. */
export interface BranchDescription {
  readonly kind: BranchKind
  readonly restore?: number
}

/** `describeBranch` under the names the host writes on a binding or a row. */
export interface BranchFields {
  readonly branchKind: BranchKind
  readonly restore?: number
}

/** The host's `compact`: no leading `session-`, no punctuation, lowercase. */
export function compactSessionId(sessionId: string): string {
  return sessionId.replace(/^session-/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()
}

const own: BranchDescription = { kind: 'own' }
const resumed: BranchDescription = { kind: 'resume' }
const other: BranchDescription = { kind: 'other' }

const isDigits = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 48 || c > 57) return false
  }
  return true
}

const isHex = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) return false
  }
  return true
}

/**
 * `dsh.<compact>` is this session's own branch; `.r<N>` is one a restore made;
 * `.resume.<hex>` (8+ characters) is one an archive import continued on.
 * Anything else, another session's included, is `other`.
 */
export function describeBranch(sessionId: string, branch: string | null | undefined): BranchDescription {
  if (!branch) return other
  const prefix = `dsh.${compactSessionId(sessionId)}`
  if (branch === prefix) return own
  if (!branch.startsWith(prefix)) return other
  const suffix = branch.slice(prefix.length)
  // `.resume.` first: it also starts with `.r`.
  if (suffix.startsWith('.resume.')) {
    const hex = suffix.slice('.resume.'.length)
    return hex.length >= 8 && isHex(hex) ? resumed : other
  }
  if (suffix.startsWith('.r')) {
    const generation = suffix.slice(2)
    if (!generation || !isDigits(generation)) return other
    const restore = Number(generation)
    return Number.isSafeInteger(restore) ? { kind: 'restore', restore } : other
  }
  return other
}

/** The host's annotation for a binding or a list row. */
export function branchFields(sessionId: string, branch: string | null | undefined): BranchFields {
  const { kind, restore } = describeBranch(sessionId, branch)
  return restore === undefined ? { branchKind: kind } : { branchKind: kind, restore }
}
